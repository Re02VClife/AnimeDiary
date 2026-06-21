/**
 * features/ai-analysis/ai-helpers — 各 Skill 共享的内部工具函数
 */
import type { AnimeEntry } from '../../src/types';
import { DEFAULT_DIMENSIONS } from '../../src/types';

/** 获取番剧某维度的分数 */
export function getScore(a: AnimeEntry, dimKey: string): number {
  return a.scores.find((s) => s.dimensionKey === dimKey)?.score ?? 0;
}

/** 计算加权总评（使用 DEFAULT_DIMENSIONS 权重表） */
export function calcOverall(a: AnimeEntry): number {
  let total = 0;
  let totalWeight = 0;
  for (const dim of DEFAULT_DIMENSIONS) {
    if (dim.key === 'overall') continue;
    const s = getScore(a, dim.key);
    if (s > 0) {
      total += s * dim.weight;
      totalWeight += dim.weight;
    }
  }
  return totalWeight > 0 ? total / totalWeight : 0;
}

/**
 * 口味偏差值: (总评 × 0.4 + 电波 × 0.6) - BGM 评分
 * 正值 = 个人偏好高于社区，负值 = 社区评分高于个人
 */
export function calcTasteDeviation(a: AnimeEntry): number | null {
  const bgm = a.bangumiScore;
  if (bgm === undefined || bgm <= 0) return null;
  const overall = getScore(a, 'overall') || calcOverall(a);
  const vibe = getScore(a, 'vibe');
  if (overall <= 0 || vibe <= 0) return null;
  return (overall * 0.4 + vibe * 0.6) - bgm;
}

/** 格式化维度分数为单行文本 */
export function fmtDims(a: AnimeEntry): string {
  return DEFAULT_DIMENSIONS
    .filter((d) => d.key !== 'overall')
    .map((d) => `${d.label}${getScore(a, d.key).toFixed(d.key === 'vibe' ? 2 : 1)}`)
    .join(' ');
}

/** 构建 8 维评分向量（排除 overall） */
export function buildScoreVector(a: AnimeEntry): number[] {
  return DEFAULT_DIMENSIONS
    .filter((d) => d.key !== 'overall')
    .map((d) => getScore(a, d.key));
}
