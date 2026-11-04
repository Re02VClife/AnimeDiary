/**
 * features/ranking/score-distribution 单元测试
 *   分布图的分档边界、空数据、均值位置
 */
import { describe, it, expect } from 'vitest';
import {
  buildScoreDistribution,
  meanPositionPercent,
  findScoreRangeIndex,
} from '../../../features/ranking/score-distribution';

describe('buildScoreDistribution', () => {
  it('空数组返回空分布', () => {
    const dist = buildScoreDistribution([]);
    expect(dist.bins).toEqual([]);
    expect(dist.total).toBe(0);
    expect(dist.mean).toBe(0);
    expect(dist.peak).toBe(0);
    expect(dist.step).toBe(0);
  });

  it('0 分与非法值视为未评分丢弃', () => {
    const dist = buildScoreDistribution([0, NaN, Infinity, 8, 9]);
    expect(dist.total).toBe(2);
    expect(dist.bins.reduce((s, b) => s + b.count, 0)).toBe(2);
  });

  it('分档覆盖数据范围，且档位从高到低排列', () => {
    const dist = buildScoreDistribution([8, 8, 9]);
    expect(dist.total).toBe(3);
    expect(dist.bins[0].hi).toBe(9);
    expect(dist.bins[dist.bins.length - 1].lo).toBe(8);
    // 每档 lo < hi，且相邻档首尾相接
    for (let i = 0; i < dist.bins.length; i++) {
      expect(dist.bins[i].lo).toBeLessThan(dist.bins[i].hi);
      if (i > 0) expect(dist.bins[i].hi).toBeCloseTo(dist.bins[i - 1].lo, 6);
    }
  });

  it('每条分数只落进一个档，总数守恒', () => {
    const scores = Array.from({ length: 50 }, (_, i) => 6 + (i % 13) * 0.3);
    const dist = buildScoreDistribution(scores);
    expect(dist.total).toBe(scores.length);
    expect(dist.bins.reduce((s, b) => s + b.count, 0)).toBe(scores.length);
    expect(dist.peak).toBe(Math.max(...dist.bins.map((b) => b.count)));
  });

  it('档数不会过多（自适应步长）', () => {
    // 跨度 9.5 → 步长 0.5，共 19 档
    const dist = buildScoreDistribution([0.5, 10]);
    expect(dist.step).toBe(0.5);
    expect(dist.bins.length).toBe(19);
    // 最低档含 0.5，最高档含 10（上沿为开区间，端点归入最后一档）
    expect(dist.bins[dist.bins.length - 1].count).toBe(1);
    expect(dist.bins[0].count).toBe(1);
  });

  it('窄跨度用更细的步长，避免只剩一两个条', () => {
    const dist = buildScoreDistribution([8.9, 9.0, 9.1]);
    expect(dist.bins.length).toBeGreaterThanOrEqual(10);
    expect(dist.total).toBe(3);
  });

  it('超范围脏值如实分档，不被截断进 10 分档', () => {
    // 实测「制作」列存在 15 分：按真实范围分档，才能和排名列表的分数对上
    const dist = buildScoreDistribution([3.4, 15]);
    expect(dist.bins[0].hi).toBe(15);
    expect(dist.bins[0].count).toBe(1);
    expect(dist.bins[dist.bins.length - 1].lo).toBe(3);
  });

  it('平均分保留两位小数', () => {
    const dist = buildScoreDistribution([8, 8, 9]);
    expect(dist.mean).toBe(8.33);
  });
});

describe('meanPositionPercent', () => {
  it('无数据返回 0', () => {
    expect(meanPositionPercent(buildScoreDistribution([]))).toBe(0);
  });

  it('平均线落在图的纵向范围内', () => {
    const dist = buildScoreDistribution([7, 8, 9, 10]);
    const pos = meanPositionPercent(dist);
    expect(pos).toBeGreaterThanOrEqual(0);
    expect(pos).toBeLessThanOrEqual(100);
  });

  it('偏斜分布里平均线落在均值对应的纵向位置', () => {
    // 范围 5~10，均分 (5+5+10)/3 = 6.67 → 距顶部 (10-6.67)/5 = 66.7%
    const dist = buildScoreDistribution([5, 5, 10]);
    expect(meanPositionPercent(dist)).toBeCloseTo(66.67, 0);
  });
});

describe('findScoreRangeIndex', () => {
  // 降序排列的分数（与侧栏排名、网格顺序一致）
  const values = [9.5, 9.2, 9.2, 8.8, 8.8, 8.8, 8.2];

  it('空序列返回 -1', () => {
    expect(findScoreRangeIndex([], 8, 9)).toBe(-1);
  });

  it('返回区间内第一条的下标', () => {
    expect(findScoreRangeIndex(values, 9.3, 9.6)).toBe(0); // 9.5
    expect(findScoreRangeIndex(values, 8.8, 9.0)).toBe(3);
    expect(findScoreRangeIndex(values, 8.0, 8.5)).toBe(6);
  });

  it('区间上沿不含：9.2 不落进 [9.0, 9.2)', () => {
    // 3.2 若被算作命中会返回 0；实际只有 9.15 在区间内
    expect(findScoreRangeIndex([9.2, 9.15], 9.0, 9.2)).toBe(1);
  });

  it('空档退化为最接近档位中心的一条', () => {
    // [9.6, 9.8) 里没有分，中心 9.7 最接近 9.5 → 下标 0
    expect(findScoreRangeIndex(values, 9.6, 9.8)).toBe(0);
    // [9.0, 9.2) 里没有分，中心 9.1 → 9.2（下标 1）
    expect(findScoreRangeIndex(values, 9.0, 9.2)).toBe(1);
  });
});
