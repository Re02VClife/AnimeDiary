/**
 * adapters/shot-builder — 从切点推导真实镜头
 *
 * 为什么单独一个文件：这段逻辑以前埋在 worker.mjs 里，没法单测；
 * 而它决定「镜头清单」的全部内容，错了用户一眼就能看出来（2026-11-17 的两次反馈
 * 都出在这：先是把格子当镜头，接着是误检切点把镜头切碎成 0.1 秒）。
 *
 * 两个已知的误检来源（hsv-diff 的固有毛病）：
 *   - 闪白 / 闪光（角色出招、回忆闪回）→ 一帧内亮度突变，被当成切点；
 *   - 快速运动 / 甩镜 → 帧差大，被当成切点。
 * 它们的共同特征是**间隔极短**（0.1–0.3 秒），真实动画剪辑很少有短于 0.3 秒的镜头
 * （按 24fps 算不到 7 帧）。所以这里做「最小镜头时长」合并。
 */

/** 最短镜头：短于它的切点视为误检，合并到前一个镜头里 */
export const MIN_SHOT_SECONDS = 0.3

/**
 * @param {Array<{ t: number }>} cuts 切点（秒），不要求有序
 * @param {number} duration 视频总长（秒）
 * @param {{ minShotSeconds?: number }} [opts]
 * @returns {Array<{ i: number, start: number, end: number, duration: number, tier: number, merged: number }>}
 */
export function buildShotsFromCuts(cuts, duration, opts = {}) {
  const total = Number(duration)
  if (!Number.isFinite(total) || total <= 0) return []

  const minShot = Number.isFinite(opts.minShotSeconds) && opts.minShotSeconds > 0
    ? Number(opts.minShotSeconds)
    : MIN_SHOT_SECONDS

  const points = (cuts ?? [])
    .map((cut) => Number(cut.t))
    .filter((t) => Number.isFinite(t) && t > 0.05 && t < total - 0.05)
    .sort((a, b) => a - b)

  // 合并过近的切点：0.1 秒连切三刀在真实剪辑里不存在，是同一处误检
  const boundaries = [0]
  let merged = 0
  for (const t of points) {
    const last = boundaries[boundaries.length - 1]
    if (t - last < minShot) {
      merged += 1
      continue
    }
    boundaries.push(t)
  }
  boundaries.push(total)

  const shots = []
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index]
    const end = boundaries[index + 1]
    if (end - start < 0.05) continue
    shots.push({
      i: shots.length,
      start: Math.round(start * 100) / 100,
      end: Math.round(end * 100) / 100,
      duration: Math.round((end - start) * 100) / 100,
      // grid6 没有分档语义；保留字段兼容，UI 不再显示"档位"
      tier: 2,
      // 这一段里被并掉了几个误检切点（写进报告便于复盘"检测到底多吵"）
      merged: index === 0 ? merged : 0,
    })
  }
  return shots
}
