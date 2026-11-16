// @vitest-environment node
/**
 * review-fanout 的纯函数单测：分集 prompt / 小结解析 / 汇总 prompt
 *
 * 这条链路的风险和单次影评不同：**坏掉的一集会让整季悄悄少一集**。
 * 所以解析必须"宁可返回 null"（调用方记失败），prompt 必须把边界写死：
 * 子任务只能看这一集、汇总只能拿到文字、维度只能用模板那几个。
 */
import { describe, expect, it } from 'vitest'
import {
  buildEpisodeBriefPrompt,
  buildSeriesSummaryPrompt,
  parseEpisodeBrief,
} from '../../../plugins/watch-analysis/server/review-fanout'

describe('buildEpisodeBriefPrompt', () => {
  it('只给这一集的素材，并要求结构化小结（不是完整影评）', () => {
    const { system, prompt } = buildEpisodeBriefPrompt({
      title: '测试番',
      episode: 3,
      duration: 1440,
      shots: 500,
      cuts: 498,
      sheetCount: 12,
      shotLines: ['  #0 00:00–00:12'],
      dialogueLines: ['  [00:12] S01: 台词'],
      danmakuLines: [],
      userScores: '剧情 8 / 作画 7.5',
      dimensions: ['剧情', '作画', '音声'],
    })

    expect(system).toContain('单集')
    expect(system).toContain('只评你有把握的维度')
    expect(prompt).toContain('E3')
    expect(prompt).toContain('"points"')
    expect(prompt).toContain('剧情 8 / 作画 7.5')
    // 维度白名单必须真的写进 prompt（否则模型会自己编维度）
    expect(prompt).toContain('剧情 / 作画 / 音声')
    // 子任务不该被要求写整篇正文
    expect(prompt).not.toContain('"markdown"')
  })
})

describe('parseEpisodeBrief', () => {
  it('解析正常 JSON，保留时间码与初评', () => {
    const brief = parseEpisodeBrief(
      JSON.stringify({
        episode: 2,
        points: ['[00:12] 第一次切镜', '[03:40] 回忆段'],
        scores: [{ dimension: '剧情', value: 8.2, reason: '开场干净' }],
        quotes: ['原话'],
        caveats: ['听不到音频'],
      }),
      2,
    )
    expect(brief).not.toBeNull()
    expect(brief?.episode).toBe(2)
    expect(brief?.points).toHaveLength(2)
    expect(brief?.scores[0]).toMatchObject({ dimension: '剧情', value: 8.2 })
    expect(brief?.caveats).toContain('听不到音频')
  })

  it('能从 ```json 代码块里抠出来（模型常包一层）', () => {
    const brief = parseEpisodeBrief(
      '```json\n{"episode":1,"points":["[00:05] 开场"],"scores":[],"quotes":[],"caveats":[]}\n```',
      1,
    )
    expect(brief?.points).toEqual(['[00:05] 开场'])
  })

  it('points 和 scores 都空 → null（不把空小结喂给汇总）', () => {
    expect(parseEpisodeBrief('{"episode":1,"points":[],"scores":[],"quotes":[],"caveats":[]}', 1)).toBeNull()
  })

  it('坏 JSON 返回 null，不抛错', () => {
    expect(parseEpisodeBrief('这不是 json', 1)).toBeNull()
    expect(parseEpisodeBrief('{"points": [', 1)).toBeNull()
  })

  it('分数被夹在 0–10，非法条目丢弃', () => {
    const brief = parseEpisodeBrief(
      JSON.stringify({
        episode: 1,
        points: [],
        scores: [
          { dimension: '剧情', value: 99 },
          { dimension: '', value: 8 },
          { dimension: '作画', value: 'abc' },
        ],
      }),
      1,
    )
    expect(brief?.scores).toHaveLength(1)
    expect(brief?.scores[0].value).toBe(10)
  })
})

describe('buildSeriesSummaryPrompt', () => {
  it('包含每集小结与维度白名单，并约束时间轴只能引用这些集', () => {
    const { system, prompt } = buildSeriesSummaryPrompt({
      title: '测试番',
      episodeRange: 'E1–E2（2 集）',
      briefs: [
        { episode: 1, points: ['[00:12] 切镜'], scores: [{ dimension: '剧情', value: 8 }], quotes: ['原话'], caveats: [] },
        { episode: 2, points: ['[00:30] 回忆'], scores: [{ dimension: '作画', value: 7 }], quotes: [], caveats: ['听不到音频'] },
      ],
      userScores: '剧情 8',
      stats: { episodes: 2, shots: 1000, sheets: 24 },
      episodes: [1, 2],
      dimensions: ['剧情', '作画', '音声'],
    })

    expect(system).toContain('整季')
    expect(system).toContain('不要假装看过画面')
    expect(prompt).toContain('E1：')
    expect(prompt).toContain('[00:12] 切镜')
    expect(prompt).toContain('E1、E2')
    expect(prompt).toContain('剧情 / 作画 / 音声')
    // 汇总这一步不该要求引用分镜（没有图）
    expect(prompt).not.toContain('{{sheet:')
  })
})
