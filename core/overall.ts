/**
 * core/overall — 维度加权总评（唯一实现）
 *
 * 这段逻辑曾经由 AnimeGrid / Sidebar / AnimeDetailModal / features/ai-analysis/ai-helpers
 * 各抄一份（改一处漏两处就会「卡片和侧栏分数对不上」，AI 分析算出来的总评也会偏）。
 * 现在只有这里一份：
 *   - calcOverall(scores, dimensions)          —— 算法本体，传维度表；
 *   - calcEntryOverall(entry, resolveDims)     —— 条目级封装，维度来源固定是条目所属模板。
 *
 * 规则：
 *   1. 剔除 key === 'overall' 的维度 —— 总评本身不是可打分维度；
 *   2. 有任一维度权重 > 0 时，只按有权重的维度加权；
 *   3. 全部权重为 0（或模板没配权重）时退化为等权重（见 CalcOverallOptions）；
 *   4. 0 分视为「未评分」，不参与加权（否则会拉低平均）。
 *
 * ⚠️ 维度来源必须是条目所属模板：`getTemplate(entry.templateId).dimensions`
 *    —— `getTemplate(undefined)` 本来就会回退用户默认模板。**不要**写
 *    `t ? getTemplate(tid) : DEFAULT_DIMENSIONS`：番剧条目的 templateId 是 undefined，
 *    那样写会绕过用户改过的权重、退回代码里硬编码的 DEFAULT_DIMENSIONS ——
 *    正是 1.0.47 修掉的「两个总评」bug（HANDOVER §6.1）。
 */
import type { AnimeEntry, Dimension, DimensionScore } from '../src/types';

/**
 * 模板 ID → 该模板的维度表。
 *
 * core 是纯函数层、不碰 localStorage，所以「模板怎么取」由调用方注入：
 * 应用内一律传 `features/anime-data/template-service` 的 getTemplateDimensions
 * （它内部 getTemplate 已包含「未知/缺省 → 用户默认模板」的回退）。
 */
export type DimensionResolver = (templateId: string | undefined) => Dimension[];

export interface CalcOverallOptions {
  /**
   * 模板里一个正权重维度都没有时，是否退化为等权平均。
   *
   * 默认 true —— 网格卡片 / 侧栏排行 / AI 分析的口径（全部权重为 0 时按等权算，
   * 至少还能给出一个数）。详情面板传 false：它历史上在「模板没配权重」时显示「-」，
   * 不凭空造一个等权平均。两处只在权重全 0 的异常配置下才有分歧，正常模板完全一致。
   */
  equalWeightFallback?: boolean;
}

export function calcOverall(
  scores: DimensionScore[],
  dimensions: Dimension[],
  options: CalcOverallOptions = {},
): number {
  const { equalWeightFallback = true } = options;
  const allDims = dimensions.filter((d) => d.key !== 'overall');
  if (allDims.length === 0) return 0;

  const hasWeights = allDims.some((d) => d.weight > 0);
  const effectiveDims: Dimension[] = hasWeights
    ? allDims.filter((d) => d.weight > 0)
    : equalWeightFallback
      ? allDims.map((d) => ({ ...d, weight: 1 / allDims.length }))
      : [];

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

/**
 * 条目级总评：维度来源固定是「该条目所属模板」，避免每个调用方自行决定
 * 用哪张维度表 / 怎么回退（那正是口径漂移的来源）。
 *
 * 调用方只需要给解析器，不要自己拼 `getTemplate(...).dimensions`：
 * 漏掉 `.dimensions` 或换成 DEFAULT_DIMENSIONS 都会让数值悄悄变掉。
 */
export function calcEntryOverall(
  entry: Pick<AnimeEntry, 'scores' | 'templateId'>,
  resolveDimensions: DimensionResolver,
  options?: CalcOverallOptions,
): number {
  return calcOverall(entry.scores, resolveDimensions(entry.templateId), options);
}
