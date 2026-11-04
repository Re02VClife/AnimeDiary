/**
 * features/ai-analysis/external-skills 单测
 *
 * 这里处理的都是网络返回，最怕的是「静默给出错的东西」：
 *   - Bangumi 挂了却把缓存当社区资料交出去
 *   - 搜不到却返回空数组，让模型以为"这部番不存在"
 * 所以重点测降级路径上的 note 是否如实说明了数据来源。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { lookupAnime, fetchReviews } from '../../../features/ai-analysis/external-skills';
import type { AnimeEntry } from '../../../src/types';

function makeAnime(title: string, overall = 8.96, bgm = 7.6): AnimeEntry {
  return {
    id: '1', title, posterUrl: '', category: 'watched',
    tags: [{ name: '刀', highlighted: false }],
    scores: [{ dimensionKey: 'overall', score: overall }],
    bangumiScore: bgm,
    createdAt: '2024-01-01', updatedAt: '2024-01-01',
  };
}

interface Route { bangumi?: unknown; anilist?: unknown; reviews?: unknown }

/** 按 URL 分流的假 fetch */
function stubFetch(routes: Route, status: { bangumi?: number } = {}) {
  const spy = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('/api/bangumi/search')) {
      const code = status.bangumi ?? 200;
      if (code !== 200) {
        return { ok: false, status: code, async json() { return {}; }, async text() { return ''; } };
      }
      return { ok: true, status: 200, async json() { return routes.bangumi ?? { list: [] }; } };
    }
    if (u.includes('/api/anilist/search')) {
      return { ok: true, status: 200, async json() { return routes.anilist ?? { list: [] }; } };
    }
    if (u.includes('/api/bangumi/reviews')) {
      return { ok: true, status: 200, async json() { return routes.reviews ?? { results: {} }; } };
    }
    return { ok: false, status: 404, async json() { return {}; } };
  });
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

const bangumiItem = {
  id: 1,
  name: '86 不存在的战区 part1',
  name_cn: '86 不存在的战区 part1',
  summary: '共和国把 86 当作消耗品。',
  air_date: '2021-04-10',
  eps: 11,
  rating: { score: 7.6, total: 5000 },
  tags: [{ name: '战争' }, { name: '轻小说改' }],
  studio: 'A-1 Pictures',
  link: 'https://bgm.tv/subject/1',
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.useRealTimers();
});

describe('lookupAnime', () => {
  it('正常命中：映射字段，并带上本地评分做对照', async () => {
    stubFetch({ bangumi: { list: [bangumiItem] } });
    const result = await lookupAnime('86 不存在的战区 part1', [makeAnime('86 不存在的战区 part1')]);

    expect(result.source).toBe('bangumi');
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      title: '86 不存在的战区 part1',
      score: 7.6,
      airDate: '2021-04-10',
      episodes: 11,
      tags: ['战争', '轻小说改'],
      studio: 'A-1 Pictures',
    });
    // 本地有这部 → 带回你自己的分数
    expect(result.local?.overall).toBeCloseTo(8.96, 2);
    expect(result.local?.bangumiScore).toBe(7.6);
    expect(result.note).toBeUndefined();
  });

  it('本地没有的番也能查（这是对话里最常用的场景）', async () => {
    stubFetch({ bangumi: { list: [bangumiItem] } });
    const result = await lookupAnime('三月的狮子', []);
    expect(result.source).toBe('bangumi');
    expect(result.local).toBeUndefined();
    expect(result.candidates).toHaveLength(1);
  });

  it('Bangumi 不可达时回落 AniList，并如实说明', async () => {
    stubFetch(
      {
        bangumi: { list: [], offline: true, error: '请求超时' },
        anilist: { list: [{ id: 2, name: '3-gatsu no Lion', name_cn: '', rating: { score: 85 }, air_date: '2016' }] },
      },
    );
    const result = await lookupAnime('三月的狮子', []);
    expect(result.source).toBe('anilist');
    expect(result.candidates[0].title).toBe('3-gatsu no Lion');
    expect(result.note).toContain('不可达');
    expect(result.note).toContain('请求超时');
  });

  it('结果来自本地缓存时必须写进 note —— 缓存里可能有用户自己的备注', async () => {
    stubFetch({ bangumi: { list: [bangumiItem], cached: true } });
    const result = await lookupAnime('86', []);
    expect(result.note).toContain('本地缓存');
  });

  it('两个源都没有结果时明确说没查到，而不是返回空候选让模型自己编', async () => {
    stubFetch({ bangumi: { list: [] }, anilist: { list: [] } });
    const result = await lookupAnime('不存在的番', []);
    expect(result.source).toBe('none');
    expect(result.candidates).toEqual([]);
    expect(result.note).toBeTruthy();
  });

  it('Bangumi 返回非 200 时抛错（由调用方转成工具错误）', async () => {
    stubFetch({ bangumi: {} }, { bangumi: 500 });
    await expect(lookupAnime('86', [])).rejects.toThrow(/HTTP 500/);
  });

  it('空标题直接拒绝', async () => {
    await expect(lookupAnime('   ', [])).rejects.toThrow(/番剧名/);
  });

  it('summary 过长会截断，避免一条简介挤满上下文', async () => {
    const long = { ...bangumiItem, summary: '很'.repeat(500) };
    stubFetch({ bangumi: { list: [long] } });
    const result = await lookupAnime('86', []);
    expect(result.candidates[0].summary.length).toBeLessThanOrEqual(221);
    expect(result.candidates[0].summary.endsWith('…')).toBe(true);
  });
});

describe('fetchReviews', () => {
  it('返回短评，单条限长', async () => {
    stubFetch({
      reviews: { results: { '86': { reviews: ['好看', '很'.repeat(500)] } } },
    });
    const result = await fetchReviews('86');
    expect(result.count).toBe(2);
    expect(result.reviews[0]).toBe('好看');
    expect(result.reviews[1].length).toBeLessThanOrEqual(301);
  });

  it('没有评论时给出明确说明', async () => {
    stubFetch({ reviews: { results: {} } });
    const result = await fetchReviews('冷门番');
    expect(result.count).toBe(0);
    expect(result.note).toContain('没有采集到');
  });

  it('空标题直接拒绝', async () => {
    await expect(fetchReviews('')).rejects.toThrow(/番剧名/);
  });
});
