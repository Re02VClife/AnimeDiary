/**
 * ports/render — 分镜图渲染接口
 *
 * 输入切点，输出「带档位的镜头」+ 拼好的宫格图。
 *
 * 为什么档位在这里算而不是在 cut 阶段：档位 = **切点密度**，
 * 它是一个排版概念（快剪处格子小、长镜头格子大），和"哪里有刀"是两件事。
 * 切镜引擎只管报刀，排版引擎负责把刀翻译成面积分配。
 *
 * 当前实现：`adapters/render-storyboard.ts`（复用 dsh-video-storyboard 的 tier + DP 装箱）
 */
import type { Cut, ReadyState, Segment, Sheet, Shot, VideoRef } from '../core/types'

/** 和 dsh-video-storyboard 的 strategy 对齐；换渲染器时可以映射成别的语义 */
export type RenderStrategy = 'auto' | 'compact' | 'standard' | 'full' | 'skim' | 'brief'

export interface RenderOptions {
  signal?: AbortSignal
  strategy?: RenderStrategy
  /** 最多取多少帧（一段=一个镜头）；0 = 不封顶 */
  maxFrames?: number
  /** 最多几张图；0 = 排版器自己定 */
  maxSheets?: number
  /** 单图像素预算；不传用引擎默认（约 360k = 800×450） */
  budgetPixels?: number
  /** 已经解析好的台词，用于把字幕写进文本清单（不是烧进图里）；没有就传 undefined */
  transcript?: Segment[]
  /** 输出目录（绝对路径），图写在这里 */
  outDir: string
  /** 图文件名前缀，避免多集撞名 */
  prefix: string
  onProgress?: (stage: string, done: number, total: number) => void
}

export interface RenderPlan {
  strategy: RenderStrategy
  /** 每档各多少帧，例如 { 1: 2, 2: 5, 4: 18 } */
  tiers: Record<number, number>
  /** 填充率 **0–100**（百分比，不是 0–1）—— storyboard 原样给的就是这个口径 */
  fill: number
  /** 总帧数 */
  frames: number
}

export interface RenderResult {
  /** 带 tier 的镜头序列（顺序即时间顺序） */
  shots: Shot[]
  sheets: Sheet[]
  plan: RenderPlan
  /** 引擎自报的警告，例如「连续运镜导致切点数不可信」 */
  notes?: string[]
}

export interface SheetRenderer {
  readonly id: string
  readonly label: string
  ready(): Promise<ReadyState>
  render(video: VideoRef, cuts: Cut[], opts: RenderOptions): Promise<RenderResult>
}
