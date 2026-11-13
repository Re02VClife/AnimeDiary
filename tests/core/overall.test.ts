import { describe, it, expect } from 'vitest';
import { calcOverall } from '../../core/overall';
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
