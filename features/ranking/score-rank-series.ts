/**
 * score-rank-series — 页面底部「评分 · 名次」折线图的数据构建
 *
 * 把「番剧列表 + 模板维度表」摊平成**每个维度一条 series**：
 *   - x = 名次（该维度分数从高到低，1-based）
 *   - y = 分数
 * 三条取分口径在这里收敛，避免散进渲染层：
 *   - 总评       → 外部注入 overallOf（唯一实现是 core/overall 的 calcEntryOverall）
 *   - BGM        → anime.bangumiScore（外部分数，不是模板维度）
 *   - 其余维度   → anime.scores[].dimensionKey
 *
 * 与 `ranking-service.ts` 的分工：那边算的是「百分位排名」这类**会被展示成名次数字**的口径；
 * 这里只为画图算「这一维度排第几位」，不产出任何排名结论，别拿去显示名次。
 */
import type { AnimeEntry, Dimension } from '../../src/types';

/** 图表里 BGM 那一条线的 key（不是模板维度，避免和用户自定义维度撞名） */
export const BGM_DIM_KEY = 'bgm';
/** BGM 系列显示名 */
export const BGM_DIM_LABEL = 'BGM';

/** 一个点 = 一部番在某个维度上的名次与分数 */
export interface ScoreRankPoint {
  /** 对应 AnimeEntry.id，点击时用它找回条目 */
  animeId: string;
  title: string;
  /** 0–10（个别外部分数可能略超 10，图里不做截断） */
  score: number;
  /** 1-based 名次；同分按传入列表顺序，不做并列名次（否则多个点会叠在同一个 x 上） */
  rank: number;
}

/** 一条线 = 一个维度 */
export interface ScoreRankSeries {
  /** 维度 key；BGM 为 BGM_DIM_KEY */
  key: string;
  label: string;
  /** 已按分数降序；rank 严格 1..N */
  points: ScoreRankPoint[];
}

export interface BuildScoreRankOptions {
  /**
   * 总评取值函数。不给则**跳过**总评维度（宁可不画，也不凭空造一条 0 分线）。
   * 应用内传 `(a) => calcEntryOverall(a, getTemplateDimensions)`。
   */
  overallOf?: (anime: AnimeEntry) => number;
  /** 是否附带 BGM 一条线（来自 bangumiScore），默认 true */
  includeBgm?: boolean;
  /**
   * 只保留这些维度 key（按 dimensions 的顺序输出，不按本数组顺序）。
   * 用于面板上的维度开关；不给 = 全部。
   */
  onlyKeys?: readonly string[];
}

/**
 * 取某条番在某个维度上的分数；0 / 缺失 / 非法一律视为「没有这个分数」。
 *
 * 0 视为未评分是全项目共识（见 core/math 的 formatScore）：
 * 把它当成真实分数会让名次表底部挤满 0 分的条目。
 */
function scoreOf(
  anime: AnimeEntry,
  key: string,
  overallOf?: (anime: AnimeEntry) => number,
): number | null {
  let raw = 0;
  if (key === 'overall') {
    if (!overallOf) return null;
    raw = overallOf(anime);
  } else if (key === BGM_DIM_KEY) {
    raw = anime.bangumiScore ?? 0;
  } else {
    raw = anime.scores.find((s) => s.dimensionKey === key)?.score ?? 0;
  }
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return raw;
}

/**
 * 构建各维度名次序列。
 *
 * @param animeList 当前网格里的条目（已按分类/标签/搜索筛过），顺序即同分时的先后
 * @param dimensions 模板维度表（含 overall；BGM 不在里面，由 includeBgm 控制）
 */
export function buildScoreRankSeries(
  animeList: AnimeEntry[],
  dimensions: Dimension[],
  options: BuildScoreRankOptions = {},
): ScoreRankSeries[] {
  const { overallOf, includeBgm = true, onlyKeys } = options;

  const defs: { key: string; label: string }[] = [];
  for (const dim of dimensions) {
    // 防御：模板里若有人手写了 key='bgm'，让外部分数那条线优先，避免两条同名序列
    if (dim.key === BGM_DIM_KEY) continue;
    if (dim.key === 'overall' && !overallOf) continue;
    defs.push({ key: dim.key, label: dim.label });
  }
  if (includeBgm) defs.push({ key: BGM_DIM_KEY, label: BGM_DIM_LABEL });

  const wanted = onlyKeys ? new Set(onlyKeys) : null;
  const picked = wanted ? defs.filter((d) => wanted.has(d.key)) : defs;

  const result: ScoreRankSeries[] = [];
  for (const def of picked) {
    const collected: { anime: AnimeEntry; score: number }[] = [];
    for (const anime of animeList) {
      const score = scoreOf(anime, def.key, overallOf);
      if (score !== null) collected.push({ anime, score });
    }
    if (collected.length === 0) continue;

    // Array.prototype.sort 在 ES2019+ 是稳定排序：同分保持网格顺序，名次可复现
    collected.sort((a, b) => b.score - a.score);

    result.push({
      key: def.key,
      label: def.label,
      points: collected.map((item, index) => ({
        animeId: item.anime.id,
        title: item.anime.title,
        score: item.score,
        rank: index + 1,
      })),
    });
  }

  return result;
}

/** 图里最长的一条序列有多少个点（用于定 x 轴上界、点大小和是否播动画） */
export function maxRank(series: ScoreRankSeries[]): number {
  let n = 0;
  for (const s of series) if (s.points.length > n) n = s.points.length;
  return n;
}
