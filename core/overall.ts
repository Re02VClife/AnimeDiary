/**
 * core/overall — 维度加权总评
 *
 * 这段逻辑原本由 AnimeGrid / Sidebar / AnimeContext 各抄一份（三处必须一致，
 * 改一处漏两处就会「卡片和侧栏分数对不上」）。现在集中在这里：
 * 新增使用方（比如 Bangumi 上传）直接调用，不再产生第 N 份副本。
 *
 * 规则：
 *   1. 剔除 key === 'overall' 的维度 —— 总评本身不是可打分维度；
 *   2. 有任一维度权重 > 0 时，只按有权重的维度加权；
 *   3. 全部权重为 0（或模板没配权重）时退化为等权重；
 *   4. 0 分视为「未评分」，不参与加权（否则会拉低平均）。
 */
import type { Dimension, DimensionScore } from '../src/types';

export function calcOverall(scores: DimensionScore[], dimensions: Dimension[]): number {
  const allDims = dimensions.filter((d) => d.key !== 'overall');
  if (allDims.length === 0) return 0;

  const hasWeights = allDims.some((d) => d.weight > 0);
  const effectiveDims = hasWeights
    ? allDims.filter((d) => d.weight > 0)
    : allDims.map((d) => ({ ...d, weight: 1 / allDims.length }));

  let tw = 0;
  let ws = 0;
  for (const d of effectiveDims) {
    const s = scores.find((sc) => sc.dimensionKey === d.key)?.score ?? 0;
    if (s > 0) {
      ws += s * d.weight;
      tw += d.weight;
    }
  }
  return tw > 0 ? ws / tw : 0;
}
