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

  it('用户上下文会进提示词（评分对比是产品核心，不能丢）', async () => {
    const { store } = seedReport(1)
    const reviewStore = createReviewStore(dir)
    const { generator, describeMock } = makeGenerator({ store, reviewStore })

    await generator.generate({
      key: KEY,
      scope: { kind: 'series' },
      userContext: { title: '测试番', scores: { 剧情: 8.5 }, review: '我觉得节奏很好', tags: ['治愈'] },
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

  it('elapsedMs 落盘（历史记录要能显示这篇花了多久）', async () => {
    const { store } = seedReport(1)
    const reviewStore = createReviewStore(dir)
    const { generator } = makeGenerator({ store, reviewStore })
    const { review } = await generator.generate({ key: KEY, scope: { kind: 'series' } })
    expect(typeof review.elapsedMs).toBe('number')
    expect(review.elapsedMs).toBeGreaterThanOrEqual(0)
  })
})
