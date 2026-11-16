/**
 * ai-helpers.calcOverall 的维度来源
 *
 * 回归的是 HANDOVER §6.1 那个 bug 的 AI 侧副本：旧实现不传 dimensions 时
 * **固定用 DEFAULT_DIMENSIONS**（代码里硬编码的权重），而界面的总评走
 * `getTemplate(entry.templateId)`（用户默认模板）。用户改过权重后，AI 分析里
 * 出现的总评就和卡片/侧栏/详情不是一个数。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { calcOverall } from '../../../features/ai-analysis/ai-helpers';
import { saveTemplates } from '../../../features/anime-data/template-service';
import { createDefaultTemplate, DEFAULT_DIMENSIONS } from '../../../src/types';
import type { AnimeEntry, Dimension } from '../../../src/types';

/** 只造 calcOverall 用得到的字段 */
function makeEntry(scores: Record<string, number>, templateId?: string): AnimeEntry {
  return {
    id: 'test-1',
    title: '测试番剧',
    posterUrl: '',
    category: 'watched',
    tags: [],
    scores: Object.entries(scores).map(([dimensionKey, score]) => ({ dimensionKey, score })),
    createdAt: '2025-01-01',
    updatedAt: '2025-01-01',
    ...(templateId ? { templateId } : {}),
  };
}

describe('ai-helpers.calcOverall：不传 dimensions 时用条目自身模板的权重', () => {
  beforeEach(() => {
    localStorage.clear();
    // 把默认模板改成只剩 audio/plot 两个有分量的维度：9*0.9 + 4*0.1 = 8.5
    const tpl = createDefaultTemplate();
    tpl.dimensions = tpl.dimensions.map((d) => {
      if (d.key === 'audio') return { ...d, weight: 0.9 };
      if (d.key === 'plot') return { ...d, weight: 0.1 };
      return { ...d, weight: 0 };
    });
    saveTemplates([tpl]);
  });

  it('模板权重优先于 DEFAULT_DIMENSIONS', () => {
    const entry = makeEntry({ audio: 9, plot: 4 });
    // getTemplate(undefined) → 用户默认模板（audio .9 / plot .1）
    expect(calcOverall(entry)).toBeCloseTo(8.5, 5);
    // 同一个条目按 DEFAULT_DIMENSIONS（audio .12 / plot .20）是 5.875 —— 旧实现会取这个
    expect(DEFAULT_DIMENSIONS.find((d) => d.key === 'audio')?.weight).toBeCloseTo(0.12, 5);
    expect(calcOverall(entry)).not.toBeCloseTo(5.875, 2);
  });

  it('显式传 dimensions 时按传入维度算（跨模板批量统计用同一把尺）', () => {
    const entry = makeEntry({ audio: 9, plot: 4 });
    const equalWeights: Dimension[] = [
      { key: 'audio', label: '音声', description: '', weight: 0.5 },
      { key: 'plot', label: '剧情', description: '', weight: 0.5 },
    ];
    expect(calcOverall(entry, equalWeights)).toBeCloseTo(6.5, 5);
  });

  it('模板里的自定义维度也能取到分（不再被 DEFAULT_DIMENSIONS 的 key 集挡住）', () => {
    const tpl = createDefaultTemplate();
    tpl.dimensions = [
      { key: 'overall', label: '总评', description: '', weight: 0 },
      { key: 'dim_玩法', label: '玩法', description: '', weight: 0.5 },
      { key: 'dim_美术', label: '美术', description: '', weight: 0.5 },
    ];
    saveTemplates([tpl]);
    const entry = makeEntry({ dim_玩法: 8, dim_美术: 6 });
    expect(calcOverall(entry)).toBeCloseTo(7, 5);
  });
});
