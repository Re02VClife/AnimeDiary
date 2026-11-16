import { describe, it, expect } from 'vitest';
import { calcOverall, calcEntryOverall } from '../../core/overall';
import { DEFAULT_DIMENSIONS } from '../../src/types';
import type { Dimension } from '../../src/types';

const dim = (key: string, weight: number): Dimension => ({ key, label: key, description: '', weight });

describe('calcOverall：维度加权总评', () => {
  it('有权重时按权重加权', () => {
    const dims = [dim('audio', 0.8), dim('plot', 0.2)];
    const scores = [
      { dimensionKey: 'audio', score: 9 },
      { dimensionKey: 'plot', score: 4 },
    ];
    // 9*0.8 + 4*0.2 = 8
    expect(calcOverall(scores, dims)).toBeCloseTo(8, 5);
  });

  it('全部权重为 0 时退化为等权重', () => {
    const dims = [dim('audio', 0), dim('plot', 0), dim('vibe', 0)];
    const scores = [
      { dimensionKey: 'audio', score: 9 },
      { dimensionKey: 'plot', score: 6 },
      { dimensionKey: 'vibe', score: 3 },
    ];
    expect(calcOverall(scores, dims)).toBeCloseTo(6, 5);
  });

  it('0 分视为未评分，不参与加权（否则会把平均拉低）', () => {
    const dims = [dim('audio', 1), dim('plot', 1)];
    const scores = [
      { dimensionKey: 'audio', score: 9 },
      { dimensionKey: 'plot', score: 0 },
    ];
    expect(calcOverall(scores, dims)).toBeCloseTo(9, 5);
  });

  it('缺失的维度按 0 处理并跳过', () => {
    const dims = [dim('audio', 1), dim('plot', 1)];
    const scores = [{ dimensionKey: 'audio', score: 8 }];
    expect(calcOverall(scores, dims)).toBeCloseTo(8, 5);
  });

  it('剔除 overall 维度本身', () => {
    const dims = [dim('overall', 5), dim('audio', 1)];
    const scores = [
      { dimensionKey: 'overall', score: 1 },
      { dimensionKey: 'audio', score: 7 },
    ];
    expect(calcOverall(scores, dims)).toBeCloseTo(7, 5);
  });

  it('没有可用维度时返回 0', () => {
    expect(calcOverall([], [])).toBe(0);
    expect(calcOverall([{ dimensionKey: 'audio', score: 8 }], [dim('overall', 1)])).toBe(0);
  });

  it('全部 0 分返回 0', () => {
    expect(calcOverall([{ dimensionKey: 'audio', score: 0 }], [dim('audio', 1)])).toBe(0);
  });
});

describe('calcEntryOverall：维度来源是条目所属模板（不再各处手拼）', () => {
  it('用户模板权重与 DEFAULT_DIMENSIONS 不同时，必须取模板权重', () => {
    const userDims = [dim('audio', 0.9), dim('plot', 0.1)];
    const scores = [
      { dimensionKey: 'audio', score: 9 },
      { dimensionKey: 'plot', score: 4 },
    ];
    // 用户权重：9*0.9 + 4*0.1 = 8.5
    expect(calcEntryOverall({ scores, templateId: 'default' }, () => userDims)).toBeCloseTo(8.5, 5);
    // 反证：同一对维度按代码里的 DEFAULT_DIMENSIONS（audio .12 / plot .20）算出的是另一个数
    expect(calcOverall(scores, DEFAULT_DIMENSIONS)).toBeCloseTo(5.875, 5);
  });

  it('把条目的 templateId 原样交给解析器（undefined = 用户默认模板）', () => {
    const seen: (string | undefined)[] = [];
    const resolve = (id: string | undefined) => {
      seen.push(id);
      return [dim('audio', 1)];
    };
    calcEntryOverall({ scores: [{ dimensionKey: 'audio', score: 8 }], templateId: 'character' }, resolve);
    calcEntryOverall({ scores: [{ dimensionKey: 'audio', score: 8 }] }, resolve);
    expect(seen).toEqual(['character', undefined]);
  });

  it('equalWeightFallback: false 时不退化等权（详情面板既有显示口径：显示「-」）', () => {
    const zeroWeights = [dim('audio', 0), dim('plot', 0)];
    const scores = [
      { dimensionKey: 'audio', score: 9 },
      { dimensionKey: 'plot', score: 6 },
    ];
    // 默认（卡片/侧栏/AI）：全 0 权重退化为等权
    expect(calcOverall(scores, zeroWeights)).toBeCloseTo(7.5, 5);
    // 详情面板：没有正权重维度就没有总评
    expect(calcOverall(scores, zeroWeights, { equalWeightFallback: false })).toBe(0);
  });
});
