/**
 * features/ai-analysis/ai-types — AI 分析模块的全部类型定义 & JSON Schema
 */
import type { AnimeEntry } from '../../src/types';

// ── Skill 输出类型 ──

/** 品味分析报告 */
export interface TasteReport {
  summary: string;
  highlights: string[];
  notes: string[];
}

/** 偏好画像 */
export interface PreferenceProfile {
  likes: { aspect: string; confidence: number; evidence: string }[];
  dislikes: { aspect: string; confidence: number; evidence: string }[];
  preferenceProfile: string;
  tasteDeviation: string;
  hiddenGems: { anime: string; reason: string }[];
}

export type ProfileMode = 'metadata' | 'deep';

/** 品味分析 — 前端统计数据 */
export interface TasteStats {
  animeCount: number;
  scoredCount: number;
  dimAvg: Record<string, number>;
  dimStdDev: { key: string; label: string; std: number }[];
  topTags: { name: string; count: number; avgScore: number | null }[];
  topMonths: [string, number][];
}

/** 偏好画像 — 前端统计数据 */
export interface DeviationData {
  withDev: { anime: AnimeEntry; deviation: number }[];
  posCount: number;
  negCount: number;
  avgPosDev: number;
  avgNegDev: number;
  topPos: { anime: AnimeEntry; deviation: number }[];
  topNeg: { anime: AnimeEntry; deviation: number }[];
  vibeTop: AnimeEntry[];
  vibeBottom: AnimeEntry[];
  samples: AnimeEntry[];
  hiIds: Set<string>;
  loIds: Set<string>;
  topHiTags: [string, number][];
  topLoTags: [string, number][];
  dimAvgHi: Record<string, number>;
  dimAvgLo: Record<string, number>;
  keywords: string[];
  topYears: string[];
}

// ── Skill 3 类型 ──

/** 推荐条目 */
export interface Recommendation {
  title: string;
  reason: string;
  intro: string;
  bgmScore?: number;
  posterUrl?: string;
  airDate?: string;
  matchedTags: string[];
  confidence: number;
}

/** 推荐结果 */
export interface RecommendResult {
  recommendations: Recommendation[];
  candidateCount: number;
  searchedTags: string[];
  sourceLabel?: string;
}

/** AniList/Bangumi 发现条目（内部使用） */
export interface DiscoverItem {
  id: number;
  name: string;
  name_cn: string;
  summary: string;
  images: { large?: string; common?: string; medium?: string; small?: string };
  rating: { score?: number; total?: number };
  air_date: string;
  eps: number;
  genres?: string[];
  tags?: string[];
  matchedTag: string;
}

// ── Skill 4 类型 ──

/** 单番分析结果 */
export interface SingleAnimeAnalysisResult {
  coreAppeal: { aspect: string; evidence: string; confidence: number }[];
  vibePattern: string;
  communityGap: string;
  similarAnime: { title: string; why: string }[];
}

// ── Skill 5 类型 ──

/** 图谱优化结果 */
export interface GraphOptimizationResult {
  merges: { from: string; to: string; reason: string }[];
  newTags: { anime: string; tag: string; reason: string }[];
  issues: string[];
}

// ── Skill 6 类型 ──

/** 自动打 Tag 结果 */
export interface AutoTagResult {
  suggestedTags: { name: string; reason: string }[];
}

// ── 深度模式内部类型 ──

/** 逐番分析结果（深度模式 Step 1） */
export interface AnimeReviewAnalysis {
  title: string;
  strengths: string[];
  weaknesses: string[];
}

// ── JSON Schema ──

export const TASTE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: '一句话总览用户品味' },
    highlights: {
      type: 'array',
      items: { type: 'string' },
      description: '3-5 个亮点发现',
    },
    notes: {
      type: 'array',
      items: { type: 'string' },
      description: '2-4 个有趣的细节观察',
    },
  },
  required: ['summary', 'highlights', 'notes'],
  additionalProperties: false,
};

export const PROFILE_SCHEMA = {
  type: 'object',
  properties: {
    likes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          aspect: { type: 'string', description: '用户偏好的方面' },
          confidence: { type: 'number', description: '置信度 0-1' },
          evidence: { type: 'string', description: '数据中的证据' },
        },
        required: ['aspect', 'confidence', 'evidence'],
        additionalProperties: false,
      },
      description: '用户偏好的方面列表',
    },
    dislikes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          aspect: { type: 'string', description: '用户不喜欢的方面' },
          confidence: { type: 'number', description: '置信度 0-1' },
          evidence: { type: 'string', description: '数据中的证据' },
        },
        required: ['aspect', 'confidence', 'evidence'],
        additionalProperties: false,
      },
      description: '用户不喜欢的方面列表',
    },
    preferenceProfile: { type: 'string', description: '一句话总结用户偏好画像' },
    tasteDeviation: { type: 'string', description: '用户与社区口味的差异趋势描述' },
    hiddenGems: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          anime: { type: 'string', description: '番剧名' },
          reason: { type: 'string', description: '为什么是隐藏宝藏' },
        },
        required: ['anime', 'reason'],
        additionalProperties: false,
      },
      description: '评分不高但用户可能喜欢的番剧',
    },
  },
  required: ['likes', 'dislikes', 'preferenceProfile', 'tasteDeviation'],
  additionalProperties: false,
};
