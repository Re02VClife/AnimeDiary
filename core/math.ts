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
 * 统一保留两位小数。
 * Excel 的公式列（赋分/综合/电波/偏差/较客观评分）算出来常带浮点噪声，
 * 例如 7.500000000000001、9.72000000000004，读进来会原样显示在维度评分输入框里。
 * 数据入口和写回出口都收敛到两位小数。
 */
export function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  // 先按数量级补一个极小的偏移，抵消 8.935 → 8.934999999999999 这类表示误差
  const nudged = n * 100 + (n >= 0 ? 1e-6 : -1e-6);
  return Math.round(nudged) / 100;
}

/**
 * 分数字符串：最多两位小数、不补零（9.72 / 9.6 / 10）。
 * 未评分（0 / 空 / 非法）返回 empty，默认 '-'。
 */
export function formatScore(n: number | undefined | null, empty = '-'): string {
  if (n === undefined || n === null || !Number.isFinite(n) || n <= 0) return empty;
  return String(round2(n));
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
  return totalWeight > 0 ? round2(total / totalWeight) : 0;
}