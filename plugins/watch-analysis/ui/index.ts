/**
 * ui/index — 拉片分析前端入口（给宿主集成用）
 *
 * 宿主只需要：
 *
 *   import { WatchTab } from '../plugins/watch-analysis/ui'
 *   <WatchTab animeKey={key} episode={ep} title={anime.title} />
 *
 * 内部拆成了 api / BudgetBar / StoryboardViewer / WatchTab 四个文件，
 * 但集成方不用关心，也不需要直接碰 `/api/watch/*`。
 * （注意：把 Tab 挂到详情页、加路由、加 Tab 项是宿主侧集成步骤，不在插件里做。）
 */
export { WatchTab } from './WatchTab'
export type { WatchTabProps } from './WatchTab'

// AI 影评面板：宿主在详情页 / 顶栏 / 设置三处打开它
export {
  default as AiReviewModal,
  formatReviewClock,
  formatEpisodeLabel,
  formatScoreValue,
  formatDiff,
} from './AiReviewModal'
export type { AiReviewModalProps } from './AiReviewModal'
export {
  generateReview,
  getExistingReview,
  listAnalyzedEpisodes,
  resolveVideoFile,
  getReviewMeta,
} from './review-api'

export { StoryboardViewer, formatTimecode, formatDuration } from './StoryboardViewer'
export type { StoryboardViewerProps } from './StoryboardViewer'

export { BudgetBar, formatTokens } from './BudgetBar'
export type { BudgetBarProps } from './BudgetBar'

export {
  analyze,
  getStatus,
  cancel,
  getReport,
  sheetUrl,
  getDeps,
} from './api'
export type {
  AnalyzeOptions,
  DepsResponse,
  WatchDependency,
  WatchJobStatus,
} from './api'
