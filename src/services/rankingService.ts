/**
 * 排名计算服务
 *   计算各维度在全体数据中的百分位排名
 */
import type { AnimeEntry, Dimension, DimensionScore } from '../types';
import { DEFAULT_DIMENSIONS } from '../types';

/** 某维度在所有番剧中的分数分布 */
interface DimensionStats {
  /** 所有非零分数（升序排列） */
  allScores: number[];
  /** 分数→排名百分位映射 */
  percentileMap: Map<number, number>;
}

/** 每个维度的统计信息 */
type AllStats = Record<string, DimensionStats>;

/**
 * 构建所有维度的百分位映射
 * @param allAnime 全体番剧列表
 * @returns 维度 → 分数统计
 */
export function buildPercentileMap(allAnime: AnimeEntry[]): AllStats {
  const stats: AllStats = {};

  // 从数据中动态收集所有维度的分数（不再硬编码 DEFAULT_DIMENSIONS）
  const dimScores: Record<string, number[]> = {};

  for (const anime of allAnime) {
    for (const score of anime.scores) {
      if (!dimScores[score.dimensionKey]) dimScores[score.dimensionKey] = [];
      if (score.score > 0) {
        dimScores[score.dimensionKey].push(score.score);
      }
    }
  }

  // 排序并计算百分位
  for (const [dimKey, scores] of Object.entries(dimScores)) {
    scores.sort((a, b) => a - b);
    const n = scores.length;
    const percentileMap = new Map<number, number>();

    for (let i = 0; i < n; i++) {
      const percentile = n > 1 ? Math.round((i / (n - 1)) * 100) : 50;
      // 相同分数取最高百分位
      const existing = percentileMap.get(scores[i]);
      if (existing === undefined || percentile > existing) {
        percentileMap.set(scores[i], percentile);
      }
    }

    stats[dimKey] = { allScores: scores, percentileMap };
  }

  return stats;
}

/**
 * 计算某部番各维度的百分位排名
 * @param anime 目标番剧
 * @param stats 全体统计（由 buildPercentileMap 生成）
 * @returns 维度 → 百分位 (0-100)
 */
export function getPercentileScores(
  anime: AnimeEntry,
  stats: AllStats,
  dimensions?: Dimension[],
): { dimensionKey: string; label: string; percentile: number; rawScore: number }[] {
  const result: { dimensionKey: string; label: string; percentile: number; rawScore: number }[] = [];
  const dims = dimensions || DEFAULT_DIMENSIONS;

  for (const dim of dims) {
    const score = anime.scores.find((s) => s.dimensionKey === dim.key);
    const rawScore = score?.score ?? 0;

    let percentile = 0;
    if (rawScore > 0 && stats[dim.key]) {
      percentile = stats[dim.key].percentileMap.get(rawScore) ?? 0;
    }

    result.push({
      dimensionKey: dim.key,
      label: dim.label,
      percentile,
      rawScore,
    });
  }

  return result;
}

/**
 * 按指定维度降序排列番剧
 * @param allAnime 全体番剧列表
 * @param dimKey 维度 key
 * @returns 排序后的列表（仅包含有该维度分数的条目）
 */
export function rankByDimension(allAnime: AnimeEntry[], dimKey: string): AnimeEntry[] {
  return [...allAnime]
    .filter((a) => a.scores.some((s) => s.dimensionKey === dimKey && s.score > 0))
    .sort((a, b) => {
      const sa = a.scores.find((s) => s.dimensionKey === dimKey)?.score ?? 0;
      const sb = b.scores.find((s) => s.dimensionKey === dimKey)?.score ?? 0;
      return sb - sa; // 降序
    });
}

/**
 * 获取指定维度的前N名
 */
export function getTopN(allAnime: AnimeEntry[], dimKey: string, n: number = 10): AnimeEntry[] {
  return rankByDimension(allAnime, dimKey).slice(0, n);
}
