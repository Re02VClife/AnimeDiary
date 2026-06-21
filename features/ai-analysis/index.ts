/**
 * features/ai-analysis — AI 分析套件统一导出
 */

// ── 配置 & 基础设施 ──
export { loadAIConfig, saveAIConfig, hasAIConfig } from './ai-config';
export type { AIConfig } from './ai-config';
export { saveProfileCache, loadProfileCache, clearAICache } from './ai-cache';
export { chat } from './llm-service';
export type { LLMCallOptions, TokenUsage } from './llm-service';

// ── 类型 ──
export type {
  TasteReport,
  PreferenceProfile,
  ProfileMode,
  TasteStats,
  DeviationData,
  Recommendation,
  RecommendResult,
  DiscoverItem,
  SingleAnimeAnalysisResult,
  GraphOptimizationResult,
  AutoTagResult,
  AnimeReviewAnalysis,
} from './ai-types';

// ── Skill 1: 品味分析 ──
export { buildTasteStats, tasteAnalysis } from './taste-analysis';

// ── Skill 2: 偏好画像 ──
export {
  buildDeviationData,
  preferenceProfile,
  preferenceProfileDeep,
} from './preference-profile';

// ── Skill 3: 智能推荐 ──
export { smartRecommend } from './smart-recommend';

// ── Skill 4: 单番分析 ──
export { singleAnimeAnalysis } from './single-anime-analysis';

// ── Skill 5: 图谱优化 ──
export { graphOptimize } from './graph-optimize';

// ── Skill 6: 智能打 Tag ──
export { autoTag } from './auto-tag';

// ── 内部辅助（可供外部组件使用）──
export { getScore, calcOverall, calcTasteDeviation, fmtDims } from './ai-helpers';
