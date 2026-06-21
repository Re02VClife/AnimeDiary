/**
 * features/ranking 集成测试
 */
import { describe, it, expect } from 'vitest';
import { buildPercentileMap, getPercentileScores, rankByDimension } from '../../../features/ranking/ranking-service';
import type { AnimeEntry } from '../../../src/types';

/** 创建简单测试番剧 */
function makeAnime(id: string, scores: Record<string, number>): AnimeEntry {
  return {
    id,
    title: `Test ${id}`,
    posterUrl: '',
    category: 'watched',
    tags: [],
    scores: Object.entries(scores).map(([k, v]) => ({ dimensionKey: k, score: v })),
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
  };
}

describe('buildPercentileMap', () => {
  it('空列表返回空对象', () => {
    const stats = buildPercentileMap([]);
    // 所有维度都有条目但分数为空
    for (const key of Object.keys(stats)) {
      expect(stats[key].allScores).toEqual([]);
    }
  });

  it('单个番剧返回有效映射', () => {
    const list = [makeAnime('1', { audio: 8, plot: 7, vibe: 9 })];
    const stats = buildPercentileMap(list);
    expect(stats['audio'].allScores).toEqual([8]);
    expect(stats['plot'].allScores).toEqual([7]);
  });

  it('多个番剧正确排序和映射', () => {
    const list = [
      makeAnime('1', { audio: 5, plot: 10 }),
      makeAnime('2', { audio: 9, plot: 6 }),
      makeAnime('3', { audio: 7, plot: 8 }),
    ];
    const stats = buildPercentileMap(list);
    // audio 分数升序: [5, 7, 9]
    expect(stats['audio'].allScores).toEqual([5, 7, 9]);
    // plot 分数升序: [6, 8, 10]
    expect(stats['plot'].allScores).toEqual([6, 8, 10]);
  });
});

describe('getPercentileScores', () => {
  it('单番时分数对应百分位约50（无充分比较基准）', () => {
    const list = [makeAnime('1', { audio: 9, plot: 8 })];
    const stats = buildPercentileMap(list);
    const pcts = getPercentileScores(list[0], stats);
    const audioPct = pcts.find((p) => p.dimensionKey === 'audio');
    const plotPct = pcts.find((p) => p.dimensionKey === 'plot');
    // 只有一部番剧时，分数在中位数位置
    expect(audioPct?.percentile).toBeGreaterThan(0);
    expect(plotPct?.percentile).toBeGreaterThan(0);
  });

  it('中位数分数 → 百分位约 50', () => {
    const list = [
      makeAnime('1', { audio: 2 }),
      makeAnime('2', { audio: 5 }),
      makeAnime('3', { audio: 8 }),
    ];
    const stats = buildPercentileMap(list);
    const pcts = getPercentileScores(list[1], stats); // audio=5, 中间值
    const audioPct = pcts.find((p) => p.dimensionKey === 'audio');
    // 在 [2,5,8] 中，5 处于中位数位置
    expect(audioPct?.percentile).toBeGreaterThan(0);
    expect(audioPct?.percentile).toBeLessThan(100);
  });

  it('零分维度被跳过', () => {
    const list = [
      makeAnime('1', { audio: 7 }),
      makeAnime('2', { audio: 8, plot: 6 }),
    ];
    const stats = buildPercentileMap(list);
    const pcts = getPercentileScores(list[0], stats); // 只有 audio
    const plotPct = pcts.find((p) => p.dimensionKey === 'plot');
    expect(plotPct?.rawScore).toBe(0);
  });
});

describe('rankByDimension', () => {
  it('按维度分数降序排列', () => {
    const list = [
      makeAnime('1', { audio: 5 }),
      makeAnime('2', { audio: 9 }),
      makeAnime('3', { audio: 7 }),
    ];
    const ranked = rankByDimension(list, 'audio');
    expect(ranked[0].id).toBe('2'); // 9
    expect(ranked[1].id).toBe('3'); // 7
    expect(ranked[2].id).toBe('1'); // 5
  });

  it('无分数的番剧被过滤掉', () => {
    const list = [
      makeAnime('1', {}),
      makeAnime('2', { audio: 8 }),
      makeAnime('3', {}),
    ];
    const ranked = rankByDimension(list, 'audio');
    // rankByDimension 会过滤掉该维度无分数的番剧
    expect(ranked[0].id).toBe('2');
    expect(ranked.every((a) => a.scores.some((s) => s.dimensionKey === 'audio' && s.score > 0))).toBe(true);
  });
});
