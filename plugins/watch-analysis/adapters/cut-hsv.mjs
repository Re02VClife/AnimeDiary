/**
 * adapters/cut-hsv — 切镜引擎：复用 dsh-video-storyboard 的逐帧 HSV 差分
 *
 * 为什么是这个文件：
 *   `dsh-video-storyboard` 的扫描阶段（`scanShots`）已经把"解码 → 缩到 64×36 →
 *   逐帧 HSV 加权差分 → 自适应阈值 → 并事件 / 抑制近邻 → 补渐变转场"整条链路做完了，
 *   而且它同时产出**逐帧分数、亮度均值、16×9 指纹**。我们的 render 阶段马上要用这批数据
 *   做"档位 = 切点密度"的排版，重扫一遍要再解一次码（24 分钟一集约 20–30s），
 *   所以 detect() 把 `scanShots` 的**完整返回**原样带出去（`raw`），
 *   由 render adapter 通过 `runStoryboard({ precomputed })` 复用，避免二次扫描。
 *
 * 和 `CutProvider` 的唯一形状差异：`detect()` 返回 `{ cuts, raw }` 而不是裸数组。
 * 多出来的 `raw` 是给同进程内的 render adapter 用的（不穿 IPC，也不会进协议），
 * `cuts` 才是端口语义上的返回值。worker 只读 `cuts`。
 *
 * 已冻结的依赖契约（升级 dsh-video-storyboard 后先跑
 * `scripts/probe-storyboard-contract.mjs` 复核）：
 *   scanShots({ input, fps, threshold, minGap, start, end, signal, onProgress })
 *     → { cuts: [{ t, score }], stats, longStats, frames, threshold, degraded,
 *         summary, scoring, means, prints, bars }
 */
import { scanShots } from 'dsh-video-storyboard/scan'

/**
 * 估算总帧数，只用于进度条分母（scanShots 自己不知道总长）。
 * 估不出来时按端口约定返回 -1（"total 未知"）。
 *
 * @param {{ duration?: number, fps?: number }} video
 * @param {number} from 秒
 * @param {number|undefined} to 秒
 * @returns {number} 帧数，未知时 -1
 */
function estimateFrames(video, from, to) {
  const fps = Number(video?.fps)
  const duration = Number(video?.duration)
  const end = to !== undefined ? to : duration
  if (!(fps > 0) || !Number.isFinite(end) || !(end > from)) return -1
  return Math.max(1, Math.round((end - from) * fps))
}

/**
 * 闪白/闪光过滤：切点帧的亮度是**单帧尖峰**（比前后 3 帧都高一截），且前后亮度本身接近。
 *
 * 真剪前后的亮度是"换了一个稳定水平"（黑场转白场、白天转夜晚），前后不会回落到同一水平；
 * 而闪白只是闪一下，前后画面其实连着 —— 这正是 hsv-diff 最容易误判的一类。
 * 数据来自 scanShots 的 `means`（逐帧 V 均值）。
 */
const FLASH_WINDOW = 3
const FLASH_DELTA = 28
const FLASH_STEADY = 12

function average(values) {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/** 这一帧是不是"只闪一下" */
export function isFlashFrame(means, index) {
  if (!Array.isArray(means) || index <= 0 || index >= means.length) return false
  const value = Number(means[index])
  if (!Number.isFinite(value)) return false

  const before = means
    .slice(Math.max(0, index - FLASH_WINDOW), index)
    .map(Number)
    .filter(Number.isFinite)
  const after = means
    .slice(index + 1, Math.min(means.length, index + 1 + FLASH_WINDOW))
    .map(Number)
    .filter(Number.isFinite)
  if (before.length === 0 || after.length === 0) return false

  const beforeAvg = average(before)
  const afterAvg = average(after)
  return (
    value - beforeAvg > FLASH_DELTA &&
    value - afterAvg > FLASH_DELTA &&
    Math.abs(beforeAvg - afterAvg) < FLASH_STEADY
  )
}

/**
 * 过滤掉闪白切点。`raw.means` 是逐帧亮度均值，帧号 = round(t * fps)。
 * 拿不到 means（老版本/降级）时原样返回，不猜。
 */
export function filterFlashCuts(raw, fps) {
  const cuts = Array.isArray(raw?.cuts) ? raw.cuts : []
  const means = Array.isArray(raw?.means) ? raw.means : null
  if (!means || !(fps > 0)) return cuts
  return cuts.filter((cut) => !isFlashFrame(means, Math.round(Number(cut.t) * fps)))
}

export const cutHsvProvider = {
  /** 稳定 id —— 会写进报告的 `engine.cut`，改名等于让历史报告对不上 */
  id: 'hsv',
  label: 'HSV 差分（dsh-video-storyboard）',

  /**
   * 依赖是否就绪。
   * 扫描靠 ffmpeg，但 ffmpeg 是 eager 检查不了的（PATH 里没有时 ffmpeg 会在 detect 里报错），
   * 这里只回答"包能 import、无需用户配置"，真正缺 ffmpeg 时由 detect 抛错、pipeline 降级。
   */
  async ready() {
    return { ok: true, detail: '内置，无需外部依赖' }
  },

  /**
   * 检测切点。
   *
   * @param {{ file: string, duration?: number, fps?: number, width?: number, height?: number }} video
   * @param {{
   *   from?: number, to?: number, threshold?: number|'auto',
   *   signal?: AbortSignal, onProgress?: (processed: number, total: number) => void,
   * }} [opts]
   * @returns {Promise<{ cuts: Array<{ t: number, score: number }>, raw: object }>}
   */
  async detect(video, opts = {}) {
    if (!video?.file) throw new Error('cut-hsv: video.file 缺失，无法扫描')
    const fps = Number(video.fps)
    if (!(fps > 0)) throw new RangeError(`cut-hsv: video.fps 必须是正数，收到 ${video.fps}`)

    const from = Number(opts.from) > 0 ? Number(opts.from) : 0
    const to = Number(opts.to) > 0 ? Number(opts.to) : undefined
    const total = estimateFrames(video, from, to)

    const raw = await scanShots({
      input: video.file,
      fps,
      threshold: opts.threshold ?? 'auto',
      /*
       * 近邻抑制：以前是 0（注释说"要留下快闪"），但实测一集产生 **212 个 <0.2 秒**的
       * "镜头"（2026-11-17 用户反馈"分得太密"）。动画剪辑里短于 6 帧（0.25s）的连切
       * 基本都是闪白/运动误检，留在扫描阶段就把它们并掉，比事后修补更干净
       * （报告的 `cuts` 数量也才可信）。
       */
      minGap: 0.25,
      start: from,
      ...(to !== undefined ? { end: to } : {}),
      signal: opts.signal,
      // scanShots 的进度回调是对象 { frames, lastScore }，端口要的是 (processed, total)
      onProgress: (progress) => {
        opts.onProgress?.(Number(progress?.frames) || 0, total)
      },
    })

    // 闪白/闪光二次过滤：切点帧亮度是单帧尖峰，前后都回落到同一水平
    const filtered = filterFlashCuts(raw, fps)
    // 让 raw 与 cuts 保持一致（storyboard 策略会复用 raw.precomputed）
    if (raw && Array.isArray(raw.cuts)) raw.cuts = filtered

    return { cuts: filtered.map((c) => ({ t: c.t, score: c.score })), raw }
  },
}
