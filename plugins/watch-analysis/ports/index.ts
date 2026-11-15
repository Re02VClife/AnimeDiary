/**
 * ports/index — 接口汇聚导出
 *
 * 上层只 `import type { CutProvider, ... } from '../ports'`，
 * 不关心接口定义在哪个文件里。接口内部还可以继续拆。
 */
export type { CutProvider, CutDetectOptions } from './cut'
export type { TranscriptProvider, TranscriptOptions, TranscriptResult } from './transcript'
export type { MotionProvider, MotionOptions, MotionResult } from './motion'
export type { MusicProvider, MusicOptions, MusicResult, TimeWindow } from './music'
export type { SheetRenderer, RenderOptions, RenderResult, RenderPlan, RenderStrategy } from './render'
export type { VisionProvider, VisionRequest, VisionAnswer, VisionUsage } from './vision'
