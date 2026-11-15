/**
 * ports/music — 配乐证据接口
 *
 * 与其它 port 的区别：这一层**特别容易把推断当测量**。
 * 「这里 BPM 128」是测量，「这里进入副歌」是推断 —— 两者必须分开放，
 * 上层提示词才能明确告诉模型哪些能当事实引用。
 *
 * 当前实现：`adapters/music-mee.ts`（Music Evidence Engine CLI）
 * 降级实现：`adapters/music-none.ts`（返回空，报告里注明「本集未做配乐分析」）
 */
import type { MusicEvidence, ReadyState, VideoRef } from '../core/types'

export interface TimeWindow {
  from: number
  to: number
}

export interface MusicOptions {
  signal?: AbortSignal
  /** 只分析这些时间窗；省略 = 引擎自己决定（通常按固定长度滑窗） */
  windows?: TimeWindow[]
  /** 窗长（秒），引擎在没给 windows 时用 */
  windowSeconds?: number
  onProgress?: (processed: number, total: number) => void
}

export interface MusicResult {
  windows: MusicEvidence[]
  /** 引擎版本/模型，写进报告 */
  engine: string
  /** 引擎自报的限制，例如「跨段落的调性变化不可靠」 */
  notes?: string[]
}

export interface MusicProvider {
  readonly id: string
  readonly label: string
  ready(): Promise<ReadyState>
  analyze(video: VideoRef, opts?: MusicOptions): Promise<MusicResult>
}
