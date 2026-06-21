/**
 * core/math 单元测试
 */
import { describe, it, expect } from 'vitest';
import { cosineSimilarity, jaccardSimilarity, jaccardArrays, calcOverall } from '../../core/math';

describe('cosineSimilarity', () => {
  it('相同向量返回 1', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 5);
  });

  it('正交向量返回 0', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it('零向量返回 0', () => {
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
    expect(cosineSimilarity([1, 2], [0, 0])).toBe(0);
  });

  it('一般情况计算正确', () => {
    // a=[1,2,3], b=[2,4,6] → 完全相同方向 → 1
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 5);
  });

  it('空数组返回 0', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe('jaccardSimilarity', () => {
  it('完全相同的 Set 返回 1', () => {
    expect(jaccardSimilarity(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
  });

  it('完全不同的 Set 返回 0', () => {
    expect(jaccardSimilarity(new Set(['a']), new Set(['b']))).toBe(0);
  });

  it('部分重叠计算正确', () => {
    // 交=1 (b), 并=3 (a,b,c) → 1/3
    const a = new Set(['a', 'b']);
    const b = new Set(['b', 'c']);
    expect(jaccardSimilarity(a, b)).toBeCloseTo(1 / 3, 5);
  });

  it('两个空 Set 返回 0', () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(0);
  });
});

describe('jaccardArrays', () => {
  it('等同于将数组转 Set 后计算', () => {
    const result = jaccardArrays(['a', 'b'], ['b', 'c']);
    expect(result).toBeCloseTo(1 / 3, 5);
  });

  it('包含重复元素的数组正确去重', () => {
    // 去重后都是 ['a', 'b'] → Jaccard = 1
    expect(jaccardArrays(['a', 'b', 'a'], ['a', 'b', 'b'])).toBe(1);
  });
});

describe('calcOverall', () => {
  const dims = [
    { key: 'audio', weight: 0.12 },
    { key: 'plot', weight: 0.20 },
    { key: 'vibe', weight: 0.05 },
    { key: 'overall', weight: 0 }, // 应被跳过
  ];

  it('全部有分数时计算加权平均', () => {
    const scores = { audio: 9, plot: 8, vibe: 10 };
    // (9*0.12 + 8*0.20 + 10*0.05) / (0.12+0.20+0.05) = (1.08+1.6+0.5)/0.37 = 3.18/0.37 ≈ 8.5946
    const result = calcOverall(scores, dims);
    expect(result).toBeCloseTo(3.18 / 0.37, 5);
  });

  it('部分无分数时仅计算有分数的维度', () => {
    const scores = { audio: 10, vibe: 6 };
    // (10*0.12 + 6*0.05) / 0.17 = 1.5/0.17 ≈ 8.8235
    const result = calcOverall(scores, dims);
    expect(result).toBeCloseTo(1.5 / 0.17, 5);
  });

  it('全部无分数返回 0', () => {
    expect(calcOverall({}, dims)).toBe(0);
  });

  it('跳过 overall 维度', () => {
    const scores = { audio: 8, overall: 999 };
    // (8*0.12) / 0.12 = 8
    expect(calcOverall(scores, dims)).toBeCloseTo(8, 5);
  });
});
