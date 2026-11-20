/**
 * features/ranking/score-rank-series — 底部「评分 · 名次」图的数据构建
 *
 * 这里只测纯函数：名次顺序、0 分丢弃、总评/BGM 的取值口径、维度筛选。
 * 组件层（ECharts 画布）不在 jsdom 里渲染，视觉部分靠人工看截图。
 */
import { describe, it, expect } from 'vitest';
import {
  buildScoreRankSeries,
  maxRank,
  BGM_DIM_KEY,
} from '../../../features/ranking/score-rank-series';
import type { AnimeEntry, Dimension } from '../../../src/types';

function makeAnime(
  id: string,
  scores: Record<string, number>,
  extra: Partial<AnimeEntry> = {},
): AnimeEntry {
  return {
    id,
    title: `番剧 ${id}`,
    posterUrl: '',
    category: 'watched',
    tags: [],
    scores: Object.entries(scores).map(([k, v]) => ({ dimensionKey: k, score: v })),
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
    ...extra,
  };
}

const DIMS: Dimension[] = [
  { key: 'overall', label: '总评', description: '', weight: 0 },
  { key: 'audio', label: '音声', description: '', weight: 0.5 },
  { key: 'plot', label: '剧情', description: '', weight: 0.5 },
];

describe('buildScoreRankSeries', () => {
  it('每个维度一条线，按分数降序、名次从 1 连续编号', () => {
    const list = [
      makeAnime('a', { audio: 6, plot: 9 }),
      makeAnime('b', { audio: 9, plot: 7 }),
      makeAnime('c', { audio: 7, plot: 8 }),
    ];
    const series = buildScoreRankSeries(list, DIMS, { includeBgm: false });

    expect(series.map((s) => s.key)).toEqual(['audio', 'plot']);

    const audio = series.find((s) => s.key === 'audio')!;
    expect(audio.label).toBe('音声');
    expect(audio.points.map((p) => p.animeId)).toEqual(['b', 'c', 'a']);
    expect(audio.points.map((p) => p.rank)).toEqual([1, 2, 3]);
    expect(audio.points.map((p) => p.score)).toEqual([9, 7, 6]);

    const plot = series.find((s) => s.key === 'plot')!;
    expect(plot.points.map((p) => p.animeId)).toEqual(['a', 'c', 'b']);
  });

  it('0 分和缺失维度算「没有分」，不参与排名', () => {
    const list = [
      makeAnime('a', { audio: 8 }),
      makeAnime('b', { audio: 0 }),
      makeAnime('c', {}),
    ];
    const series = buildScoreRankSeries(list, DIMS, { includeBgm: false });
    expect(series).toHaveLength(1);
    expect(series[0].points.map((p) => p.animeId)).toEqual(['a']);
    expect(series[0].points[0].rank).toBe(1);
  });

  it('同分保持网格顺序（稳定排序），名次不并列', () => {
    const list = [
      makeAnime('first', { plot: 8 }),
      makeAnime('second', { plot: 8 }),
      makeAnime('third', { plot: 9 }),
    ];
    const series = buildScoreRankSeries(list, DIMS, { includeBgm: false });
    const plot = series.find((s) => s.key === 'plot')!;
    expect(plot.points.map((p) => p.animeId)).toEqual(['third', 'first', 'second']);
    expect(plot.points.map((p) => p.rank)).toEqual([1, 2, 3]);
  });

  it('总评走注入的 overallOf；不注入时整条总评线不出现', () => {
    const list = [makeAnime('a', { audio: 8, plot: 6 }), makeAnime('b', { audio: 6, plot: 8 })];
    const withOverall = buildScoreRankSeries(list, DIMS, {
      includeBgm: false,
      overallOf: (anime) => (anime.id === 'a' ? 7.5 : 6.5),
    });
    const overall = withOverall.find((s) => s.key === 'overall')!;
    expect(overall.points.map((p) => p.animeId)).toEqual(['a', 'b']);
    expect(overall.points[0].score).toBe(7.5);

    const withoutOverall = buildScoreRankSeries(list, DIMS, { includeBgm: false });
    expect(withoutOverall.some((s) => s.key === 'overall')).toBe(false);
  });

  it('总评算出 0（一个维度都没分）时不生成 0 分点', () => {
    const list = [makeAnime('a', { audio: 8 })];
    const series = buildScoreRankSeries(list, DIMS, {
      includeBgm: false,
      overallOf: () => 0,
    });
    expect(series.some((s) => s.key === 'overall')).toBe(false);
  });

  it('BGM 取 bangumiScore，可用 includeBgm:false 关掉', () => {
    const list = [
      makeAnime('a', { audio: 8 }, { bangumiScore: 7.2 }),
      makeAnime('b', { audio: 7 }, { bangumiScore: 8.1 }),
      makeAnime('c', { audio: 9 }), // 没有 BGM 分
    ];
    const series = buildScoreRankSeries(list, DIMS);
    const bgm = series.find((s) => s.key === BGM_DIM_KEY)!;
    expect(bgm.label).toBe('BGM');
    expect(bgm.points.map((p) => p.animeId)).toEqual(['b', 'a']);
    expect(bgm.points.map((p) => p.score)).toEqual([8.1, 7.2]);

    const off = buildScoreRankSeries(list, DIMS, { includeBgm: false });
    expect(off.some((s) => s.key === BGM_DIM_KEY)).toBe(false);
  });

  it('onlyKeys 只留指定维度，且顺序跟随模板而不是入参顺序', () => {
    const list = [makeAnime('a', { audio: 8, plot: 7 }, { bangumiScore: 6 })];
    const series = buildScoreRankSeries(list, DIMS, {
      onlyKeys: ['plot', 'audio'],
    });
    expect(series.map((s) => s.key)).toEqual(['audio', 'plot']);
  });

  it('模板里误写成 bgm 的维度被外部分数那条线取代，不会出两条同名线', () => {
    const dims: Dimension[] = [
      { key: 'bgm', label: 'BGM(自定义)', description: '', weight: 1 },
      { key: 'plot', label: '剧情', description: '', weight: 1 },
    ];
    const list = [makeAnime('a', { bgm: 3, plot: 7 }, { bangumiScore: 8 })];
    const series = buildScoreRankSeries(list, dims);
    const bgmSeries = series.filter((s) => s.key === BGM_DIM_KEY);
    expect(bgmSeries).toHaveLength(1);
    expect(bgmSeries[0].label).toBe('BGM');
    expect(bgmSeries[0].points[0].score).toBe(8);
  });

  it('空列表返回空数组', () => {
    expect(buildScoreRankSeries([], DIMS)).toEqual([]);
  });
});

describe('maxRank', () => {
  it('取最长的一条序列', () => {
    const list = [
      makeAnime('a', { audio: 8, plot: 7 }),
      makeAnime('b', { audio: 7 }),
    ];
    const series = buildScoreRankSeries(list, DIMS, { includeBgm: false });
    expect(maxRank(series)).toBe(2);
    expect(maxRank([])).toBe(0);
  });

  it('一条分都没有的条目不会出现在任何序列里（图表统计也按这个口径）', () => {
    const list = [
      makeAnime('a', { audio: 8 }),
      makeAnime('b', {}),
      makeAnime('c', {}, { bangumiScore: 7 }),
    ];
    const noBgm = buildScoreRankSeries(list, DIMS, { includeBgm: false });
    const idsNoBgm = new Set(noBgm.flatMap((s) => s.points.map((p) => p.animeId)));
    expect([...idsNoBgm]).toEqual(['a']);

    const withBgm = buildScoreRankSeries(list, DIMS);
    const ids = new Set(withBgm.flatMap((s) => s.points.map((p) => p.animeId)));
    expect(ids.has('a')).toBe(true);
    expect(ids.has('b')).toBe(false);
    expect(ids.has('c')).toBe(true); // c 只有 BGM 分，仍算画进图里
  });
});
