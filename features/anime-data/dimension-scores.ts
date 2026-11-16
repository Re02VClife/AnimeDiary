/**
 * features/anime-data/dimension-scores — 把 Excel 里的分数整理成「模板维度」
 *
 * 背景（2026-11-17 用户反馈）：AI 影评面板的雷达图里出现了 `frameCount` 这种轴，
 * 还有「音声」和「声音」两条重复轴。原因是喂给面板的用户评分是拿 Excel 的
 * `DimensionScore[]` 直接翻标签的：
 *
 *   - `frameCount`（张数）虽然在 Excel 里有列，但它**不是评分维度**，
 *     在模板里也没有对应项 —— 却因为 `DIMENSION_COL_MAP` 里有它而被带了进去；
 *   - 维度名以 Excel 的为准（音声），而 AI 那边/模板改名后（声音）就对不上，
 *     并集一拼就多出一条轴。
 *
 * 所以这里反过来：**模板维度是权威列表**，Excel 分数只是取值来源。
 * 模板里没有的 key（frameCount、被删掉的旧维度）自动消失；标签用模板的 label。
 *
 * 纯函数，不碰 localStorage —— 模板由调用方传进来（便于单测）。
 */

export interface DimensionScoreLike {
  dimensionKey?: string
  score: number
}

export interface TemplateDimensionLike {
  key: string
  label: string
}

/**
 * @param scores  Excel 读出来的分数（可能含非评分列，如 frameCount）
 * @param dimensions  条目所用模板的维度（`getTemplate(entry.templateId).dimensions`）
 * @returns 维度标签 → 分数；只包含模板里定义、且分数 > 0 的维度
 *
 * `overall`（总评）会被跳过：它是由其它维度加权算出来的，不参与「你的分 vs AI 分」对比，
 * 也不该让模型去评它（模板里 overall 的 weight 是 0）。
 */
export function buildTemplateScores(
  scores: ReadonlyArray<DimensionScoreLike>,
  dimensions: ReadonlyArray<TemplateDimensionLike>,
): Record<string, number> {
  const byKey = new Map<string, number>()
  for (const item of scores) {
    if (!item?.dimensionKey) continue
    if (!Number.isFinite(item.score)) continue
    byKey.set(item.dimensionKey, item.score)
  }

  const out: Record<string, number> = {}
  for (const dimension of dimensions) {
    if (dimension.key === 'overall') continue
    const value = byKey.get(dimension.key)
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      out[dimension.label] = value
    }
  }
  return out
}
