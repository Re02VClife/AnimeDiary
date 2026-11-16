/**
 * runtime/pipeline — 拉片分析的业务编排
 *
 * 它做的事只有三件：
 *   1. 把「一部番的某一集」翻译成 worker 能吃的 request（路径、输出目录、选项）
 *   2. 等 worker 回 payload
 *   3. 把 payload 映射成 `WatchReport` 并落盘
 *
 * **不碰进程管理**（job 的事）、**不碰 HTTP**（routes 的事）、
 * **不碰具体引擎**（adapter 的事）。换切镜引擎只换 adapter，这个文件一行不动。
 */
import path from 'node:path'
import fs from 'node:fs'
import { createJobManager } from './job'
import type { JobSnapshot, WatchJobManager } from './job'
import type { WatchAnalyzeOptions, WatchWorkerResult } from './protocol'
import type { WatchReport } from '../core/types'
import type { WatchStore } from '../server/store'

export interface AnalyzerOptions {
  DATA_DIR: string
  /** worker.mjs 绝对路径（打包后和 dev 不同，所以由调用方探测） */
  workerPath: string
  store: WatchStore
  /** 写进报告的软件版本 */
  appVersion: string
  /** worker 的输出根目录；默认 {DATA_DIR}/watch-reports */
  outputRoot?: string
  /**
   * 每次 analyze 时读一次性能设置（用户可能刚在面板上改过）。
   * 返回的值会：① 作为 options.performance 传给 worker/renderer；② 作为 worker 进程优先级。
   */
  performance?: () => { concurrency: number; threads: number; priority?: 'normal' | 'below-normal' | 'low' }
}

export interface AnalyzeRequest {
  /** `模板::标题` */
  key: string
  /** 第几集，从 1 开始 */
  episode: number
  /** 视频绝对路径 */
  file: string
  /** 调用方只需要给想覆盖的字段；outDir / prefix 由 pipeline 按 key+episode 算 */
  options?: Partial<WatchAnalyzeOptions>
}

export interface WatchAnalyzer {
  analyze(req: AnalyzeRequest): { jobId: string }
  status(jobId: string): JobSnapshot | null
  cancel(jobId: string): boolean
  /** 任务列表（进行中 + 最近结束），UI 用来恢复后台任务 */
  list(): JobSnapshot[]
  /** 任务跑完后写好的报告（未完成或失败时为 null） */
  result(jobId: string): WatchReport | null
}

/** 默认策略：auto 让 storyboard 自己按时长定张数，我们只给预算上限 */
const DEFAULT_OPTIONS: Required<Pick<WatchAnalyzeOptions, 'strategy' | 'budgetPixels' | 'transcript'>> = {
  strategy: 'auto',
  budgetPixels: 360_000,
  transcript: 'auto',
}

/** 把 payload 映射成落盘结构。**这里不做任何判断**，只搬运 + 补元数据。 */
export function buildReport(
  payload: WatchWorkerResult,
  request: { key: string; episode: number; file: string },
  appVersion: string,
): WatchReport {
  return {
    schema: 1,
    key: request.key,
    episode: request.episode,
    video: {
      file: request.file,
      duration: payload.video.duration,
      fps: payload.video.fps,
      width: payload.video.width,
      height: payload.video.height,
    },
    engine: {
      storyboard: 'dsh-video-storyboard',
      cut: 'hsv',
      transcript: payload.transcript?.source ?? 'none',
      motion: 'none',
      music: 'none',
    },
    shots: payload.shots.map((shot) => ({
      i: shot.i,
      start: shot.start,
      end: shot.end,
      sampled: false,
      tier: shot.tier,
      ...(shot.text ? { text: shot.text } : {}),
      cell: {
        // sheet 序号和坐标在 storyboard 的 cell 里没直接给，
        // 这里只填 sheet 编号（能在哪个文件里找到），x/y 由 UI 按图顺序推
        sheet: payload.sheets.findIndex((sheet) => sheet.shots.includes(shot.i)),
        x: 0,
        y: 0,
      },
    })),
    cuts: payload.cuts.map((cut) => ({
      t: cut.t,
      score: cut.score,
      engine: 'hsv',
    })),
    ...(payload.danmaku ? { danmaku: payload.danmaku } : {}),
    ...(payload.transcript
      ? {
          transcript: {
            source: payload.transcript.source,
            segments: payload.transcript.segments.map((segment) => ({
              start: segment.start,
              end: segment.end,
              text: segment.text,
              source: payload.transcript!.source,
              // 说话人只有 ASR 才有；外挂字幕没有就不写这个字段（别塞 undefined 进去）
              ...(segment.speaker ? { speaker: segment.speaker } : {}),
            })),
            ...(payload.transcript.notes?.length ? { notes: payload.transcript.notes } : {}),
            ...(payload.transcript.speakers ? { speakers: payload.transcript.speakers } : {}),
          },
        }
      : {}),
    ...(payload.audio ? { loudness: payload.audio } : {}),
    ...(payload.plan
      ? {
          render: {
            strategy: payload.plan.strategy,
            sheets: payload.plan.sheets,
            frames: payload.plan.frames,
            fill: payload.plan.fill,
            canvas: payload.plan.canvas,
            tiers: payload.plan.tiers,
          },
        }
      : {}),
    ...(payload.warnings?.length ? { notes: payload.warnings } : {}),
    sheets: payload.sheets,
    budget: { limit: 2_000_000, spent: 0, byKind: {}, reserved: 0, exhausted: false },
    timing: {
      total: payload.timing.total ?? 0,
      probe: payload.timing.probe,
      scan: payload.timing.scan,
      render: payload.timing.render,
      transcript: payload.timing.transcript,
    },
    created: new Date().toISOString(),
    appVersion,
  }
}

export function createAnalyzer(opts: AnalyzerOptions): WatchAnalyzer {
  const jobs: WatchJobManager = createJobManager()
  const outputRoot = opts.outputRoot ?? path.join(opts.DATA_DIR, 'watch-reports')
  /** jobId → 完成后的报告（成功后才有） */
  const finished = new Map<string, WatchReport>()

  function analyze(request: AnalyzeRequest): { jobId: string } {
    // 输出目录交给 store 决定，保证"报告"和"图"永远在同一个 key 目录下
    const outDir = opts.store.sheetDir(request.key, request.episode)
    const prefix = `ep${String(request.episode).padStart(2, '0')}`
    // 每次 analyze 都重读一次设置：用户可能刚把 CPU 上限从 100% 调到 25%
    const perf = opts.performance?.()
    const options: WatchAnalyzeOptions = {
      ...DEFAULT_OPTIONS,
      ...request.options,
      outDir,
      prefix,
      ...(perf ? { performance: { concurrency: perf.concurrency, threads: perf.threads } } : {}),
    }

    const jobId = jobs.start({
      input: request.file,
      key: request.key,
      episode: request.episode,
      outDir,
      prefix,
      workerPath: opts.workerPath,
      options,
      priority: perf?.priority,
      onResult: async (payload) => {
        // worker 说成功不等于数据可用：最低限度的形状校验，坏数据宁可报错也别落盘
        if (!Array.isArray(payload.shots) || payload.shots.length === 0) {
          throw new Error('分析结果为空：没有识别到任何镜头')
        }
        if (!Array.isArray(payload.sheets) || payload.sheets.length === 0) {
          throw new Error('分析结果为空：没有生成分镜图')
        }
        const report = buildReport(payload, request, opts.appVersion)
        opts.store.write(report)
        finished.set(jobId, report)
      },
      onError: (message) => {
        // 错误已经写进 job 状态，这里只留痕
        console.warn(`[watch] job 失败 ${request.key} ep${request.episode}: ${message}`)
      },
    })

    return { jobId }
  }

  return {
    analyze,
    status: (jobId) => jobs.status(jobId),
    cancel: (jobId) => jobs.cancel(jobId),
    list: () => jobs.list(),
    result: (jobId) => finished.get(jobId) ?? null,
  }
}

/** 探测 worker.mjs 的路径：dev 在源码目录，打包后在 asar.unpacked 里 */
export function resolveWorkerPath(): string {
  // `__dirname` 在 esbuild 打出来的 CJS 里有；在 vitest 的 ESM 运行时里没有，
  // 所以要判存在 —— 否则这条兜底路径会在测试环境直接 ReferenceError。
  const hereDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd()
  const candidates = [
    // dev / 源码运行
    path.join(process.cwd(), 'plugins', 'watch-analysis', 'runtime', 'worker.mjs'),
    // 打包后（asarUnpack 出去的资源目录）
    path.join((process as any).resourcesPath ?? '', 'app.asar.unpacked', 'plugins', 'watch-analysis', 'runtime', 'worker.mjs'),
    // 兜底：相对 __dirname 往上找（esbuild 打出来后 __dirname 变成 server/）
    path.join(hereDir, '..', 'plugins', 'watch-analysis', 'runtime', 'worker.mjs'),
  ]
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch { /* 下一个 */ }
  }
  // 都找不到时返回第一个：让 job 启动时报"命令不存在"，比在这里静默返回空字符串好排查
  return candidates[0]
}
