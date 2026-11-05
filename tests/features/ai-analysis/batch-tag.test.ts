/**
 * features/ai-analysis/batch-tag 单测
 *
 * 重点不在"能不能调通"，而在边界：
 *   - 并发上限真的生效吗（189 部一起打出去会被限流）
 *   - 取消后已完成的会不会被丢掉（用户等了几分钟，不能白费）
 *   - 某一部失败会不会带崩整批
 *   - 模型把已有标签再建议一遍，会不会显示成"新增"
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const autoTagMock = vi.fn();

vi.mock('../../../features/ai-analysis/auto-tag', () => ({
  autoTag: (anime: { title: string }, opts: unknown) => autoTagMock(anime, opts),
}));

import {
  planBatchTagTargets,
  diffSuggested,
  buildTaggedEntry,
  runBatchTag,
  summarizeBatchTag,
  BATCH_TAG_CONCURRENCY,
} from '../../../features/ai-analysis/batch-tag';
import type { AnimeEntry } from '../../../src/types';

function anime(id: string, title: string, tagNames: string[] = [], rowIndex?: number): AnimeEntry {
  return {
    id,
    title,
    posterUrl: '',
    category: 'watched',
    tags: tagNames.map((name) => ({ name, highlighted: false })),
    scores: [{ dimensionKey: 'overall', score: 8 }],
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
    ...(rowIndex === undefined ? {} : { excelRowIndex: rowIndex }),
  } as AnimeEntry;
}

beforeEach(() => {
  autoTagMock.mockReset();
  autoTagMock.mockImplementation(async (a: { title: string }) => ({
    suggestedTags: [{ name: `tag-${a.title}`, reason: '看起来相关' }],
  }));
});

describe('planBatchTagTargets', () => {
  const list = [
    anime('1', '有标签', ['刀'], 2),
    anime('2', '没标签', [], 3),
    anime('3', '没行号', [], undefined), // 写不回 Excel
  ];

  it('跳过没有 excelRowIndex 的条目（写不回 Excel，处理了也白处理）', () => {
    expect(planBatchTagTargets(list, 'all').map((a) => a.id)).toEqual(['1', '2']);
  });

  it('untagged 只留没有标签的', () => {
    expect(planBatchTagTargets(list, 'untagged').map((a) => a.id)).toEqual(['2']);
  });
});

describe('diffSuggested', () => {
  it('过滤掉已存在的标签', () => {
    const out = diffSuggested(['刀', '治愈'], [
      { name: '刀', reason: 'x' },
      { name: '群像', reason: 'y' },
    ]);
    expect(out.map((s) => s.name)).toEqual(['群像']);
  });

  it('过滤掉建议内部的重复与空白名', () => {
    const out = diffSuggested([], [
      { name: '群像', reason: 'a' },
      { name: '群像', reason: 'b' },
      { name: '  ', reason: 'c' },
      { name: '', reason: 'd' },
    ]);
    expect(out.map((s) => s.name)).toEqual(['群像']);
  });
});

describe('buildTaggedEntry', () => {
  it('新标签带 highlighted 标记，原有标签不动', () => {
    const entry = anime('1', '某番', ['刀']);
    const next = buildTaggedEntry(entry, ['群像', '刀']);
    expect(next.tags.map((t) => t.name)).toEqual(['刀', '群像']);
    expect(next.tags[0].highlighted).toBe(false);
    expect(next.tags[1].highlighted).toBe(true);
  });

  it('没有新增时原样返回（避免无谓的 Excel 写）', () => {
    const entry = anime('1', '某番', ['刀']);
    expect(buildTaggedEntry(entry, ['刀'])).toBe(entry);
    expect(buildTaggedEntry(entry, [])).toBe(entry);
  });
});

describe('runBatchTag', () => {
  it('全部成功时逐部产出建议', async () => {
    const targets = [anime('1', 'A', [], 1), anime('2', 'B', [], 2)];
    const items = await runBatchTag({ targets });
    expect(items.map((i) => i.status)).toEqual(['done', 'done']);
    expect(items[0].suggested.map((s) => s.name)).toEqual(['tag-A']);
  });

  it('并发数不超过上限', async () => {
    let inFlight = 0;
    let peak = 0;
    autoTagMock.mockImplementation(async (a: { title: string }) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { suggestedTags: [{ name: `t-${a.title}`, reason: '' }] };
    });

    const targets = Array.from({ length: 12 }, (_, i) => anime(String(i), `番${i}`, [], i + 1));
    await runBatchTag({ targets, concurrency: 3 });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // 确实并发了
  });

  it('单部失败不影响其它部', async () => {
    autoTagMock.mockImplementation(async (a: { title: string }) => {
      if (a.title === '坏掉') throw new Error('模型返回格式错误');
      return { suggestedTags: [{ name: `t-${a.title}`, reason: '' }] };
    });

    const items = await runBatchTag({
      targets: [anime('1', '好的', [], 1), anime('2', '坏掉', [], 2), anime('3', '也好的', [], 3)],
      concurrency: 2,
    });
    expect(items.map((i) => i.status)).toEqual(['done', 'failed', 'done']);
    expect(items[1].error).toContain('格式错误');
  });

  it('取消后不再开始新条目，已完成的结果保留', async () => {
    const controller = new AbortController();
    let calls = 0;
    autoTagMock.mockImplementation(async (a: { title: string }) => {
      calls++;
      if (calls === 2) controller.abort(); // 第二轮一结束就停
      await new Promise((r) => setTimeout(r, 5));
      return { suggestedTags: [{ name: `t-${a.title}`, reason: '' }] };
    });

    const targets = Array.from({ length: 10 }, (_, i) => anime(String(i), `番${i}`, [], i + 1));
    const items = await runBatchTag({ targets, concurrency: 1, signal: controller.signal });

    expect(items.some((i) => i.status === 'done')).toBe(true);
    expect(items.some((i) => i.status === 'pending')).toBe(true);
    expect(calls).toBeLessThan(targets.length);
  });

  it('每部开始与结束都会回调（UI 靠它实时刷新）', async () => {
    const seen: string[] = [];
    await runBatchTag({
      targets: [anime('1', 'A', [], 1)],
      onItemChange: (it) => seen.push(it.status),
    });
    expect(seen).toEqual(['running', 'done']);
  });

  it('已经存在的标签不会出现在建议里', async () => {
    autoTagMock.mockResolvedValue({
      suggestedTags: [{ name: '刀', reason: '已有' }, { name: '群像', reason: '新' }],
    });
    const items = await runBatchTag({ targets: [anime('1', 'A', ['刀'], 1)] });
    expect(items[0].suggested.map((s) => s.name)).toEqual(['群像']);
  });

  it('空目标直接返回空数组', async () => {
    const items = await runBatchTag({ targets: [] });
    expect(items).toEqual([]);
    expect(autoTagMock).not.toHaveBeenCalled();
  });
});

describe('summarizeBatchTag', () => {
  it('统计完成/失败/待处理与新增标签数', () => {
    const s = summarizeBatchTag([
      { animeId: '1', title: 'A', existingTags: [], suggested: [{ name: 'x', reason: '' }, { name: 'y', reason: '' }], status: 'done' },
      { animeId: '2', title: 'B', existingTags: [], suggested: [], status: 'done' },
      { animeId: '3', title: 'C', existingTags: [], suggested: [], status: 'failed', error: 'x' },
      { animeId: '4', title: 'D', existingTags: [], suggested: [], status: 'pending' },
    ]);
    expect(s).toMatchObject({ total: 4, done: 2, failed: 1, pending: 1, withNewTags: 1, newTagCount: 2 });
  });
});

describe('buildTagVocabulary', () => {
  it('按使用次数倒序，限制条数', async () => {
    const { buildTagVocabulary } = await import('../../../features/ai-analysis/batch-tag');
    const list = [
      anime('1', 'A', ['刀', '治愈'], 1),
      anime('2', 'B', ['刀'], 2),
      anime('3', 'C', ['刀', '冷门'], 3),
    ];
    const vocab = buildTagVocabulary(list);
    // 用得最多的排最前；1 次的按 zh 排序次之
    expect(vocab[0]).toBe('刀');
    expect(vocab.slice(1).sort()).toEqual(['冷门', '治愈'].sort());
    // limit 生效
    expect(buildTagVocabulary(list, 2)).toHaveLength(2);
    expect(buildTagVocabulary(list, 2)[0]).toBe('刀');
  });

  it('模型收到的词库里带着已有标签（这样才会复用而不是另造）', async () => {
    const targets = [anime('1', 'A', [], 1)];
    await runBatchTag({ targets, vocabulary: ['漫改', '治愈'] });
    const passed = autoTagMock.mock.calls[0][1] as { vocabulary?: string[] };
    expect(passed.vocabulary).toEqual(['漫改', '治愈']);
  });

  it('词库按模板分组：给角色卡打标签时看不到番剧的标签', async () => {
    const asAnime = { ...anime('1', '某番', [], 1), templateId: 'default' };
    const asRole = { ...anime('2', '某角色', [], 2), templateId: 'character' };
    const library = [
      asAnime,
      { ...anime('3', '另一番', ['漫改', '剧场版'], 3), templateId: 'default' },
      asRole,
      { ...anime('4', '另一角色', ['母亲', '星星眼'], 4), templateId: 'character' },
    ];

    await runBatchTag({ targets: [asAnime, asRole], library });

    const calls = autoTagMock.mock.calls.map((c) => ({
      title: (c[0] as { title: string }).title,
      vocabulary: (c[1] as { vocabulary?: string[] }).vocabulary ?? [],
    }));
    const forAnime = calls.find((c) => c.title === '某番')!;
    const forRole = calls.find((c) => c.title === '某角色')!;

    expect(forAnime.vocabulary.sort()).toEqual(['剧场版', '漫改']);
    expect(forRole.vocabulary.sort()).toEqual(['星星眼', '母亲']);
    // 两边的词库不能互相串
    expect(forRole.vocabulary).not.toContain('漫改');
    expect(forAnime.vocabulary).not.toContain('母亲');
  });
});

describe('常量', () => {
  it('默认并发是 4（太高会被网关限流）', () => {
    expect(BATCH_TAG_CONCURRENCY).toBe(4);
  });
});
