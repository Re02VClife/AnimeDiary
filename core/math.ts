/**
 * core/math — 数学工具函数
 *   纯函数，零业务耦合，可跨项目复用
 */

/** 计算两个向量的余弦相似度 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** 计算两个 Set 的 Jaccard 相似度 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** 计算两个数组的 Jaccard 相似度（内部转 Set） */
export function jaccardArrays(a: string[], b: string[]): number {
  return jaccardSimilarity(new Set(a), new Set(b));
}

/**
 * 按加权维度计算总评
 * @param scores 维度分数字典 { dimensionKey: score }
 * @param dimensions 维度定义列表（含 key 和 weight），排除 overall
 * @returns 加权总分，无有效分数时返回 0
 */
export function calcOverall(
  scores: Record<string, number>,
  dimensions: { key: string; weight: number }[],
): number {
  let total = 0;
  let totalWeight = 0;
  for (const dim of dimensions) {
    if (dim.key === 'overall') continue;
    const s = scores[dim.key] ?? 0;
    if (s > 0) {
      total += s * dim.weight;
      totalWeight += dim.weight;
    }
  }
  return totalWeight > 0 ? total / totalWeight : 0;
}
