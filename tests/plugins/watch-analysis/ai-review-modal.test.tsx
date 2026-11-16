// @vitest-environment jsdom
/**
 * AiReviewModal 的渲染 + 交互测试
 *
 * 覆盖任务书点名的四件事，外加一条缓存提示：
 *   1. 未生成：空状态 + 直接给「生成影评」按钮（不用先去配置 Tab）；
 *   2. 有影评 + 有用户分：AI 分、「无证据」标签、差值、时间轴行数、剧透折叠；
 *   3. userContext 缺 scores：显示「你还没打分」而不是崩；
 *   4. 生成失败：错误 Alert + 后端错误原文；
 *   5. 缓存命中：顶部出现「这是上次生成的结果」。
 *
 * 渲染方式沿用项目约定：没有装 @testing-library/react，用
 * `react-dom/client + act` 手动渲染。antd Modal 渲染在 document.body 的 portal 里，
 * 所以断言查 `document.body` 而不是挂载节点。ECharts 在 jsdom 里没有 canvas，
 * 把 `echarts-for-react` 换成占位节点，顺便断言雷达图有「几条维度、几条序列」。
 */
import { act } from 'react'
import type { ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiReview, ReviewUserContext } from '../../../plugins/watch-analysis/core/review-types'

/* ── mock：echarts 换成占位节点（jsdom 没有 canvas） ── */
vi.mock('echarts-for-react', async () => {
  const React = await import('react')
  return {
    default: (props: {
      option?: {
        radar?: { indicator?: unknown[] }
        series?: Array<{ data?: unknown[] }>
      }
    }) => {
      const dims = props?.option?.radar?.indicator?.length ?? 0
      const series = props?.option?.series?.[0]?.data?.length ?? 0
      return React.createElement('div', {
        'data-testid': 'review-radar',
        'data-dims': String(dims),
        'data-series': String(series),
      })
    },
  }
})

/* ── mock：影评 HTTP 客户端（组件只 import 这些函数） ── */
const apiMocks = vi.hoisted(() => ({
  // 生成已经改成「后台任务 + 轮询」：不再有 generateReviewStream
  startReviewRun: vi.fn(),
  getReviewRun: vi.fn(),
  listReviewRuns: vi.fn(),
  cancelReviewRun: vi.fn(),
  getExistingReview: vi.fn(),
  getReviewMeta: vi.fn(),
  listAnalyzedEpisodes: vi.fn(),
  resolveVideoFile: vi.fn(),
}))

vi.mock('../../../plugins/watch-analysis/ui/review-api', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../plugins/watch-analysis/ui/review-api')>()
  return {
    ...actual,
    startReviewRun: apiMocks.startReviewRun,
    getReviewRun: apiMocks.getReviewRun,
    listReviewRuns: apiMocks.listReviewRuns,
    cancelReviewRun: apiMocks.cancelReviewRun,
    getExistingReview: apiMocks.getExistingReview,
    getReviewMeta: apiMocks.getReviewMeta,
    listAnalyzedEpisodes: apiMocks.listAnalyzedEpisodes,
    resolveVideoFile: apiMocks.resolveVideoFile,
  }
})

import AiReviewModal from '../../../plugins/watch-analysis/ui/AiReviewModal'
import type { AiReviewModalProps } from '../../../plugins/watch-analysis/ui/AiReviewModal'

/* ─────────────────────────────────────────────────────────
 * 公共设施
 * ───────────────────────────────────────────────────────── */

beforeAll(() => {
  // antd 的响应式组件会读 matchMedia；jsdom 没有实现
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

let container: HTMLDivElement | null = null
let root: Root | null = null

const KEY = '模板::葬送的芙莉莲'
const TITLE = '葬送的芙莉莲'

/** 一次微任务 + 一次 setTimeout 的冲刷，让 effect 里的 mock promise 落地 */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function mountModal(overrides?: Partial<AiReviewModalProps>): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)

  const node: ReactElement = (
    <AiReviewModal
      open
      onClose={() => {}}
      animeKey={KEY}
      title={TITLE}
      userContext={USER_CONTEXT}
      {...overrides}
    />
  )

  await act(async () => {
    root?.render(node)
  })
  await flush()
  return container
}

/** antd Modal 在 document.body 的 portal 里，统一从这里取文本 */
function bodyText(): string {
  return document.body.textContent ?? ''
}

/** 等某个断言条件成立（用 act 包住等待，避免 React 更新落在 act 外） */
async function waitFor(check: () => boolean, timeout = 3000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    await flush()
    if (check()) return
  }
  throw new Error(`等待超时：${bodyText().slice(0, 400)}`)
}

/** 找到当前面板里文字包含 `text` 的按钮（antd 会在两个汉字的按钮文案里自动插空格，这里先归一化） */
function findButton(text: string): HTMLButtonElement | undefined {
  const buttons = Array.from(document.body.querySelectorAll('button'))
  return buttons.find((button) =>
    (button.textContent ?? '').replace(/\s+/g, '').includes(text),
  ) as HTMLButtonElement | undefined
}

beforeEach(() => {
  vi.resetAllMocks()
  apiMocks.getExistingReview.mockResolvedValue(null)
  apiMocks.listAnalyzedEpisodes.mockResolvedValue([1, 2, 3])
  apiMocks.getReviewMeta.mockResolvedValue({
    model: 'qwen-vl-max',
    promptVersion: '1.0.0',
    budgetLimit: 2_000_000,
  })
  apiMocks.resolveVideoFile.mockResolvedValue('D:\\anime\\葬送的芙莉莲\\01.mp4')
  // 后台任务默认：没有正在跑的、创建就返回 runId、轮询立刻是 done
  apiMocks.listReviewRuns.mockResolvedValue([])
  apiMocks.startReviewRun.mockResolvedValue({ runId: 'run-test' })
  apiMocks.getReviewRun.mockResolvedValue({
    runId: 'run-test',
    key: KEY,
    scope: { kind: 'series' },
    status: 'done',
    phase: 'done',
    message: '完成',
    chars: 0,
    reasoningChars: 0,
    startedAt: Date.now() - 1000,
    finishedAt: Date.now(),
    review: REVIEW,
    cached: false,
  })
  apiMocks.cancelReviewRun.mockResolvedValue(true)
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  container?.remove()
  container = null
  root = null
})

/* ─────────────────────────────────────────────────────────
 * 手写数据（刻意只填契约要求的字段，不抄真实结果）
 * ───────────────────────────────────────────────────────── */

const USER_CONTEXT: ReviewUserContext = {
  title: TITLE,
  // 剧情 8.0 / 作画 7.9 / 音声 7.0，与 REVIEW.scores 的差值分别是 +1.0 / -0.4 / +1.6
  // （模板里叫「音声」，不是「声音」—— 这就是 2026-11-17 用户截图里多出一条轴的那个 bug）
  scores: { 剧情: 8.0, 作画: 7.9, 音声: 7.0 },
  review: '整体很稳，第三集最好。',
  tags: ['奇幻', '公路片'],
  watchedEpisodes: 3,
  totalEpisodes: 28,
}

const REVIEW: AiReview = {
  schema: 1,
  key: KEY,
  scope: { kind: 'series' },
  model: 'qwen-vl-max',
  promptVersion: '1.0.0',
  tokens: 8321,
  created: '2026-11-16T01:00:00.000Z',
  appVersion: '1.3.26',
  scores: [
    {
      dimension: '剧情',
      value: 9.0,
      reason: '第三集的回忆把前两集的伏笔一次收回',
      evidence: [{ episode: 3, t: 754, note: '回忆段落的落幅' }],
    },
    {
      dimension: '作画',
      value: 7.5,
      reason: '战斗段落的作画明显省力',
      // 空数组 = 没有证据，前端必须标「无证据」（产品硬要求）
      evidence: [],
    },
    {
      dimension: '声音',
      value: 8.6,
      reason: '配乐克制，静默用得比台词狠',
      evidence: [{ episode: 1, t: 120.5 }],
    },
  ],
  markdown:
    '第三集的回忆段落是整部番的支点。[12:34] 之后的静默比任何台词都响。\n\n' +
    '![E3 分镜](/api/watch/sheet?key=%E6%A8%A1%E6%9D%BF&episode=3&file=ep03.png)',
  // 刻意乱序，验证组件会按 episode → t 重排
  timeline: [
    { episode: 3, t: 754, text: '第三集 12:34 这里收掉了第一集的伏笔', shot: 42 },
    { episode: 1, t: 120, text: '开场两分钟还没有一句台词' },
    { episode: 1, t: 60, text: '片头字幕之后直接进正片' },
  ],
  citations: [{ episode: 3, sheet: 'ep03.png', cell: 2 }],
  inputs: { episodes: [1, 2, 3], shots: 120, sheets: 6, dialogueLines: 88 },
  spoiler: '结局把整部番的时间线翻了过来。',
  caveats: ['只看过前三集，后段的判断可能偏'],
}

/* ─────────────────────────────────────────────────────────
 * 用例
 * ───────────────────────────────────────────────────────── */

describe('AiReviewModal', () => {
  it('未生成：空状态 + 直接给「生成影评」按钮（不用先去配置）', async () => {
    await mountModal()

    await waitFor(() => bodyText().includes('还没有生成过影评'))

    expect(bodyText()).toContain('还没有生成过影评')
    // 引导文案说明大概多久，并强调「不用先去配置 Tab」
    expect(bodyText()).toContain('30–180 秒')
    expect(bodyText()).toContain('不用先去配置')

    const generateButton = findButton('生成影评')
    expect(generateButton).not.toBeUndefined()
    // 已分析过 3 集，按钮必须是可点的（不能假装能生成又禁掉）
    expect(generateButton?.disabled).toBe(false)

    // 空状态下不该出现「重新生成」或错误 Alert
    expect(findButton('重新生成')).toBeUndefined()
    expect(document.body.querySelector('.ant-alert-error')).toBeNull()
  })

  it('有影评：AI 分 / 无证据标签 / 差异值 / 时间轴 / 剧透折叠都在', async () => {
    apiMocks.getExistingReview.mockResolvedValue(REVIEW)

    await mountModal()

    await waitFor(() => bodyText().includes('评分对比'))

    // 双序列雷达：3 个维度、2 条序列（你的分 + AI 的分）
    const radar = document.body.querySelector('[data-testid="review-radar"]')
    expect(radar).not.toBeNull()
    expect(radar?.getAttribute('data-dims')).toBe('3')
    expect(radar?.getAttribute('data-series')).toBe('2')

    const rows = Array.from(document.body.querySelectorAll('[data-testid="score-row"]'))
    expect(rows).toHaveLength(3)

    // AI 的分
    const aiScores = Array.from(document.body.querySelectorAll('[data-testid="ai-score"]')).map(
      (node) => node.textContent,
    )
    expect(aiScores).toEqual(['9', '7.5', '8.6'])

    // 差值（AI − 你），一位小数 + 正负号
    const diffs = Array.from(document.body.querySelectorAll('[data-testid="diff-value"]')).map(
      (node) => node.textContent,
    )
    expect(diffs).toEqual(['+1.0', '-0.4', '+1.6'])

    // 差值 ≥1 的「剧情 / 音声」高亮，「作画」不高亮
    const highlighted = rows
      .filter((row) => row.getAttribute('data-highlight') === 'true')
      .map((row) => row.getAttribute('data-dimension'))
    expect(highlighted).toEqual(['剧情', '音声'])

    // 只有 evidence 为空的「作画」挂「无证据」，有证据的不能误标
    const noEvidence = rows
      .filter((row) => row.querySelector('[data-testid="no-evidence"]') !== null)
      .map((row) => row.getAttribute('data-dimension'))
    expect(noEvidence).toEqual(['作画'])
    expect(bodyText()).toContain('无证据')

    // 时间轴：3 条，按 episode → t 排序（E1 60s / E1 120s / E3 754s）
    const timelineRows = Array.from(
      document.body.querySelectorAll('[data-testid="timeline-row"]'),
    )
    expect(timelineRows).toHaveLength(3)
    expect(timelineRows[0]?.textContent).toContain('E01 · 01:00')
    expect(timelineRows[1]?.textContent).toContain('E01 · 02:00')
    expect(timelineRows[2]?.textContent).toContain('E03 · 12:34')

    // 剧透折叠 + caveats
    expect(bodyText()).toContain('含剧透，点击展开')
    expect(bodyText()).toContain('只看过前三集，后段的判断可能偏')

    // 正文：Markdown 图片走相对 URL 直接渲染
    const image = document.body.querySelector('[data-testid="review-markdown"] img')
    expect(image).not.toBeNull()
    expect(image?.getAttribute('src')).toContain('/api/watch/sheet')

    // 正文 [12:34] 变成了可点击节点
    const timecodes = Array.from(
      document.body.querySelectorAll('[data-testid="timecode-link"]'),
    )
    expect(timecodes.length).toBeGreaterThan(0)
    expect(timecodes[0]?.textContent).toBe('[12:34]')

    // 元信息：模型 / 提示词版本 / token / 生成时间
    const meta = document.body.querySelector('[data-testid="review-meta"]')
    expect(meta?.textContent).toContain('qwen-vl-max')
    expect(meta?.textContent).toContain('提示词 v1.0.0')
    expect(meta?.textContent).toContain('8,321 token')
    // 「用时」没有契约字段：读历史结果时如实显示「—」，不编数
    expect(meta?.textContent).toContain('用时 —')
  })

  it('点正文时间码触发 onJumpTo（整部番按时间轴推断集号）', async () => {
    apiMocks.getExistingReview.mockResolvedValue(REVIEW)
    const onJumpTo = vi.fn()

    await mountModal({ onJumpTo })

    await waitFor(() => document.body.querySelector('[data-testid="timecode-link"]') !== null)

    const timecode = document.body.querySelector('[data-testid="timecode-link"]') as HTMLElement
    act(() => {
      timecode.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // [12:34] = 754 秒，时间轴里同一时刻的论点是第三集
    expect(onJumpTo).toHaveBeenCalledWith({ episode: 3, t: 754 })
  })

  it('userContext 缺 scores：显示「你还没打分」而不是崩', async () => {
    apiMocks.getExistingReview.mockResolvedValue(REVIEW)

    await mountModal({ userContext: { title: TITLE } })

    await waitFor(() => bodyText().includes('你还没打分'))

    expect(bodyText()).toContain('你还没打分')
    // 仍然渲染 AI 的维度分（3 行），用户分列全部是占位
    const userScores = Array.from(
      document.body.querySelectorAll('[data-testid="user-score"]'),
    ).map((node) => node.textContent)
    expect(userScores).toEqual(['—', '—', '—'])
    expect(document.body.querySelectorAll('[data-testid="score-row"]')).toHaveLength(3)
    // 没有用户分时雷达图只有 AI 一条序列
    const radar = document.body.querySelector('[data-testid="review-radar"]')
    expect(radar?.getAttribute('data-series')).toBe('1')
    // 没有用户分就不会有差值（不编「AI 比你高」）
    const diffs = Array.from(document.body.querySelectorAll('[data-testid="diff-value"]')).map(
      (node) => node.textContent,
    )
    expect(diffs).toEqual(['—', '—', '—'])
  })

  it('维度轴以模板为准：AI 写的旧名「声音」归一到「音声」，不会出现两条轴', async () => {
    // REVIEW.scores 里是「声音」（早期兜底列表的叫法），用户分是模板的「音声」
    apiMocks.getExistingReview.mockResolvedValue(REVIEW)

    await mountModal()

    await waitFor(() => bodyText().includes('评分对比'))

    const rows = Array.from(document.body.querySelectorAll('[data-testid="score-row"]'))
    // 只有用户（模板）的 3 个维度，不会多出「声音」这条
    expect(rows).toHaveLength(3)
    const names = rows.map((row) => row.getAttribute('data-dimension'))
    expect(names).toEqual(['剧情', '作画', '音声'])
    expect(names).not.toContain('声音')

    // AI 的「声音 8.6」被正确归一到「音声」这一行（而不是变成一条没有分数的空轴）
    const aiScores = Array.from(document.body.querySelectorAll('[data-testid="ai-score"]')).map(
      (node) => node.textContent,
    )
    expect(aiScores[2]).toBe('8.6')
  })

  it('生成失败：错误 Alert 显示后端原文，并给重试入口', async () => {
    const failure = '模型没有返回合法 JSON，影评生成失败（可以重试一次）'
    apiMocks.getReviewRun.mockResolvedValue({
      runId: 'run-test',
      key: KEY,
      scope: { kind: 'series' },
      status: 'failed',
      phase: 'call',
      message: '失败',
      chars: 0,
      reasoningChars: 0,
      startedAt: Date.now() - 1000,
      finishedAt: Date.now(),
      error: failure,
    })

    await mountModal()

    await waitFor(() => bodyText().includes('还没有生成过影评'))

    const generateButton = findButton('生成影评')
    expect(generateButton).not.toBeUndefined()
    await act(async () => {
      generateButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await waitFor(() => bodyText().includes(failure))

    expect(bodyText()).toContain('生成失败')
    expect(bodyText()).toContain(failure)
    expect(document.body.querySelector('.ant-alert-error')).not.toBeNull()
    expect(findButton('重试')).not.toBeUndefined()
  })

  it('生成中显示真实进度：后台任务快照里的阶段 + 已生成字数', async () => {
    let finished = false
    apiMocks.getReviewRun.mockImplementation(async () => (
      finished
        ? {
            runId: 'run-test',
            key: KEY,
            scope: { kind: 'series' },
            status: 'done',
            phase: 'done',
            message: '完成',
            chars: 0,
            reasoningChars: 0,
            startedAt: Date.now() - 1000,
            finishedAt: Date.now(),
            review: REVIEW,
            cached: false,
          }
        : {
            runId: 'run-test',
            key: KEY,
            scope: { kind: 'series' },
            status: 'running',
            phase: 'call',
            message: '把 6 张分镜图和 3 集报告交给模型',
            chars: 1234,
            reasoningChars: 0,
            startedAt: Date.now() - 5000,
          }
    ))

    await mountModal()
    await waitFor(() => bodyText().includes('还没有生成过影评'))

    const generateButton = findButton('生成影评')
    await act(async () => {
      generateButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await waitFor(() => bodyText().includes('已生成 1,234 字'))
    // 阶段文案来自任务快照（服务端真实阶段），不是按秒数猜的那套
    expect(bodyText()).toContain('把 6 张分镜图和 3 集报告交给模型')
    expect(bodyText()).toContain('关掉面板不会中断')

    finished = true
    await waitFor(() => bodyText().includes('评分对比'))
  })

  it('元信息：有 usage 时显示输入/输出/共，历史记录用 elapsedMs 显示用时', async () => {
    apiMocks.getExistingReview.mockResolvedValue({
      ...REVIEW,
      elapsedMs: 115568,
      usage: { promptTokens: 3144, completionTokens: 13517, totalTokens: 16661 },
    } satisfies AiReview)

    await mountModal()
    await waitFor(() => bodyText().includes('评分对比'))

    const meta = document.body.querySelector('[data-testid="review-meta"]')
    expect(meta?.textContent).toContain('输入 3,144 / 输出 13,517 / 共 16,661 token')
    // 历史记录也能量出"这篇花了多久"（以前一律显示 —）
    expect(meta?.textContent).toContain('用时 116 秒')
  })

  it('缓存命中：顶部提示「这是上次生成的结果」并给重新生成', async () => {
    apiMocks.getReviewRun.mockResolvedValue({
      runId: 'run-test',
      key: KEY,
      scope: { kind: 'series' },
      status: 'done',
      phase: 'done',
      message: '完成',
      chars: 0,
      reasoningChars: 0,
      startedAt: Date.now() - 1000,
      finishedAt: Date.now(),
      review: REVIEW,
      cached: true,
    })

    await mountModal()

    await waitFor(() => bodyText().includes('还没有生成过影评'))

    const generateButton = findButton('生成影评')
    await act(async () => {
      generateButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await waitFor(() => bodyText().includes('这是上次生成的结果'))

    expect(bodyText()).toContain('这是上次生成的结果')
    // 缓存结果也要正常渲染成影评内容（不是空状态）
    expect(bodyText()).toContain('评分对比')
    expect(findButton('重新生成')).not.toBeUndefined()
  })
})
