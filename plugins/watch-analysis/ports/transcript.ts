/**
 * ports/transcript — 台词来源接口
 *
 * 三种来源共用一个接口，`priority` 决定尝试顺序（数字小的先试）：
 *   0  视频内嵌字幕轨（最准，不花钱）
 *   1  同目录 ASS/SRT 文件（次准，不花钱）
 *   2  ASR 语音识别（兜底，可能错字）
 *
 * **约定：transcribe() 返回空数组表示"这个 provider 对这个文件无能为力"，
 * 不算错误**，pipeline 会继续试下一个。只有真正的异常才抛错。
 *
 * 这条约定让"这个片有没有字幕"变成一次探测，而不是先问一遍再干一遍。
 */
import type { ReadyState, Segment, VideoRef } from '../core/types'

export interface TranscriptResult {
  segments: Segment[]
  /** 实际来源标识，写进报告（`subtitle-track` / `subtitle-file` / `asr`） */
  source: string
  /** 引擎自报的可信度提示，例如「ASR 转写，同音字可能有错」 */
  notes?: string[]
}

export interface TranscriptOptions {
  signal?: AbortSignal
  onProgress?: (processed: number, total: number) => void
  /** 同目录字幕文件搜索目录；不传则用视频所在目录 */
  searchDirs?: string[]
}

export interface TranscriptProvider {
  readonly id: string
  readonly label: string
  /** 尝试顺序，小的先试 */
  readonly priority: number
  ready(): Promise<ReadyState>
  /**
   * 抽台词。
   * 返回空 segments 表示"这个文件没有这种字幕"，pipeline 换下一个 provider。
   */
  transcribe(video: VideoRef, opts?: TranscriptOptions): Promise<TranscriptResult>
}
