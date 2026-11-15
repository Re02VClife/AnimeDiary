/**
 * ports/cut — 切镜引擎接口
 *
 * 唯一职责：把一集视频切成镜头序列。**怎么切**是 adapter 的事。
 *
 * 当前实现：`adapters/cut-hsv.ts`（复用 dsh-video-storyboard 的逐帧 HSV 差分）
 * 计划实现：`adapters/cut-transnet.ts`（TransNet V2，动画场景更稳）
 *
 * 换引擎时上层 pipeline 一行不动 —— 这是这个接口存在的全部理由。
 */
import type { Cut, ReadyState, VideoRef } from '../core/types'

export interface CutDetectOptions {
  /** 只分析这一段（秒）；省略 = 全片 */
  from?: number
  to?: number
  /** 阈值：`auto` 让引擎按本片分布自己推；数字是显式阈值（不同引擎刻度不同） */
  threshold?: number | 'auto'
  /** 取消信号：必须尽快响应，已经算出的部分不提交 */
  signal?: AbortSignal
  /** 进度回调；total 未知时传 -1 */
  onProgress?: (processed: number, total: number) => void
}

export interface CutDetection {
  /** 切点列表，按时间升序 */
  cuts: Cut[]
  /**
   * 引擎内部的完整扫描结果（逐帧分数、阈值、预计算数据…），
   * **给排版阶段复用，避免再解一遍码**。
   *
   * 类型故意是 `unknown`：不同引擎的"中间态"完全不一样，
   * 上层只负责原样转交给同一个引擎的 render，不解释它。
   * 换引擎时两边一起换，所以不会出现"传错引擎的 raw"。
   */
  raw?: unknown
}

export interface CutProvider {
  /** 稳定 id，会写进报告的 `engine.cut`，不要随手改 */
  readonly id: string
  /** 人看的名字，UI 和报告里显示 */
  readonly label: string
  /** 依赖是否就绪。**不抛错**：缺依赖返回 { ok:false, reason }，pipeline 换下一个 */
  ready(): Promise<ReadyState>
  detect(video: VideoRef, opts?: CutDetectOptions): Promise<CutDetection>
}
