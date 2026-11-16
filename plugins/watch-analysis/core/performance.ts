/**
 * core/performance — 分析时的"性能预留"口径
 *
 * 为什么这件事只能做到这个程度（先说实话，免得后面误以为能"硬预留 GPU"）：
 *
 *   - **扫描阶段**的 ffmpeg 由 `dsh-video-storyboard` 内部启动，我们拿不到命令行，
 *     加不了 `-threads`。这一阶段是整条链路里最吃 CPU 的（一集 24 分钟满核 20–30 秒）。
 *   - **渲染/抽帧**是我们自己的 ffmpeg，可以控制线程数与并发。
 *   - **GPU** 只被 MOSS 转写用（CUDA），单卡上没法"预留显存"；能做的是串行 + 低优先级。
 *
 * 所以这个模块给的是两个**真实有效**的旋钮：
 *   1. `cpuPercent` → 抽帧并发数 + ffmpeg 线程数（只作用于我们自己的 ffmpeg）
 *   2. `priority`   → worker 子进程的优先级类（Windows 上 ffmpeg 子进程会继承，
 *                      系统前台应用因此不会被抢到卡死）
 *
 * 纯函数，不碰 fs/进程 —— 单测直接喂不同核数看映射结果。
 */

/** 用户在面板上能选的 CPU 上限档位（%） */
export const CPU_PERCENT_CHOICES = [25, 50, 75, 100] as const

/** 子进程优先级：和 Node 的 `os.constants.priority` 一一对应 */
export type WatchPriority = 'normal' | 'below-normal' | 'low'

export interface PerformanceSettings {
  /** 分析时最多用多少 CPU（25–100） */
  cpuPercent: number
  /** 子进程优先级 */
  priority: WatchPriority
  /**
   * ASR 分段秒数（60–600，默认 180）。
   *
   * 24 分钟整段喂给 MOSS 会 CUDA OOM（实测要 20.97GB，卡只有 10GB）；
   * 显存小就调小，显存大可以调大以少加载几次模型（每段重新加载约 2 秒）。
   */
  asrChunkSeconds: number
}

/** ASR 分段的默认值与边界 */
export const ASR_CHUNK_DEFAULT = 180
export const ASR_CHUNK_MIN = 60
export const ASR_CHUNK_MAX = 600

export interface ResolvedPerformance {
  /** 抽帧 ffmpeg 的进程内并发（同时跑几个） */
  concurrency: number
  /** 单个 ffmpeg 的 `-threads`（0 = 不传，交给 ffmpeg 自己决定） */
  threads: number
  /** 实际按几核在算（写进日志，便于用户反馈"我 32 核怎么只用了 4 线程"） */
  cores: number
  /** 归一化后的百分比（非法输入会被夹住） */
  cpuPercent: number
  /** ASR 分段秒数（已归一化） */
  asrChunkSeconds: number
}

export const DEFAULT_PERFORMANCE: PerformanceSettings = {
  cpuPercent: 50,
  priority: 'below-normal',
  asrChunkSeconds: ASR_CHUNK_DEFAULT,
}

/** 把 ASR 分段夹进 60–600；非法值回落到默认 180 */
export function normalizeAsrChunkSeconds(value: unknown): number {
  const number = Number(value)
  if (!Number.isFinite(number)) return ASR_CHUNK_DEFAULT
  return Math.min(ASR_CHUNK_MAX, Math.max(ASR_CHUNK_MIN, Math.round(number)))
}

/** 把用户的百分比夹进 25–100；非法值回落到默认 50 */
export function normalizeCpuPercent(value: unknown): number {
  const number = Number(value)
  if (!Number.isFinite(number)) return DEFAULT_PERFORMANCE.cpuPercent
  return Math.min(100, Math.max(25, Math.round(number)))
}

export function normalizePriority(value: unknown): WatchPriority {
  return value === 'normal' || value === 'low' || value === 'below-normal'
    ? value
    : DEFAULT_PERFORMANCE.priority
}

/**
 * 百分比 → 具体线程/并发。
 *
 * 映射规则（刻意保守）：
 *   - `threads = max(1, floor(cores × pct))`：例如 16 核 50% → 8 线程
 *   - `concurrency = clamp(1, 4, floor(threads / 2))`：每个抽帧 ffmpeg 自己也要吃线程，
 *     并发给一半，避免"4 个进程 × 8 线程"把核数翻倍占掉
 *
 * 注意 `concurrency` 上限固定 4：再高对单集抽帧没有收益（实测瓶颈在 ffmpeg 启动开销）。
 */
export function resolvePerformance(
  settings: Partial<PerformanceSettings> | null | undefined,
  cores: number,
): ResolvedPerformance {
  const safeCores = Number.isFinite(cores) && cores > 0 ? Math.floor(cores) : 1
  const cpuPercent = normalizeCpuPercent(settings?.cpuPercent)
  const ratio = cpuPercent / 100
  const threads = Math.max(1, Math.floor(safeCores * ratio))
  const concurrency = Math.max(1, Math.min(4, Math.floor(threads / 2)))
  return {
    concurrency,
    threads,
    cores: safeCores,
    cpuPercent,
    asrChunkSeconds: normalizeAsrChunkSeconds(settings?.asrChunkSeconds),
  }
}
