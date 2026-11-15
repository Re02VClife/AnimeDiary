/**
 * runtime/protocol — worker 子进程与 HTTP 层的数据契约
 *
 * **这是 Phase 1 的冻结点。** 三个并行开发方向（worker 适配器 / 字幕解析 / UI）
 * 都以这个文件为准，谁都不许私自改形状 —— 要改先改这里，再通知另外两方。
 *
 * 为什么 worker 要独立子进程：
 *   1. `dsh-video-storyboard` 是纯 ESM 包，主进程的 api-routes.cjs 是 CJS bundle，
 *      直接 import 会在构建期/运行期两头炸；
 *   2. 解码一集 24 分钟的视频会吃满 CPU，放在主进程里会卡住整个界面；
 *   3. 取消任务 = 杀子进程树，比在单线程里插检查点干净得多。
 *
 * 通信协议：一行一个 JSON（stdout），**不要往 stdout 打日志** —— 日志走 stderr。
 */
import type { BudgetLedger, Sheet, Shot, WatchPhase } from '../core/types'
import type { RenderStrategy } from '../ports/render'

// ─────────────────────────────────────────────────────────────
// 主进程 → worker
// ─────────────────────────────────────────────────────────────

export interface WatchWorkerRequest {
  kind: 'analyze'
  /** 视频绝对路径 */
  input: string
  /** `模板::标题` */
  key: string
  /** 第几集，从 1 开始 */
  episode: number
  options: WatchAnalyzeOptions
}

export interface WatchAnalyzeOptions {
  /** 档位策略，默认 auto */
  strategy?: RenderStrategy
  /** 最多取多少帧；0 = 不封顶 */
  maxFrames?: number
  /** 最多几张图；0 = 不封顶 */
  maxSheets?: number
  /** 单图像素预算；默认 360000（800×450 ≈ 233 token） */
  budgetPixels?: number
  /** 台词来源：auto 走字幕轨/ASR，off 完全不要台词 */
  transcript?: 'auto' | 'off'
  /** 只分析这一段（秒） */
  from?: number
  to?: number
  /** 宫格图输出目录（绝对路径），由主进程创建好传进来 */
  outDir: string
  /** 文件名前缀，例如 `ep01` */
  prefix: string
  /** token 预算，worker 只在需要发图时参考（Phase 1 只落盘不调模型） */
  budget?: BudgetLedger
}

// ─────────────────────────────────────────────────────────────
// worker → 主进程（stdout 每行一个）
// ─────────────────────────────────────────────────────────────

export type WatchWorkerEvent =
  | { type: 'ready'; pid: number; storyboardVersion?: string }
  | { type: 'progress'; phase: WatchPhase; percent: number; message: string }
  | { type: 'result'; payload: WatchWorkerResult }
  | { type: 'error'; message: string; stack?: string; phase?: WatchPhase }

/**
 * worker 的产出。
 *
 * 刻意**不复用** `dsh-video-storyboard` 的原始返回结构：
 *   - 它带 Buffer/PNG 二进制，穿 IPC 要 base64，白白膨胀几十 MB
 *   - 它有 60+ 字段，大部分我们不用，但每次上升级都可能变
 * 所以 worker 内部做完映射，只交出这个稳定形状。
 */
export interface WatchWorkerResult {
  video: {
    duration: number
    fps: number
    width: number
    height: number
    hasAudio: boolean
    hasSubtitle: boolean
  }
  /**
   * 切点。`t` 是切点秒数；`score` 是本引擎的分数（0–255，不同引擎不可比）；
   * `kind` 是引擎给的分类（`hardcut` / `motion` / `flash`…），只作参考。
   */
  cuts: Array<{ t: number; score: number; kind?: string }>
  /**
   * 镜头序列。`i` 从 0 开始（storyboard 的 cell 从 1 开始，worker 负责 -1）。
   * `text` 是这一格时间范围内的台词（可能为空）。
   */
  shots: Array<{
    i: number
    start: number
    end: number
    /** 取帧时刻（格子的代表帧） */
    frameAt: number
    tier: number
    text?: string
    /** 该格内部有几个切点 */
    cuts?: number
  }>
  sheets: Sheet[]
  transcript?: {
    source: string
    model?: string
    /** 完整台词（句粒度），按时间排序 */
    segments: Array<{ start: number; end: number; text: string }>
    /** 字符数，用于报告里的"台词密度" */
    chars: number
    /** 引擎自报的不可信提示 */
    notes?: string[]
  }
  /**
   * 音轨证据（EBU R128 响度序列）。
   * 它同时是两个东西的数据源：宫格图底部的音轨条，以及报告里的"响度曲线"。
   */
  audio?: {
    mean: number
    peak: number
    /** 每 step 秒一个采样 */
    series: number[]
    step: number
    /** 静音区间（秒），匹配 dsh-see-now 的口径 */
    silences: Array<[number, number]>
  }
  /** 各阶段实测耗时（秒） */
  timing: Record<string, number>
  /** 引擎警告，例如「连续运镜导致切点数不可信」 */
  warnings?: string[]
  /** storyboard 的实际 plan（档位/填充率/张数），写进报告便于复盘 */
  plan: {
    strategy: string
    sheets: number
    frames: number
    fill: number
    canvas: { width: number; height: number }
    tiers: Record<string, number>
  }
}

// ─────────────────────────────────────────────────────────────
// HTTP 契约（UI 只认这里）
// ─────────────────────────────────────────────────────────────

/** POST /api/watch/analyze 的请求体 */
export interface AnalyzeBody {
  /** `模板::标题` */
  key: string
  /** 第几集，从 1 开始 */
  episode: number
  /**
   * 视频绝对路径。**可以省略** —— 省略时宿主用本地番剧库的绑定目录
   * 按 key+episode 解析。前端一般不该传它（它拿不到可信的绝对路径）。
   */
  file?: string
  options?: Partial<WatchAnalyzeOptions>
}

/** POST /api/watch/analyze 的响应 */
export interface AnalyzeResponse {
  ok: boolean
  jobId?: string
  error?: string
}

/** GET /api/watch/status?jobId= 的响应 */
export interface StatusResponse {
  ok: boolean
  job?: {
    jobId: string
    key: string
    episode: number
    phase: WatchPhase
    percent: number
    message: string
    spent: number
    startedAt: number
    error?: string
  }
  error?: string
}

/** GET /api/watch/report?key=&episode= 的响应 —— report 形状见 core/types.ts 的 WatchReport */
export interface ReportResponse {
  ok: boolean
  report?: unknown
  error?: string
}
