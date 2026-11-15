// @vitest-environment jsdom
/**
 * plugins/watch-analysis/ui 的渲染测试
 *
 * 覆盖三件事（都是「接错了会静默出错」的地方）：
 *   1. BudgetBar：正常账本 / 超支账本 / 预占占满三种显示，耗尽文案必须出现；
 *   2. StoryboardViewer：手写的最小 WatchReport 能渲染出 3 行镜头、时间码是 mm:ss.S、
 *      宫格图 URL 指向 /api/watch/sheet、有/无动感数据时曲线按预期出现或消失；
 *   3. WatchTab：依赖不全时列出缺失项和补装命令，「开始分析」必须是禁用态（不假装能跑）；
 *      已有报告时直接进入完成态渲染分镜。
 *
 * 渲染方式说明：项目里**没有装 @testing-library/react**（只有 @testing-library/jest-dom），
 * 现有测试（BangumiSyncModal / MusicPicker / ReviewTimeline）统一用
 * `react-dom/client + act` 手动渲染，这里沿用同一套约定，断言直接查 DOM。
 * ECharts 在 jsdom 里没有 canvas，所以把 `echarts-for-react` 换成带 data-points 的占位节点，
 * 顺便断言折线的数据点数。
 */
import { act } from 'react'
import type { ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BudgetLedger, WatchReport } from '../../../plugins/watch-analysis/core/types'

/* ── mock：echarts 换成占位节点（jsdom 没有 canvas） ── */
vi.mock('echarts-for-react', async () => {
  const React = await import('react')
  return {
    default: (props: { option?: { series?: Array<{ data?: unknown[] }> } }) => {
      const points = props?.option?.series?.[0]?.data?.length ?? 0
      return React.createElement('div', {
        'data-testid': 'motion-chart',
        'data-points': String(points),
      })
    },
  }
})

/* ── mock：WatchTab 依赖的 HTTP 客户端（组件只 import 这些函数） ── */
const apiMocks = vi.hoisted(() => ({
  analyze: vi.fn(),
  getStatus: vi.fn(),
  cancel: vi.fn(),
  getReport: vi.fn(),
  getDeps: vi.fn(),
}))

vi.mock('../../../plugins/watch-analysis/ui/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../plugins/watch-analysis/ui/api')>()
  return {
    ...apiMocks,
    // sheetUrl 是纯字符串拼接，保留真实实现，顺便验证 URL 形状
    sheetUrl: actual.sheetUrl,
  }
})

import BudgetBar from '../../../plugins/watch-analysis/ui/BudgetBar'
import StoryboardViewer, { formatTimecode } from '../../../plugins/watch-analysis/ui/StoryboardViewer'
import WatchTab from '../../../plugins/watch-analysis/ui/WatchTab'

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
  // jsdom 不实现 scrollIntoView；给个空实现，点击镜头行时才能走到高亮逻辑
  Element.prototype.scrollIntoView = vi.fn()
})

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount(node: ReactElement): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(node)
  })
  return container
}

async function mountAsync(node: ReactElement): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(node)
  })
  return container
}

/** 等某个断言条件成立（用 act 包住等待，避免 React 更新落在 act 外） */
async function waitFor(check: () => boolean, timeout = 3000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15))
    })
    if (check()) return
  }
  throw new Error(`等待超时：${document.body.textContent?.slice(0, 400)}`)
}

beforeEach(() => {
  vi.resetAllMocks()
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
 * 手写的最小报告（刻意只填契约要求的字段，不抄真实报告）
 * ───────────────────────────────────────────────────────── */

const REPORT: WatchReport = {
  schema: 1,
  key: '模板::葬送的芙莉莲',
  episode: 2,
  video: {
    file: 'D:\\anime\\葬送的芙莉莲\\02.mp4',
    duration: 1420,
    fps: 23.976,
    width: 1920,
    height: 1080,
  },
  engine: {
    storyboard: 'dsh-video-storyboard@0.7.5',
    cut: 'hsv-diff',
    transcript: 'asr',
    motion: 'ffmpeg-frame-diff',
    music: 'music-evidence-engine',
  },
  shots: [
    {
      i: 0,
      start: 0,
      end: 3.5,
      sampled: false,
      tier: 2,
      // 台词优先用 storyboard alignCells 回填的 shot.text
      text: '勇者大人，这边请。',
      motion: { shot: 0, mean: 12.4, peak: 30, dense: false },
      cell: { sheet: 0, x: 0, y: 0 },
    },
    {
      i: 1,
      start: 3.5,
      end: 65.4,
      sampled: false,
      tier: 4,
      motion: { shot: 1, mean: 48.2, peak: 90, dense: true },
      cell: { sheet: 0, x: 1, y: 0 },
    },
    { i: 2, start: 65.4, end: 128.9, sampled: true, tier: 1 },
  ],
  cuts: [
    { t: 3.5, score: 42, engine: 'hsv-diff' },
    { t: 65.4, score: 88, engine: 'hsv-diff' },
  ],
  transcript: {
    source: 'asr',
    segments: [
      { start: 4, end: 9, text: '勇者大人，这边请。', source: 'asr' },
      { start: 70, end: 80, text: '这段很长的台词用来验证回车换行前的截断展示是否正常工作。', source: 'asr' },
    ],
  },
  motion: {
    curve: [
      [0, 10],
      [1.5, 24],
      [3.5, 8],
      [65.4, 55],
      [128.9, 6],
    ],
    perShot: [12.4, 48.2, 9.1],
  },
  sheets: [
    // file 是「相对本集 sheet 目录」的文件名（Phase 1 后端按它取图，见 api.ts 的说明）
    { file: 'ep02-0.png', width: 1600, height: 900, cells: 2, shots: [0, 1] },
    { file: 'ep02-1.png', width: 1600, height: 900, cells: 1, shots: [2] },
  ],
  budget: {
    limit: 2_000_000,
    spent: 250_000,
    byKind: { vision: 200_000, analyze: 50_000 },
    reserved: 0,
    exhausted: false,
  },
  timing: { total: 120, render: 60, analyze: 40 },
  created: '2026-11-15T12:00:00.000Z',
  appVersion: '1.3.26',
}

/* ─────────────────────────────────────────────────────────
 * BudgetBar
 * ───────────────────────────────────────────────────────── */

const NORMAL_LEDGER: BudgetLedger = {
  limit: 1000,
  spent: 250,
  byKind: { vision: 200, analyze: 50 },
  reserved: 0,
  exhausted: false,
}

describe('BudgetBar', () => {
  it('未超预算：显示已用/上限与各环节占比', () => {
    const el = mount(<BudgetBar ledger={NORMAL_LEDGER} />)

    expect(el.textContent).toContain('已用 250')
    expect(el.textContent).toContain('上限 1,000')
    // 分项：vision 200 / analyze 50，占总已用的 80% / 20%
    expect(el.textContent).toContain('看图')
    expect(el.textContent).toContain('200 · 80%')
    expect(el.textContent).toContain('写报告')
    expect(el.textContent).toContain('50 · 20%')
    // 没超预算，不标红、不出现耗尽文案
    expect(el.textContent).not.toContain('预算耗尽')
    expect(el.querySelector('[data-testid="budget-exhausted"]')).toBeNull()
    expect(el.querySelector('.wa-budget--exhausted')).toBeNull()
  })

  it('超预算：标红并显示「预算耗尽」', () => {
    const ledger: BudgetLedger = {
      limit: 1000,
      spent: 1200,
      byKind: { vision: 1200 },
      reserved: 0,
      exhausted: true,
    }
    const el = mount(<BudgetBar ledger={ledger} />)

    expect(el.textContent).toContain('预算耗尽')
    expect(el.querySelector('[data-testid="budget-exhausted"]')).not.toBeNull()
    // 容器上挂异常态 class，样式由宿主主题决定（组件里不写死颜色）
    expect(el.querySelector('.wa-budget--exhausted')).not.toBeNull()
    // 进度条百分比封顶 100%，不会画出 120%
    expect(el.textContent).toContain('100%')
  })

  it('预占把额度占满也算耗尽，并把预占量显示出来', () => {
    const ledger: BudgetLedger = {
      limit: 1000,
      spent: 900,
      byKind: { vision: 900 },
      reserved: 100,
      exhausted: true,
    }
    const el = mount(<BudgetBar ledger={ledger} />)

    expect(el.textContent).toContain('另有预占 100')
    expect(el.textContent).toContain('预算耗尽')
  })
})

/* ─────────────────────────────────────────────────────────
 * StoryboardViewer
 * ───────────────────────────────────────────────────────── */

describe('StoryboardViewer', () => {
  it('渲染全部镜头行，时间码是 mm:ss.S', () => {
    const el = mount(<StoryboardViewer report={REPORT} />)

    const rows = el.querySelectorAll('[data-testid="shot-row"]')
    expect(rows).toHaveLength(REPORT.shots.length)

    // 起止时间：0 → 3.5 → 65.4 → 128.9 秒
    expect(el.textContent).toContain('00:00.0')
    expect(el.textContent).toContain('00:03.5')
    expect(el.textContent).toContain('01:05.4')
    expect(el.textContent).toContain('02:08.9')
    // 第二行时长 65.4 - 3.5 = 61.9s
    expect(el.textContent).toContain('61.9s')
    // 档位 / 动感值：前两个镜头有 shot.motion，第三个镜头回退到 motion.perShot[2]
    expect(el.textContent).toContain('档位 4')
    expect(el.textContent).toContain('动感 48.2')
    expect(el.textContent).toContain('动感 9.1')
    // 台词：shot 0 用 storyboard 回填的 shot.text，shot 2 用 transcript 时间重叠兜底
    expect(el.textContent).toContain('勇者大人，这边请。')
    expect(el.textContent).toContain('这段很长的台词用来验证回车换行前的截断展示是否正常工作。')
  })

  it('按 sheets 顺序渲染宫格图，src 指向 /api/watch/sheet', () => {
    const el = mount(<StoryboardViewer report={REPORT} />)

    const imgs = Array.from(el.querySelectorAll('[data-sheet-index] img'))
    expect(imgs).toHaveLength(2)
    expect(imgs[0]?.getAttribute('src')).toContain('/api/watch/sheet?key=')
    expect(imgs[0]?.getAttribute('src')).toContain('episode=2')
    expect(imgs[0]?.getAttribute('src')).toContain('n=0')
    expect(imgs[0]?.getAttribute('src')).toContain('file=ep02-0.png')
    expect(imgs[1]?.getAttribute('src')).toContain('n=1')
    expect(imgs[1]?.getAttribute('src')).toContain('file=ep02-1.png')
  })

  it('有动感数据时渲染曲线，没有时整块不渲染', () => {
    const withMotion = mount(<StoryboardViewer report={REPORT} />)
    const chart = withMotion.querySelector('[data-testid="motion-chart"]')
    expect(chart).not.toBeNull()
    // 占位组件把折线数据点数透传出来：curve 有 5 个点
    expect(chart?.getAttribute('data-points')).toBe('5')
    act(() => {
      root?.unmount()
    })
    container?.remove()

    const withoutMotion = mount(<StoryboardViewer report={{ ...REPORT, motion: undefined }} />)
    expect(withoutMotion.querySelector('[data-testid="motion-chart"]')).toBeNull()
    expect(withoutMotion.querySelector('[data-testid="motion-curve"]')).toBeNull()
    // 三个镜头里只有前两个自带 shot.motion，第三个没有测量值 → 显示占位
    expect(withoutMotion.textContent).toContain('动感 —')
  })

  it('formatTimecode 按 mm:ss.S 补零，非法值给占位', () => {
    expect(formatTimecode(0)).toBe('00:00.0')
    expect(formatTimecode(3.5)).toBe('00:03.5')
    expect(formatTimecode(65.4)).toBe('01:05.4')
    expect(formatTimecode(600.2)).toBe('10:00.2')
    expect(formatTimecode(-1)).toBe('--:--.-')
    expect(formatTimecode(Number.NaN)).toBe('--:--.-')
  })

  it('点击镜头行会高亮（并按 sheet 映射滚动到对应宫格图）', () => {
    const el = mount(<StoryboardViewer report={REPORT} />)

    const row = el.querySelector('[data-testid="shot-row"][data-shot-index="1"]') as HTMLElement | null
    expect(row).not.toBeNull()
    expect(row?.className).not.toContain('--active')

    act(() => {
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(row?.className).toContain('wa-shot-row--active')
    // 镜头 1 在 sheet 0 里，点击后应触发 scrollIntoView
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
  })
})

/* ─────────────────────────────────────────────────────────
 * WatchTab
 * ───────────────────────────────────────────────────────── */

describe('WatchTab', () => {
  it('依赖不全：列出缺失项和补装提示，且不能开始分析', async () => {
    apiMocks.getDeps.mockResolvedValue({
      ok: false,
      canRun: false,
      deps: [
        {
          id: 'ffmpeg',
          label: 'FFmpeg',
          ok: false,
          required: true,
          hint: 'winget install Gyan.FFmpeg（装完重启 AnimeDiary）',
          detail: '拉片的所有解码、抽帧、拼图都依赖它',
        },
        {
          id: 'storyboard',
          label: '分镜引擎（dsh-video-storyboard）',
          ok: false,
          required: true,
          hint: '在项目根目录执行 npm install（正式版会随安装包一起发布）',
        },
        {
          id: 'asr',
          label: '语音识别（ASR）',
          ok: false,
          required: false,
          hint: '可选：配一个 OpenAI 兼容的 ASR 端点',
        },
      ],
      missingRequired: ['ffmpeg', 'storyboard'],
    })
    apiMocks.getReport.mockRejectedValue(new Error('这一集还没有分析报告'))

    const el = await mountAsync(
      <WatchTab animeKey="模板::葬送的芙莉莲" episode={2} title="葬送的芙莉莲" />,
    )

    await waitFor(() => (el.textContent ?? '').includes('winget install Gyan.FFmpeg'))

    // 两个必装缺失项
    expect(el.querySelectorAll('[data-testid="missing-dep"]')).toHaveLength(2)
    expect(el.textContent).toContain('缺少必需的依赖')
    expect(el.textContent).toContain('在项目根目录执行 npm install')
    // 可选依赖单独提示，带各自 hint，不说成「不能跑」
    expect(el.textContent).toContain('可选依赖未就绪')
    expect(el.textContent).toContain('语音识别（ASR）')
    expect(el.textContent).toContain('可选：配一个 OpenAI 兼容的 ASR 端点')
    // 没跑过分析：显示引导
    expect(el.textContent).toContain('还没有分析过这一集')

    // 关键断言：不能假装能跑 —— 所有「开始分析」按钮都是禁用态
    const startButtons = Array.from(el.querySelectorAll('button')).filter((button) =>
      (button.textContent ?? '').includes('开始分析'),
    )
    expect(startButtons.length).toBeGreaterThan(0)
    expect(startButtons.every((button) => (button as HTMLButtonElement).disabled)).toBe(true)
  })

  it('已有报告：直接进入完成态，渲染镜头行与预算条', async () => {
    apiMocks.getDeps.mockResolvedValue({
      ok: true,
      canRun: true,
      deps: [
        { id: 'ffmpeg', label: 'FFmpeg', ok: true, required: true, version: '7.1' },
        { id: 'storyboard', label: '分镜引擎（dsh-video-storyboard）', ok: true, required: true },
      ],
      missingRequired: [],
    })
    apiMocks.getReport.mockResolvedValue(REPORT)

    const el = await mountAsync(
      <WatchTab animeKey="模板::葬送的芙莉莲" episode={2} title="葬送的芙莉莲" />,
    )

    await waitFor(() => el.querySelectorAll('[data-testid="shot-row"]').length === REPORT.shots.length)

    expect(el.textContent).toContain('分析完成')
    expect(el.textContent).toContain('本集预算')
    expect(el.textContent).toContain('已用 250,000')
    // 有报告时不需要再引导「开始分析」
    expect(el.textContent).not.toContain('还没有分析过这一集')
    // 依赖齐全，重新分析按钮可点
    const rerun = Array.from(el.querySelectorAll('button')).find((button) =>
      (button.textContent ?? '').includes('重新分析'),
    ) as HTMLButtonElement | undefined
    expect(rerun).toBeDefined()
    expect(rerun?.disabled).toBe(false)
  })
})
