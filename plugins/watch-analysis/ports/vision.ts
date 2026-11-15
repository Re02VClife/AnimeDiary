/**
 * ports/vision — 看图接口
 *
 * 只管「发图 + 提示词 → 文字」，不管预算。
 *
 * 为什么预算不在这里：预算是**调用方**的职责（一次分析要发多少张图、还剩多少额度，
 * 是 runtime 才知道的事）。Port 若持有预算，换一个 Vision 实现就得重写记账逻辑，
 * 那就违背了「换引擎不动上层」。
 *
 * 调用方流程固定为：`budget.reserve(n)` → `describe()` → `budget.record(usage)`。
 */
import type { ReadyState } from '../core/types'

export interface VisionRequest {
  /** 记账分类：`overview` / `zoom` / `shot` / `report` */
  kind: string
  /** 图片路径（绝对路径）或 data URL；顺序即模型看到的顺序 */
  images: string[]
  prompt: string
  system?: string
  maxTokens?: number
  /** 要求返回 JSON（报告结构化字段用） */
  jsonMode?: boolean
  signal?: AbortSignal
  timeoutMs?: number
}

export interface VisionUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface VisionAnswer {
  text: string
  usage: VisionUsage
  model: string
  provider: string
  latencyMs: number
}

export interface VisionProvider {
  readonly id: string
  readonly label: string
  /** 检查：有配置、有 key、模型名没空 */
  ready(): Promise<ReadyState>
  describe(req: VisionRequest): Promise<VisionAnswer>
}
