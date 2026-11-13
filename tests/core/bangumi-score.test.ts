import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SCORE_MAPPING,
  mapScore,
  scoreHistogram,
  mappingSummary,
  kdeSamples,
  meanOf,
  stdOf,
} from '../../core/bangumi-score';

describe('mapScore：本地加权总评 → Bangumi 1-10 整数', () => {
  it('默认四舍五入', () => {
    expect(mapScore(8.96)).toBe(9);
    expect(mapScore(8.4)).toBe(8);
    expect(mapScore(9.5)).toBe(10);
  });

  it('没打分的条目不写 rate', () => {
    expect(mapScore(0)).toBeNull();
    expect(mapScore(undefined)).toBeNull();
    expect(mapScore(null)).toBeNull();
    expect(mapScore(NaN)).toBeNull();
    expect(mapScore(-3)).toBeNull();
  });

  it('低于 0.5 的分数钳到 1，绝不能落成 0（0 在 Bangumi 是清除评分）', () => {
    expect(mapScore(0.2)).toBe(1);
    expect(mapScore(0.49)).toBe(1);
  });

  it('超过 10 分的脏值钳到 10', () => {
    expect(mapScore(12.5)).toBe(10);
  });

  it('slope < 1 把分数往 center 收（8.96 → 8）', () => {
    expect(mapScore(8.96, { offset: 0, slope: 0.5, center: 8 })).toBe(8);
    // 低分也会被抬高，这是「压缩」的对称代价
    expect(mapScore(6.2, { offset: 0, slope: 0.5, center: 8 })).toBe(7);
  });

  it('slope > 1 放大差异', () => {
    expect(mapScore(9.0, { offset: 0, slope: 1.5, center: 8 })).toBe(10);
    expect(mapScore(7.0, { offset: 0, slope: 1.5, center: 8 })).toBe(7);
  });

  it('offset 整体平移，且仍受 1-10 钳制', () => {
    expect(mapScore(8.0, { offset: 1, slope: 1, center: 8 })).toBe(9);
    expect(mapScore(9.6, { offset: 2, slope: 1, center: 8 })).toBe(10);
    expect(mapScore(1.2, { offset: -2, slope: 1, center: 8 })).toBe(1);
  });

  it('默认配置不改变原有分数', () => {
    for (const v of [1.1, 5.4, 6.6, 7.9, 8.5, 9.9]) {
      expect(mapScore(v, DEFAULT_SCORE_MAPPING)).toBe(Math.round(v));
    }
  });
});

describe('scoreHistogram', () => {
  it('按 1-10 分档计数，索引 0 恒为 0', () => {
    const h = scoreHistogram([1, 1, 5, 9, 10, 10, 10, null]);
    expect(h[0]).toBe(0);
    expect(h[1]).toBe(2);
    expect(h[5]).toBe(1);
    expect(h[9]).toBe(1);
    expect(h[10]).toBe(3);
    expect(h.reduce((a, b) => a + b, 0)).toBe(7);
  });

  it('空输入返回全零', () => {
    expect(scoreHistogram([]).every((n) => n === 0)).toBe(true);
  });
});

describe('mappingSummary', () => {
  it('统计顶格与垫底数量，用来提示旋钮调过头', () => {
    const s = mappingSummary([10, 10, 1, 5, null]);
    expect(s).toEqual({ total: 4, atMax: 2, atMin: 1 });
  });
});

describe('kdeSamples：Bangumi 评分的分布曲线', () => {
  it('没有样本时返回空数组', () => {
    expect(kdeSamples([])).toEqual([]);
  });

  it('峰值落在样本附近', () => {
    const pts = kdeSamples([7.6, 7.7, 7.6, 7.8, 7.5]);
    const peak = pts.reduce((a, b) => (b.density > a.density ? b : a));
    expect(peak.x).toBeGreaterThan(7.2);
    expect(peak.x).toBeLessThan(8.0);
  });

  it('双峰数据在两边都有高点（不会被抹成单峰）', () => {
    const pts = kdeSamples([4.5, 4.5, 4.5, 9.0, 9.0, 9.0]);
    const left = pts.filter((p) => p.x < 6.5).reduce((a, b) => Math.max(a, b.density), 0);
    const right = pts.filter((p) => p.x > 7.5).reduce((a, b) => Math.max(a, b.density), 0);
    const middle = pts.filter((p) => p.x > 6.5 && p.x < 7.5).reduce((a, b) => Math.max(a, b.density), 0);
    expect(left).toBeGreaterThan(middle);
    expect(right).toBeGreaterThan(middle);
  });

  it('采样点覆盖 0.5-10.5，够画满整个横轴', () => {
    const pts = kdeSamples([7]);
    expect(pts[0].x).toBeCloseTo(0.5, 2);
    expect(pts[pts.length - 1].x).toBeCloseTo(10.5, 2);
    expect(pts.length).toBeGreaterThan(190);
  });

  it('密度对 x 的积分约等于 1（它是个概率密度）', () => {
    const pts = kdeSamples([3, 5, 7, 7, 8, 9]);
    const area = pts.reduce((sum, p) => sum + p.density * 0.05, 0);
    expect(area).toBeGreaterThan(0.9);
    expect(area).toBeLessThan(1.1);
  });
});

describe('meanOf', () => {
  it('没有样本返回 null，而不是 0', () => {
    expect(meanOf([])).toBeNull();
  });

  it('正常求平均', () => {
    expect(meanOf([7, 8, 9])).toBeCloseTo(8, 5);
  });
});

describe('stdOf：分散度', () => {
  it('少于两个样本返回 null', () => {
    expect(stdOf([])).toBeNull();
    expect(stdOf([7])).toBeNull();
  });

  it('全部相同则标准差为 0', () => {
    expect(stdOf([7, 7, 7, 7])).toBeCloseTo(0, 5);
  });

  it('真实量级：本批 0.95、Bangumi 0.68', () => {
    // 用 5 个点近似，确认算法是总体标准差（除以 n，不是 n-1）
    expect(stdOf([6, 7, 7, 8, 8])).toBeCloseTo(0.748, 3);
    expect(stdOf([6.9, 7.2, 7.2, 7.4, 7.5])).toBeCloseTo(0.206, 3);
  });

  it('放大倍数与斜率一致（线性变换的标准差性质）', () => {
    const base = [6, 7, 8, 9];
    const scaled = base.map((v) => 8 + (v - 8) * 2);
    expect(stdOf(scaled)!).toBeCloseTo(stdOf(base)! * 2, 5);
  });
});
