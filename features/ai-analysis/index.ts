/**
 * features/ai-analysis — AI 分析套件统一导出
 *
 * 结构：
 *   ai-config     前端配置镜像（真配置在服务端 {DATA_DIR}/ai-config.json）
 *   llm-service   /api/ai 客户端 + 结构化输出（解析/纠偏/校验/重写）
 *   ai-runtime    一次运行的用量与流式输出收集
 *   ai-cache      指纹缓存
 *   {skill}.ts    6 个分析能力
 */

// ── 配置 ──
export {
  loadAIConfig,
  hasAIConfig,
  initAIConfig,
  saveAIConfig,
  testAIConnection,
  fetchAIModels,
  fetchAIUsage,
  getAIPermission,
} from './ai-config';
export type { AIConfig, AIProviderInfo } from './ai-config';

// ── 写操作权限（三档）与改动提议 ──
export { AI_PERMISSION_VALUES, AI_PERMISSION_INFO, normalizeAIPermission, canAIPropose, canAIAutoApply } from '../../core/ai-permission';
export type { AIPermission, AIPermissionInfo } from '../../core/ai-permission';
export {
  createProposal,
  createTagProposal,
  checkProposalStale,
  describeProposal,
} from '../../core/ai-proposal';
export type { AIProposal, ProposedItemChange, ProposedFieldChange, ProposalStaleness } from '../../core/ai-proposal';

// ── 调用与结构化输出 ──
export { aiChat, aiJSON, AIError } from './llm-service';
export type { AIUsage, AIResult, AICallOptions, AIJSONOptions, AIJSONResult, AIMessage } from './llm-service';

// ── 运行遥测 ──
export { beginAIRun, getAIRunSummary, setAIStreamListener } from './ai-runtime';
export type { AIRunSummary } from './ai-runtime';

// ── 缓存 ──
export {
  saveProfileCache,
  loadProfileCache,
  saveTasteCache,
  loadTasteCache,
  clearAICache,
  buildListFingerprint,
} from './ai-cache';

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
export { buildDeviationData, preferenceProfile, preferenceProfileDeep } from './preference-profile';

// ── Skill 3: 智能推荐 ──
export { smartRecommend } from './smart-recommend';

// ── Skill 4: 单番分析 ──
export { singleAnimeAnalysis } from './single-anime-analysis';

// ── Skill 5: 图谱优化 ──
export { graphOptimize } from './graph-optimize';

// ── Skill 6: 智能打 Tag ──
export { autoTag } from './auto-tag';

// ── 内部辅助（可供外部组件使用）──
export { getScore, calcOverall, calcTasteDeviation, fmtDims, getDimensionsForList, summarizeTaste } from './ai-helpers';
