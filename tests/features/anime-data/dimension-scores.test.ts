// @vitest-environment node
/**
 * buildTemplateScores 单测
 *
 * 这条函数修的是 2026-11-17 用户反馈的两个真实问题：
 *   1. 雷达图里出现 `frameCount` 轴 —— 张数在 Excel 里有列，但不是评分维度；
 *   2. 「音声」和「声音」各一条轴 —— 模板叫音声，AI 那边按旧兜底列表写了声音。
 *
 * 所以这里钉的是「模板维度是权威列表」这个口径：模板里没有的 key 必须消失，
 * 标签必须用模板的。
 */
import { describe, expect, it } from 'vitest'
import { buildTemplateScores } from '../../../features/anime-data/dimension-scores'

const DIMS = [
  { key: 'overall', label: '总评' },
  { key: 'audio', label: '音声' },
  { key: 'production', label: '制作' },
  { key: 'animation', label: '作画' },
  { key: 'plot', label: '剧情' },
]

describe('buildTemplateScores', () => {
  it('按模板维度取分、用模板标签', () => {
    const scores = buildTemplateScores(
      [
        { dimensionKey: 'plot', score: 9 },
        { dimensionKey: 'audio', score: 7.5 },
      ],
      DIMS,
    )
    expect(scores).toEqual({ 剧情: 9, 音声: 7.5 })
  })

  it('frameCount 这类非评分列不会出现在结果里', () => {
    const scores = buildTemplateScores(
      [
        { dimensionKey: 'frameCount', score: 4.5 },
        { dimensionKey: 'plot', score: 8 },
      ],
      DIMS,
    )
    expect(scores).toEqual({ 剧情: 8 })
    expect(scores).not.toHaveProperty('frameCount')
  })

  it('总评（overall）不参与对比 —— 它由其它维度加权算出来', () => {
    expect(buildTemplateScores([{ dimensionKey: 'overall', score: 8.7 }], DIMS)).toEqual({})
  })

  it('0 分 / 非数字 / 没有 dimensionKey 的分数被跳过', () => {
    expect(
      buildTemplateScores(
        [
          { dimensionKey: 'plot', score: 0 },
          { dimensionKey: 'audio', score: Number.NaN },
          { score: 9 },
        ],
        DIMS,
      ),
    ).toEqual({})
  })

  it('自定义模板的维度 key 能取到，标签仍用模板的', () => {
    expect(
      buildTemplateScores([{ dimensionKey: 'dim_玩法', score: 8.2 }], [{ key: 'dim_玩法', label: '玩法' }]),
    ).toEqual({ 玩法: 8.2 })
  })

  it('模板里没有的旧维度（例如改名前的 key）会被自然剔除', () => {
    const scores = buildTemplateScores(
      [{ dimensionKey: 'legacy_sound', score: 9 }],
      DIMS,
    )
    expect(scores).toEqual({})
  })
})
