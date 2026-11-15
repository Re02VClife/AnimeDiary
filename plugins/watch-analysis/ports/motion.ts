/**
 * ports/motion — 动感/作画密度测量接口
 *
 * 输入是切好的镜头，输出每个镜头的动感和整集折线。
 *
 * **性能关键设计**：`opts.frameScores` 允许上游把已经算好的逐帧变化分传进来。
 * 切镜阶段本来就要逐帧比一次，动感阶段再解一遍码是纯浪费 ——
 * 这条通道让 Phase 2 的动感做到「零额外解码」。
 */
import type { ReadyState, Shot, ShotMotion, VideoRef } from '../core/types'

export interface MotionOptions {
  signal?: AbortSignal
  /**
   * 逐帧变化分（0–255），下标是帧号。
   * 传了就不重新解码；不传则 adapter 自己算。
   */
  frameScores?: Float32Array
  /** 视频帧率，用于把帧号折算成秒；不传从 video.fps 取 */
  fps?: number
  onProgress?: (processed: number, total: number) => void
}

export interface MotionResult {
  perShot: ShotMotion[]
  /** 整集折线：[秒, 变化分]，用于 UI 画曲线 */
  curve: Array<[number, number]>
  /** 引擎自报的口径说明，例如「变化分不等于原画张数」 */
  note?: string
}

export interface MotionProvider {
  readonly id: string
  readonly label: string
  ready(): Promise<ReadyState>
  measure(video: VideoRef, shots: Shot[], opts?: MotionOptions): Promise<MotionResult>
}
