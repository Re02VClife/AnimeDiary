/**
 * features/ai-analysis/ai-types — AI 分析模块的类型定义 & 输出 Schema
 *
 * 每个 Skill 的 Schema 都是"运行时校验用的真身"：
 * aiJSON() 拿它生成字段说明、纠偏、校验，不合格会带着错误清单让模型重写。
 */
import type { AnimeEntry } from '../../src/types';
import type { JSONSchema } from '../../core/ai-json';

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
  /** 是否在 Bangumi/AniList 里校验到了实体（Tier 4 纯模型推荐可能是幻觉） */
  verified?: boolean;
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

const confidence: JSONSchema = {
  type: 'number',
  minimum: 0,
  maximum: 1,
  description: '置信度 0-1',
};

export const TASTE_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: '一句话总览用户品味，30-60 字' },
    highlights: {
      type: 'array',
      items: { type: 'string' },
      description: '3-5 个基于数据的洞察，每条 15-40 字，必须引用具体数字或番剧名',
    },
    notes: {
      type: 'array',
      items: { type: 'string' },
      description: '2-3 个有趣但容易被忽略的细节观察',
    },
  },
  required: ['summary', 'highlights', 'notes'],
  additionalProperties: false,
};

export const PROFILE_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    likes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          aspect: { type: 'string', description: '偏好的方面，8 字以内，如"克制的情绪表达"' },
          confidence,
          evidence: { type: 'string', description: '数据证据，必须引用具体番剧名或分数' },
        },
        required: ['aspect', 'confidence', 'evidence'],
        additionalProperties: false,
      },
      description: '3-5 条偏好倾向',
    },
    dislikes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          aspect: { type: 'string', description: '雷区，8 字以内' },
          confidence,
          evidence: { type: 'string', description: '数据证据' },
        },
        required: ['aspect', 'confidence', 'evidence'],
        additionalProperties: false,
      },
      description: '2-3 条雷区',
    },
    preferenceProfile: { type: 'string', description: '一句话总结用户偏好画像' },
    tasteDeviation: { type: 'string', description: '与社区口味的差异趋势' },
    hiddenGems: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          anime: { type: 'string', description: '番剧名（必须是数据里出现过的）' },
          reason: { type: 'string', description: '为什么是隐藏宝藏' },
        },
        required: ['anime', 'reason'],
        additionalProperties: false,
      },
      description: '最多 3 条',
    },
  },
  required: ['likes', 'dislikes', 'preferenceProfile', 'tasteDeviation'],
  additionalProperties: false,
};

export const SINGLE_ANIME_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    coreAppeal: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          aspect: { type: 'string', description: '打动用户的方面' },
          evidence: { type: 'string', description: '来自评分/评价/标签的具体证据' },
          confidence,
        },
        required: ['aspect', 'evidence', 'confidence'],
        additionalProperties: false,
      },
      description: '2-4 条',
    },
    vibePattern: { type: 'string', description: '与其它高电波番的共性，或电波低的模式' },
    communityGap: { type: 'string', description: '与社区口味差距的原因；无 BGM 数据时写"无社区对比数据"' },
    similarAnime: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          why: { type: 'string' },
        },
        required: ['title', 'why'],
        additionalProperties: false,
      },
      description: '0-3 条',
    },
  },
  required: ['coreAppeal', 'vibePattern', 'communityGap', 'similarAnime'],
  additionalProperties: false,
};

export const GRAPH_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    merges: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          from: { type: 'string', description: '被合并掉的标签' },
          to: { type: 'string', description: '合并到的目标标签' },
          reason: { type: 'string' },
        },
        required: ['from', 'to', 'reason'],
        additionalProperties: false,
      },
      description: '0-5 条',
    },
    newTags: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          anime: { type: 'string' },
          tag: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['anime', 'tag', 'reason'],
        additionalProperties: false,
      },
      description: '0-5 条',
    },
    issues: {
      type: 'array',
      items: { type: 'string' },
      description: '0-3 条体系层面的问题',
    },
  },
  required: ['merges', 'newTags', 'issues'],
  additionalProperties: false,
};

export const AUTO_TAG_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    suggestedTags: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '2-4 个汉字或常见动漫分类术语' },
          reason: { type: 'string', description: '为什么贴这个标签' },
        },
        required: ['name', 'reason'],
        additionalProperties: false,
      },
      description: '3-5 个，且不能与已有标签重复',
    },
  },
  required: ['suggestedTags'],
  additionalProperties: false,
};

export const RECOMMEND_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    recommendations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '番剧名，必须来自候选列表' },
          reason: { type: 'string', description: '为什么适合这位用户，结合偏好，不剧透' },
          intro: { type: 'string', description: '100 字以内的风格/氛围介绍，绝不剧透情节' },
          confidence,
        },
        required: ['title', 'reason', 'intro', 'confidence'],
        additionalProperties: false,
      },
      description: '3-5 部',
    },
  },
  required: ['recommendations'],
  additionalProperties: false,
};

export const REVIEW_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    strengths: {
      type: 'array',
      items: { type: 'string' },
      description: '3 个社区普遍认可的优点，2-6 字短语',
    },
    weaknesses: {
      type: 'array',
      items: { type: 'string' },
      description: '2 个社区普遍吐槽的雷点，2-6 字短语',
    },
  },
  required: ['strengths', 'weaknesses'],
  additionalProperties: false,
};
