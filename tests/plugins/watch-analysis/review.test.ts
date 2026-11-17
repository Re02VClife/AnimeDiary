/**
 * server/review — AI 影评生成单测
 *
 * 这层的风险是「静默产出坏数据」：模型编时间码、编不存在的分镜、
 * 或者我们替换占位符时拼出破图 —— 用户看到的是一篇看起来正常的影评，
 * 实际上引用全是假的。所以这里把「编造怎么被挡掉」逐条钉住。
 *
 * 不真的调模型：`describe` 是注入的，测试里直接返回构造好的 JSON。
 */
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createWatchStore } from '../../../plugins/watch-analysis/server/store'
import { createReviewStore } from '../../../plugins/watch-analysis/server/review-store'
import { createReviewGenerator, REVIEW_PROMPT_VERSION } from '../../../plugins/watch-analysis/server/review'
import type { WatchReport } from '../../../plugins/watch-analysis/core/types'
import type { DescribeResult } from '../../../plugins/watch-analysis/server/review'

/** 1×1 透明 PNG —— 只要是个能被当图片读的文件就够（内容不重要） */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

let dir: string
const KEY = '模板::测试番'

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-review-test-'))
})

afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

function makeReport(episode = 1, overrides: Partial<WatchReport> = {}): WatchReport {
  return {
    schema: 1,
    key: KEY,
    episode,
    video: { file: `D:/anime/ep0${episode}.mkv`, duration: 1440, fps: 23.976, width: 1920, height: 1080 },
    engine: { storyboard: 'dsh-video-storyboard', cut: 'hsv', transcript: 'none', motion: 'none', music: 'none' },
    shots: [
      { i: 0, start: 0, end: 12, sampled: false, tier: 2 },
      { i: 1, start: 12, end: 30, sampled: false, tier: 2, text: '这是台词' },
    ],
    cuts: [{ t: 12, score: 120, engine: 'hsv' }],
    sheets: [{ file: `ep0${episode}.png`, width: 800, height: 450, cells: 2, shots: [0, 1] }],
    budget: { limit: 2_000_000, spent: 0, byKind: {}, reserved: 0, exhausted: false },
    timing: { total: 10 },
    created: new Date().toISOString(),
    appVersion: '1.3.26',
    ...overrides,
  }
}

/** 造一份报告 + 它引用的 PNG 文件（review 要真的去读图） */
function seedReport(episode = 1, overrides: Partial<WatchReport> = {}) {
  const store = createWatchStore(dir)
  const report = makeReport(episode, overrides)
  store.write(report)
  const sheetDir = store.sheetDir(KEY, episode)
  fs.mkdirSync(sheetDir, { recursive: true })
  for (const sheet of report.sheets) fs.writeFileSync(path.join(sheetDir, sheet.file), TINY_PNG)
  return { store, report }
}

/** 模型输出：一份结构完整但故意混了「编造内容」的 JSON */
function modelJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    scores: [
      { dimension: '剧情', value: 7.8, reason: '第 12 秒的转场干净利落', evidence: [{ episode: 1, t: 12, note: '切镜' }] },
      { dimension: '作画', value: 6.2, reason: '平涂为主', evidence: [] },
    ],
    markdown: '开场用一个干净的切换进入正题 {{sheet:ep01.png}}，到 [00:12] 已经交代完背景。',
    timeline: [
      { episode: 1, t: 12, text: '第一次切镜', shot: 1 },
      // 越界：超出 1440 秒，必须被丢掉
      { episode: 1, t: 9999, text: '不存在的时间点', shot: 0 },
      // 越界：没分析过的集
      { episode: 9, t: 30, text: '不存在的一集' },
    ],
    citations: [
      { episode: 1, sheet: 'ep01.png', cell: 2 },
      // 不存在的分镜，必须被丢掉
      { episode: 1, sheet: 'ep99.png' },
    ],
    spoiler: '结局那句 {{sheet:ep01.png}} 是伏笔。',
    caveats: ['这是一次测试'],
    ...overrides,
  })
}

function makeGenerator(opts: {
  describe?: (req: any) => Promise<DescribeResult>
  store: ReturnType<typeof createWatchStore>
  reviewStore: ReturnType<typeof createReviewStore>
  /** 当前模型名（缓存判定用）；不传 = 不比较 */
  currentModel?: () => string | undefined
}) {
  const describeMock = vi.fn(opts.describe ?? (async () => ({
    text: modelJson(),
    usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
    model: 'fake-vision-model',
  })))
  const generator = createReviewGenerator({
    store: opts.store,
    reviewStore: opts.reviewStore,
    appVersion: '1.3.26',
    describe: describeMock,
    ...(opts.currentModel ? { currentModel: opts.currentModel } : {}),
  })
  return { generator, describeMock }
}

describe('createReviewGenerator', () => {
  it('没有任何报告时明确报错，而不是产出一篇空影评', async () => {
    const store = createWatchStore(dir)
    const reviewStore = createReviewStore(dir)
    const { generator, describeMock } = makeGenerator({ store, reviewStore })
    await expect(generator.generate({ key: KEY, scope: { kind: 'series' } }))
      .rejects.toThrow(/还没有任何一集的拉片分析/)
    expect(describeMock).not.toHaveBeenCalled()
  })

  it('正常生成：结构完整、tokens 记账、promptVersion 落盘', async () => {
    const { store } = seedReport(1)
    const reviewStore = createReviewStore(dir)
    const { generator } = makeGenerator({ store, reviewStore })

    const { review, cached } = await generator.generate({ key: KEY, scope: { kind: 'series' } })
    expect(cached).toBe(false)
    expect(review.schema).toBe(1)
    expect(review.key).toBe(KEY)
    expect(review.model).toBe('fake-vision-model')
    expect(review.promptVersion).toBe(REVIEW_PROMPT_VERSION)
    expect(review.tokens).toBe(1500)
    expect(review.scores).toHaveLength(2)
    expect(review.scores[0].dimension).toBe('剧情')
    expect(review.inputs.episodes).toEqual([1])
    expect(review.inputs.sheets).toBe(1)
  })

  it('分镜占位符被替换成可用的图片 URL（key 里的中文/冒号要编码）', async () => {
    const { store } = seedReport(1)
    const reviewStore = createReviewStore(dir)
    const { generator } = makeGenerator({ store, reviewStore })
    const { review } = await generator.generate({ key: KEY, scope: { kind: 'series' } })

    expect(review.markdown).toContain('![E1 分镜]')
    expect(review.markdown).toContain('/api/watch/sheet?')
    expect(review.markdown).toContain('file=ep01.png')
    // 原始占位符不能漏到用户面前
    expect(review.markdown).not.toContain('{{sheet:')
    // key 必须被编码（含中文和 `::`）
    expect(review.markdown).toContain('%3A%3A')
  })

  it('引用不存在的分镜 → 降级成纯文本，不产出破图', async () => {
    const { store } = seedReport(1)
    const reviewStore = createReviewStore(dir)
    const json = modelJson({ markdown: '看这张 {{sheet:ep99.png}}' })
    const { generator } = makeGenerator({
      store,
      reviewStore,
      describe: async () => ({ text: json, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, model: 'm' }),
    })
    const { review } = await generator.generate({ key: KEY, scope: { kind: 'series' } })
    expect(review.markdown).toBe('看这张 [分镜 ep99.png]')
    expect(review.markdown).not.toContain('![')
  })

  it('越界的时间码被丢掉，并在 caveats 里如实说明', async () => {
    const { store } = seedReport(1)
    const reviewStore = createReviewStore(dir)
    const { generator } = makeGenerator({ store, reviewStore })
    const { review } = await generator.generate({ key: KEY, scope: { kind: 'series' } })

    // 原始给了 3 条，只有 1 条合法
    expect(review.timeline).toHaveLength(1)
    expect(review.timeline[0]).toMatchObject({ episode: 1, t: 12, text: '第一次切镜', shot: 1 })
    expect(review.caveats?.some((c) => c.includes('2 条时间码越界已丢弃'))).toBe(true)
  })

  it('不存在的分镜引用被丢掉，不写进 citations', async () => {
    const { store } = seedReport(1)
    const reviewStore = createReviewStore(dir)
    const { generator } = makeGenerator({ store, reviewStore })
    const { review } = await generator.generate({ key: KEY, scope: { kind: 'series' } })
    expect(review.citations).toEqual([{ episode: 1, sheet: 'ep01.png', cell: 2 }])
  })

  it('没有证据的分数保留，但必须进 caveats（产品要求：不许假装有证据）', async () => {
    const { store } = seedReport(1)
    const reviewStore = createReviewStore(dir)
    const { generator } = makeGenerator({ store, reviewStore })
    const { review } = await generator.generate({ key: KEY, scope: { kind: 'series' } })
    const noEvidence = review.scores.find((s) => s.dimension === '作画')
    expect(noEvidence?.evidence).toEqual([])
    expect(review.caveats?.some((c) => c.includes('没有给出证据'))).toBe(true)
  })

  it('分数被夹在 0–10 之间（模型给 15 也不许漏出去）', async () => {
    const { store } = seedReport(1)
    const reviewStore = createReviewStore(dir)
    const json = modelJson({
      scores: [{ dimension: '剧情', value: 15, reason: 'x', evidence: [] }],
    })
    const { generator } = makeGenerator({
      store,
      reviewStore,
      describe: async () => ({ text: json, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, model: 'm' }),
    })
    const { review } = await generator.generate({ key: KEY, scope: { kind: 'series' } })
    expect(review.scores[0].value).toBe(10)
  })

  it('缓存：同一 scope 第二次直接返回旧结果，不再调模型', async () => {
    const { store } = seedReport(1)
    const reviewStore = createReviewStore(dir)
    const { generator, describeMock } = makeGenerator({ store, reviewStore })

    await generator.generate({ key: KEY, scope: { kind: 'series' } })
    const second = await generator.generate({ key: KEY, scope: { kind: 'series' } })
    expect(second.cached).toBe(true)
    expect(describeMock).toHaveBeenCalledTimes(1)
  })

  it('force 会重新生成并覆盖', async () => {
    const { store } = seedReport(1)
    const reviewStore = createReviewStore(dir)
    const { generator, describeMock } = makeGenerator({ store, reviewStore })

    const first = await generator.generate({ key: KEY, scope: { kind: 'series' } })
    const second = await generator.generate({ key: KEY, scope: { kind: 'series' }, options: { force: true } })
    expect(second.cached).toBe(false)
    expect(describeMock).toHaveBeenCalledTimes(2)
    // 第二次的 created 一定更晚（或相等但不同次生成）
    expect(second.review.created >= first.review.created).toBe(true)
  })

  it('单集 scope 只喂这一集的报告', async () => {
    seedReport(1)
    const { store } = seedReport(2)
    const reviewStore = createReviewStore(dir)
    const { generator, describeMock } = makeGenerator({ store, reviewStore })

    const { review } = await generator.generate({ key: KEY, scope: { kind: 'episode', episode: 2 } })
    expect(review.scope).toEqual({ kind: 'episode', episode: 2 })
    expect(review.inputs.episodes).toEqual([2])
    // 提示词里只该出现 E2
    const prompt: string = describeMock.mock.calls[0][0].prompt
    expect(prompt).toContain('【范围】第 2 集')
    expect(prompt).not.toContain('E1：')
  })

  it('模型返回非 JSON 时明确报错（不落盘半成品）', async () => {
    const { store } = seedReport(1)
    const reviewStore = createReviewStore(dir)
    const { generator } = makeGenerator({
      store,
      reviewStore,
      describe: async () => ({ text: '抱歉我无法完成这个任务', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, model: 'm' }),
    })
    await expect(generator.generate({ key: KEY, scope: { kind: 'series' } }))
      .rejects.toThrow(/没有返回合法 JSON/)
    expect(reviewStore.read(KEY, { kind: 'series' })).toBeNull()
  })

  it('模型返回 JSON 但没正文时也报错', async () => {
    const { store } = seedReport(1)
    const reviewStore = createReviewStore(dir)
    const { generator } = makeGenerator({
      store,
      reviewStore,
      describe: async () => ({
        text: JSON.stringify({ scores: [], markdown: '' }),
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: 'm',
      }),
    })
    await expect(generator.generate({ key: KEY, scope: { kind: 'series' } }))
      .rejects.toThrow(/没有影评正文/)
  })

  it('默认盲评：用户评分 / 评价不进提示词（否则 AI 会顺着用户说话）', async () => {
    const { store } = seedReport(1)
    const reviewStore = createReviewStore(dir)
    const { generator, describeMock } = makeGenerator({ store, reviewStore })

    await generator.generate({
      key: KEY,
      scope: { kind: 'series' },
      userContext: { title: '测试番', scores: { 剧情: 8.5 }, review: '我觉得节奏很好', tags: ['治愈'] },
    })
    const prompt: string = describeMock.mock.calls[0][0].prompt
    const system: string = describeMock.mock.calls[0][0].system
    expect(prompt).not.toContain('剧情 8.5')
    expect(prompt).not.toContain('我觉得节奏很好')
    expect(prompt).not.toContain('治愈')
    expect(prompt).toContain('盲评')
    expect(system).toContain('独立判断')
  })

  it('显式关闭盲评时，用户上下文会进提示词（评分对比是产品核心）', async () => {
    const { store } = seedReport(1)
    const reviewStore = createReviewStore(dir)
    const { generator, describeMock } = makeGenerator({ store, reviewStore })

    await generator.generate({
      key: KEY,
      scope: { kind: 'series' },
      userContext: { title: '测试番', scores: { 剧情: 8.5 }, review: '我觉得节奏很好', tags: ['治愈'] },
      options: { blind: false },
    })
    const prompt: string = describeMock.mock.calls[0][0].prompt
    expect(prompt).toContain('剧情 8.5')
    expect(prompt).toContain('我觉得节奏很好')
    expect(prompt).toContain('治愈')
    expect(prompt).toContain('你的锚点')
  })

  it('图读不到时明确报错，而不是生成一篇"没看过画面"的影评', async () => {
    // 只写报告、不写 PNG
    const store = createWatchStore(dir)
    store.write(makeReport(1))
    const reviewStore = createReviewStore(dir)
    const { generator, describeMock } = makeGenerator({ store, reviewStore })
    await expect(generator.generate({ key: KEY, scope: { kind: 'series' } }))
      .rejects.toThrow(/任何分镜图/)
    expect(describeMock).not.toHaveBeenCalled()
  })

  it('options.episodes 收窄参与生成的集（配置页的勾选不能白传）', async () => {
    seedReport(1)
    const { store } = seedReport(2)
    const reviewStore = createReviewStore(dir)
    const { generator, describeMock } = makeGenerator({ store, reviewStore })

    const { review } = await generator.generate({
      key: KEY,
      scope: { kind: 'series' },
      options: { episodes: [2] },
    })
    expect(review.inputs.episodes).toEqual([2])
    // 提示词里不该出现没勾选的 E1
    const prompt: string = describeMock.mock.calls[0][0].prompt
    expect(prompt).not.toContain('E1：')
    expect(prompt).toContain('E2：')
  })

  it('options.episodes 全是没分析过的集时明确报错', async () => {
    const { store } = seedReport(1)
    const reviewStore = createReviewStore(dir)
    const { generator } = makeGenerator({ store, reviewStore })
    await expect(generator.generate({
      key: KEY,
      scope: { kind: 'series' },
      options: { episodes: [99] },
    })).rejects.toThrow(/勾选的集都还没有做过拉片分析/)
  })

  it('同一张分镜图在正文里只插一次（模型常连着引用同一张图的几个格子）', async () => {
    const { store } = seedReport(1)
    const reviewStore = createReviewStore(dir)
    const json = modelJson({
      markdown: '看 {{sheet:ep01.png:2}}，然后 {{sheet:ep01.png:5}}，再看 {{sheet:ep01.png}}。',
    })
    const { generator } = makeGenerator({
      store,
      reviewStore,
      describe: async () => ({ text: json, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, model: 'm' }),
    })
    const { review } = await generator.generate({ key: KEY, scope: { kind: 'series' } })

    // 三次引用同一张图 → 只渲染一次，其余降级成「（见上图）」
    expect((review.markdown.match(/!\[/g) ?? [])).toHaveLength(1)
    expect((review.markdown.match(/（见上图）/g) ?? [])).toHaveLength(2)
  })

  it('模型漏写扩展名时也要能匹配到图（实测 2×3 换成 .jpg 后整篇没插进图）', async () => {
    const { store } = seedReport(1)
    const reviewStore = createReviewStore(dir)
    // 报告的 sheet 叫 ep01.png，模型写的是不带后缀的 ep01
    const json = modelJson({ markdown: '看 {{sheet:ep01}} 和 {{sheet:ep01:3}}。' })
    const { generator } = makeGenerator({
      store,
      reviewStore,
      describe: async () => ({ text: json, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, model: 'm' }),
    })
    const { review } = await generator.generate({ key: KEY, scope: { kind: 'series' } })
    expect(review.markdown).toContain('![E1 分镜]')
    expect(review.markdown).toContain('file=ep01.png')
    // 第一处成功匹配后第二处去重
    expect(review.markdown).toContain('（见上图）')
  })

  it('台词要进提示词（带说话人编号），没台词时不要出现这一节', async () => {
    const { store } = seedReport(1, {
      transcript: {
        source: 'asr-moss',
        segments: [
          { start: 12, end: 14, text: '这句是主角说的', source: 'asr-moss', speaker: 'S01' },
          { start: 20, end: 22, text: '这句没编号', source: 'asr-moss' },
        ],
        speakers: 1,
      },
    })
    const reviewStore = createReviewStore(dir)
    const { generator, describeMock } = makeGenerator({ store, reviewStore })

    await generator.generate({ key: KEY, scope: { kind: 'series' } })
    const prompt: string = describeMock.mock.calls[0][0].prompt
    // 台词是影评最硬的证据，之前只统计条数却没喂给模型
    expect(prompt).toContain('【台词（字幕文件或本地 ASR，同音字可能有错）】')
    expect(prompt).toContain('S01: 这句是主角说的')
    // 没编号的照常给，绝不补一个假编号（说明文字里提过 S01/S02，所以只查带冒号的台词行）
    expect(prompt).toContain('这句没编号')
    expect(prompt).not.toContain('S02:')
    // 说话人编号不是角色名，提示词要明说，否则模型会自己安名字
    expect(prompt).toContain('编号本身不是角色名')
  })

  it('没有台词的报告不该让提示词里出现空台词小节', async () => {
    const { store } = seedReport(1)
    const reviewStore = createReviewStore(dir)
    const { generator, describeMock } = makeGenerator({ store, reviewStore })

    await generator.generate({ key: KEY, scope: { kind: 'series' } })
    const prompt: string = describeMock.mock.calls[0][0].prompt
    expect(prompt).not.toContain('【台词')
  })

  it('fanout：每集一个子任务，最后只用文字小结合成（单请求上下文不爆）', async () => {
    const { store } = seedReport(1)
    // 第二集：同一个 DATA_DIR，另一个 store 实例也能读到
    seedReport(2)
    const reviewStore = createReviewStore(dir)

    const calls: Array<{ images: number; prompt: string }> = []
    const describeMock = vi.fn(async (req: any) => {
      calls.push({ images: req.images.length, prompt: req.prompt })
      if (req.images.length > 0) {
        // 子任务：单集小结
        return {
          text: JSON.stringify({
            episode: 1,
            points: ['[00:12] 第一次切镜'],
            scores: [{ dimension: '剧情', value: 8.2, reason: '开场干净' }],
            quotes: [],
            caveats: [],
          }),
          usage: { promptTokens: 1000, completionTokens: 300, totalTokens: 1300 },
          model: 'fake-vision-model',
        } satisfies DescribeResult
      }
      // 汇总：整季影评（不带图）
      return {
        text: modelJson(),
        usage: { promptTokens: 800, completionTokens: 500, totalTokens: 1300 },
        model: 'fake-vision-model',
      } satisfies DescribeResult
    })

    const generator = createReviewGenerator({
      store,
      reviewStore,
      appVersion: '1.3.26',
      describe: describeMock,
    })

    const events: Array<Record<string, unknown>> = []
    const { review } = await generator.generate(
      { key: KEY, scope: { kind: 'series' }, options: { mode: 'fanout' } },
      undefined,
      (event) => events.push(event as unknown as Record<string, unknown>),
    )

    // 2 集 + 1 次汇总 = 3 次调用；前两次带图，汇总不带图
    expect(describeMock).toHaveBeenCalledTimes(3)
    expect(calls[0].images).toBe(1)
    expect(calls[1].images).toBe(1)
    expect(calls[2].images).toBe(0)

    // 每集子任务只拿到自己那一集的素材（这正是"子代理只看一集"的边界）
    expect(calls[0].prompt).toContain('E1')
    expect(calls[1].prompt).toContain('E2')

    // usage 累加（1300 × 3），inputs.sheets 是总共发出去的图数
    expect(review.tokens).toBe(3900)
    expect(review.usage?.totalTokens).toBe(3900)
    expect(review.inputs.sheets).toBe(2)
    expect(review.caveats?.some((caveat) => caveat.includes('分集小结汇总'))).toBe(true)

    // 进度里要能看到"子任务 N/M"
    expect(events.some((event) => String(event.message ?? '').includes('子任务'))).toBe(true)
  })

  it('生成过程发阶段事件，token 分项写进结果（进度与账单都要真）', async () => {
    const { store } = seedReport(1)
    const reviewStore = createReviewStore(dir)
    const describe = vi.fn(async () => ({
      text: modelJson(),
      usage: { promptTokens: 3000, completionTokens: 5000, reasoningTokens: 1200, totalTokens: 8000 },
      model: 'fake-vision-model',
    }))
    const generator = createReviewGenerator({
      store,
      reviewStore,
      appVersion: '1.3.37',
      describe,
    })

    const events: Array<Record<string, unknown>> = []
    const { review } = await generator.generate(
      { key: KEY, scope: { kind: 'series' } },
      undefined,
      (event) => events.push(event as unknown as Record<string, unknown>),
    )

    // 顺序即用户看到的顺序：整理输入 → 交给模型 → 解析落盘 → 完成
    expect(events.map((event) => (event.type === 'phase' ? event.phase : event.type))).toEqual([
      'collect',
      'call',
      'parse',
      'done',
    ])
    // call 阶段要告诉前端"在看多少张图、多少集"（UI 拿它写文案）
    expect(events[1]).toMatchObject({ sheets: 1, episodes: [1], shots: 2 })

    expect(review.tokens).toBe(8000)
    expect(review.usage).toEqual({
      promptTokens: 3000,
      completionTokens: 5000,
      reasoningTokens: 1200,
      totalTokens: 8000,
    })
  })

  it('缓存命中时也会发一次 done（cached=true），且不调模型', async () => {
    const { store } = seedReport(1)
    const reviewStore = createReviewStore(dir)
    const { generator, describeMock } = makeGenerator({ store, reviewStore })

    await generator.generate({ key: KEY, scope: { kind: 'series' } })
    expect(describeMock).toHaveBeenCalledTimes(1)

    const events: Array<Record<string, unknown>> = []
    const second = await generator.generate(
      { key: KEY, scope: { kind: 'series' } },
      undefined,
      (event) => events.push(event as unknown as Record<string, unknown>),
    )
    expect(second.cached).toBe(true)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'done', cached: true })
    // 第二次没有重新花钱
    expect(describeMock).toHaveBeenCalledTimes(1)
  })

  it('elapsedMs 落盘（历史记录要能显示这篇花了多久）', async () => {
    const { store } = seedReport(1)
    const reviewStore = createReviewStore(dir)
    const { generator } = makeGenerator({ store, reviewStore })
    const { review } = await generator.generate({ key: KEY, scope: { kind: 'series' } })
    expect(typeof review.elapsedMs).toBe('number')
    expect(review.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('图多时均匀采样，不会只把前半集给 AI 看', async () => {
    // 一集 18 张图（24 分钟按每 10 秒一帧的实际产物），只允许取 6 张
    const store = createWatchStore(dir)
    const report = makeReport(1, {
      sheets: Array.from({ length: 18 }, (_, i) => ({
        file: `ep01-${i + 1}.png`, width: 800, height: 450, cells: 10, shots: [],
      })),
    })
    store.write(report)
    const sheetDir = store.sheetDir(KEY, 1)
    fs.mkdirSync(sheetDir, { recursive: true })
    // 每张塞不同标记，好在 describe 收到的 data URL 里认出来是哪一张
    for (let i = 0; i < 18; i += 1) {
      fs.writeFileSync(path.join(sheetDir, `ep01-${i + 1}.png`), Buffer.concat([TINY_PNG, Buffer.from(`#${i}#`)]))
    }

    const reviewStore = createReviewStore(dir)
    const { generator, describeMock } = makeGenerator({ store, reviewStore })
    const { review } = await generator.generate({
      key: KEY,
      scope: { kind: 'series' },
      options: { maxSheets: 6 },
    })

    expect(review.inputs.sheets).toBe(6)
    const images: string[] = describeMock.mock.calls[0][0].images
    expect(images).toHaveLength(6)
    const decode = (url: string) => Buffer.from(url.split(',')[1], 'base64').toString('latin1')
    // 18 取 6 → step=3 → 索引 0,3,6,9,12,15，首尾都要覆盖到
    expect(decode(images[0])).toContain('#0#')
    expect(decode(images[5])).toContain('#15#')
  })

  it('多集时按比例分配图片配额，后面的集不会一张都看不到', async () => {
    const store = createWatchStore(dir)
    for (const episode of [1, 2, 3]) {
      const report = makeReport(episode, {
        sheets: Array.from({ length: 10 }, (_, i) => ({
          file: `ep0${episode}-${i + 1}.png`, width: 800, height: 450, cells: 10, shots: [],
        })),
      })
      store.write(report)
      const sheetDir = store.sheetDir(KEY, episode)
      fs.mkdirSync(sheetDir, { recursive: true })
      for (const sheet of report.sheets) fs.writeFileSync(path.join(sheetDir, sheet.file), TINY_PNG)
    }

    const reviewStore = createReviewStore(dir)
    const { generator, describeMock } = makeGenerator({ store, reviewStore })
    const { review } = await generator.generate({
      key: KEY,
      scope: { kind: 'series' },
      options: { maxSheets: 6 },
    })

    // 6 张 / 3 集 = 每集 2 张，一共 6 张，三集都有
    expect(review.inputs.sheets).toBe(6)
    expect(review.inputs.episodes).toEqual([1, 2, 3])
    const images: string[] = describeMock.mock.calls[0][0].images
    expect(images).toHaveLength(6)
  })

  /*
   * 缓存判定（2026-11-17 补）。
   *
   * 以前只按 key+scope 读：文件在就永远返回 cached:true。后果是
   * 「换了模型 / 改了提示词 / 后来又分析了一集」都拿回旧结果，
   * 而面板上写的是「模型和提示词版本都没变」—— 文案在骗人。
   */
  it('换了模型不命中缓存（AI 的分会变，不能拿旧结果冒充新生成）', async () => {
    const { store } = seedReport(1)
    const reviewStore = createReviewStore(dir)
    let model = 'fake-vision-model'
    const { generator, describeMock } = makeGenerator({ store, reviewStore, currentModel: () => model })

    await generator.generate({ key: KEY, scope: { kind: 'series' } })
    expect(describeMock).toHaveBeenCalledTimes(1)

    // 模型没变 → 命中
    expect((await generator.generate({ key: KEY, scope: { kind: 'series' } })).cached).toBe(true)
    expect(describeMock).toHaveBeenCalledTimes(1)

    // 换模型 → 不命中
    model = 'another-model'
    expect((await generator.generate({ key: KEY, scope: { kind: 'series' } })).cached).toBe(false)
    expect(describeMock).toHaveBeenCalledTimes(2)
  })

  it('提示词版本变了不命中缓存（换了尺子就该重跑）', async () => {
    const { store } = seedReport(1)
    const reviewStore = createReviewStore(dir)
    const { generator, describeMock } = makeGenerator({ store, reviewStore })

    await generator.generate({ key: KEY, scope: { kind: 'series' } })
    const saved = reviewStore.read(KEY, { kind: 'series' })!
    reviewStore.write({ ...saved, promptVersion: '0.9.0' })

    const again = await generator.generate({ key: KEY, scope: { kind: 'series' } })
    expect(again.cached).toBe(false)
    expect(again.review.promptVersion).toBe(REVIEW_PROMPT_VERSION)
    expect(describeMock).toHaveBeenCalledTimes(2)
  })

  it('多分析了一集之后不命中缓存（新集不能被静默忽略）', async () => {
    const { store } = seedReport(1)
    const reviewStore = createReviewStore(dir)
    const { generator, describeMock } = makeGenerator({ store, reviewStore })

    await generator.generate({ key: KEY, scope: { kind: 'series' }, options: { episodes: [1] } })
    // 同一批集 → 命中
    expect((await generator.generate({ key: KEY, scope: { kind: 'series' }, options: { episodes: [1] } })).cached).toBe(true)
    expect(describeMock).toHaveBeenCalledTimes(1)

    seedReport(2)
    const again = await generator.generate({ key: KEY, scope: { kind: 'series' } })
    expect(again.cached).toBe(false)
    expect(again.review.inputs.episodes).toEqual([1, 2])
    expect(describeMock).toHaveBeenCalledTimes(2)
  })

  /* ── 音轨信息（2026-11-17：模型曾断言「全片无音频轨」）── */
  it('片源有音轨时提示词要写明（否则模型会以为"没给我声音"=片子没声音）', async () => {
    const { store } = seedReport(1, {
      video: {
        file: 'D:/anime/ep01.mkv', duration: 1440, fps: 23.976, width: 1920, height: 1080,
        hasAudio: true, hasSubtitle: false,
      },
    })
    const reviewStore = createReviewStore(dir)
    const { generator, describeMock } = makeGenerator({ store, reviewStore })

    await generator.generate({ key: KEY, scope: { kind: 'series' } })
    const { prompt, system } = describeMock.mock.calls[0][0]
    expect(prompt).toContain('片源有音轨')
    expect(prompt).not.toContain('片源无音轨')
    // system 里要明确禁止"全片无音频轨"这种事实错误
    expect(String(system)).toContain('全片无音频轨')
  })

  it('片源没有音轨时也如实写进提示词', async () => {
    const { store } = seedReport(1, {
      video: {
        file: 'D:/anime/ep01.mkv', duration: 1440, fps: 23.976, width: 1920, height: 1080,
        hasAudio: false, hasSubtitle: false,
      },
    })
    const reviewStore = createReviewStore(dir)
    const { generator, describeMock } = makeGenerator({ store, reviewStore })

    await generator.generate({ key: KEY, scope: { kind: 'series' } })
    expect(describeMock.mock.calls[0][0].prompt).toContain('片源无音轨')
  })

  it('老报告没有 hasAudio 字段时不瞎写（音轨情况未知）', async () => {
    const { store } = seedReport(1)
    const reviewStore = createReviewStore(dir)
    const { generator, describeMock } = makeGenerator({ store, reviewStore })

    await generator.generate({ key: KEY, scope: { kind: 'series' } })
    const { prompt } = describeMock.mock.calls[0][0]
    expect(prompt).toContain('音轨情况未知')
    expect(prompt).not.toContain('片源有音轨')
    expect(prompt).not.toContain('片源无音轨')
  })

  it('fanout 汇总在盲评时不要求「说出不同意用户的地方」（提示词不能自相矛盾）', async () => {
    const { store } = seedReport(1)
    seedReport(2)
    const reviewStore = createReviewStore(dir)

    const systems: Array<{ images: number; system: string }> = []
    const describeMock = vi.fn(async (req: any) => {
      systems.push({ images: req.images.length, system: req.system })
      if (req.images.length > 0) {
        return {
          text: JSON.stringify({
            episode: 1,
            points: ['[00:12] 第一次切镜'],
            scores: [{ dimension: '剧情', value: 8.2 }],
            quotes: [],
            caveats: [],
          }),
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          model: 'fake-vision-model',
        } satisfies DescribeResult
      }
      return {
        text: modelJson(),
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        model: 'fake-vision-model',
      } satisfies DescribeResult
    })
    const generator = createReviewGenerator({
      store,
      reviewStore,
      appVersion: '1.3.26',
      describe: describeMock,
    })

    await generator.generate({ key: KEY, scope: { kind: 'series' }, options: { mode: 'fanout' } })
    const summary = systems.find((call) => call.images === 0)
    expect(summary).toBeDefined()
    expect(summary!.system).toContain('独立判断')
    expect(summary!.system).not.toContain('不同意他')
  })
})
