/**
 * features/ai-analysis/skill-registry — AI 能力清单
 *
 * 一张表描述「这个应用能对数据做什么 AI 分析」。UI 和将来的对话窗口都读它：
 *   - UI：决定入口挂在哪、按钮怎么显示、结果在卡片里渲染成什么样
 *   - 模型：把 description / inputSchema 翻译成工具定义，由它决定调哪个
 *
 * 两条刻意的约束：
 *
 * 1) **参数只放客观事实**。统计数字（百分位、偏差、σ）必须由 skill 内部用真实数据
 *    重算 —— 这条管线最值钱的地方就是「模型碰不到数字」，让它传等于允许它编。
 *    所以每个 skill 用 modelInputs 声明「模型允许填的字段」，其余一律忽略。
 *
 * 2) **effect 只有 read**。当前 6 个能力全是只读的（autoTag 也只是给建议，
 *    落库是用户点采纳）。将来加写能力时必须标 'write'，`getSkillsFor()` 会按
 *    三档权限把它挡在 read 档之外。
 *
 * 这一层是薄包装：底层 6 个函数的签名与实现一行没动，所以 live.test.ts 与详情面板
 * 都还能直接用它们。registry 只是给它们加一层「可被统一调度」的描述。
 */

import type { AnimeEntry } from '../../src/types';
import type { JSONSchema } from '../../core/ai-json';
import type { AIToolSpec } from '../../core/ai-tools';
import type { AIPermission } from '../../core/ai-permission';
import { canAIPropose } from '../../core/ai-permission';
import type { AIRun } from './ai-runtime';
import { tasteAnalysis } from './taste-analysis';
import { preferenceProfile, preferenceProfileDeep } from './preference-profile';
import { smartRecommend } from './smart-recommend';
import { singleAnimeAnalysis } from './single-anime-analysis';
import { graphOptimize } from './graph-optimize';
import { autoTag } from './auto-tag';
import { lookupAnime, fetchReviews } from './external-skills';
import type { ExternalLookupResult, ExternalReviewsResult } from './external-skills';
import type {
  TasteReport,
  PreferenceProfile,
  RecommendResult,
  SingleAnimeAnalysisResult,
  GraphOptimizationResult,
  AutoTagResult,
} from './ai-types';

/** 会不会改数据。将来加写能力时也要靠它做权限过滤 */
export type AISkillEffect = 'read' | 'write';

/** 需要什么上下文：不需要 / 整个列表 / 某一部番 */
export type AISkillContextKind = 'none' | 'list' | 'entry';

export interface AISkillRunContext {
  /** 当前全部条目（UI 从 AnimeContext 给，永远是实时数据） */
  list: AnimeEntry[];
  /** context='entry' 时由调用方解析好传进来 */
  entry?: AnimeEntry;
  signal?: AbortSignal;
  /** 用量/流式收集器；不传就是默认实例 */
  run?: AIRun;
  /** 是否把思考过程流式喂给 UI */
  stream?: boolean;
}

export interface AISkill<I = unknown, O = unknown> {
  /** 稳定 id，写进日志与缓存键，不要随手改 */
  id: string;
  title: string;
  icon: string;
  /** 给模型看的：什么时候该用这个能力（一句话，讲场景不是讲实现） */
  description: string;
  effect: AISkillEffect;
  context: AISkillContextKind;
  /**
   * 模型允许填的字段。只放定位信息（番剧名/标签名），
   * 分数、百分位这类必须本地重算的东西不许出现在这里。
   */
  modelInputs: string[];
  /** 给模型填参的 schema；空对象表示这个能力不需要参数 */
  inputSchema: JSONSchema;
  run(input: I, ctx: AISkillRunContext): Promise<O>;
  /** 一句话概括结果，用于卡片折叠态 */
  summarize?: (output: O) => string;
}

/** 不需要参数的能力用这个 schema */
const NO_INPUT: JSONSchema = { type: 'object', properties: {}, required: [] };

/**
 * 异构集合用的类型擦除别名。
 * 每个能力都有自己的输入/输出类型，装进同一个数组时泛型无法保留
 * （summarize 的参数是逆变的，AISkill<unknown, X> 不能赋给 AISkill<unknown, unknown>）。
 * 调用方按 id 取用时自己知道具体类型，所以这里显式擦除掉比给每个能力都写 any 更清楚。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAISkill = AISkill<any, any>;

/** 按番剧名定位的能力：模型只给 title，其余由本地解析 */
const ENTRY_INPUT: JSONSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', description: '番剧名，必须与用户列表里的名字一致' },
  },
  required: ['title'],
};

/**
 * 按标题在列表里找条目：精确 → 忽略大小写 → 唯一的包含匹配。
 *
 * 为什么不让模型直接给 id：模型没读过 Excel，它给的 id 一定是编的；
 * 而标题是它在上下文里真正看得见的东西。所以解析放在本地，
 * 并且**只在唯一匹配时才接受** —— 宁可让用户重选，也不猜错一部番。
 */
export function resolveEntry(list: AnimeEntry[], title: string): AnimeEntry | null {
  const want = title.trim();
  if (!want) return null;

  const exact = list.filter((a) => a.title === want);
  if (exact.length === 1) return exact[0];

  const lower = want.toLowerCase();
  const ci = list.filter((a) => a.title.toLowerCase() === lower);
  if (ci.length === 1) return ci[0];

  const partial = list.filter((a) => a.title.toLowerCase().includes(lower));
  if (partial.length === 1) return partial[0];

  return null;
}

// ─────────────────────────────────────────────────────────────
// 6 个能力
// ─────────────────────────────────────────────────────────────

const tasteSkill: AISkill<unknown, TasteReport> = {
  id: 'taste',
  title: '品味分析',
  icon: '🎯',
  description: '用户想知道自己的整体评分口味特征、最在意哪些维度时使用。覆盖全部已评分条目。',
  effect: 'read',
  context: 'list',
  modelInputs: [],
  inputSchema: NO_INPUT,
  run: (_input, ctx) => tasteAnalysis(ctx.list, {
    signal: ctx.signal,
    stream: ctx.stream,
    run: ctx.run,
  }),
  summarize: (out) => out.summary,
};

const profileSkill: AISkill<{ deep?: boolean }, PreferenceProfile> = {
  id: 'profile',
  title: '偏好画像',
  icon: '🧭',
  description: '用户想知道自己跟社区口味差在哪、喜欢和讨厌哪一类作品时使用。需要 BGM 评分与电波评分齐全的条目。',
  effect: 'read',
  context: 'list',
  modelInputs: [],
  inputSchema: NO_INPUT,
  run: (input, ctx) => (input?.deep
    ? preferenceProfileDeep(ctx.list, undefined, undefined, { signal: ctx.signal, stream: ctx.stream, run: ctx.run })
    : preferenceProfile(ctx.list, 'metadata', { signal: ctx.signal, stream: ctx.stream, run: ctx.run })),
  summarize: (out) => out.preferenceProfile || out.likes?.[0]?.aspect || '',
};

const recommendSkill: AISkill<unknown, RecommendResult> = {
  id: 'recommend',
  title: '发现新番',
  icon: '🔭',
  description: '用户想找还没看过、但符合自己口味的作品时使用。会先外部检索再让模型精选。',
  effect: 'read',
  context: 'list',
  modelInputs: [],
  inputSchema: NO_INPUT,
  run: (_input, ctx) => smartRecommend(ctx.list, undefined, undefined, { signal: ctx.signal, run: ctx.run }),
  summarize: (out) => `推荐 ${out.recommendations?.length ?? 0} 部`,
};

const singleAnimeSkill: AISkill<{ title: string }, SingleAnimeAnalysisResult> = {
  id: 'single-anime',
  title: '单番分析',
  icon: '🔍',
  description: '用户问「这一部对我意味着什么」「为什么我给这么高/这么低」时使用。需要指名一部番。',
  effect: 'read',
  context: 'entry',
  modelInputs: ['title'],
  inputSchema: ENTRY_INPUT,
  run: (input, ctx) => {
    const target = ctx.entry || resolveEntry(ctx.list, String(input?.title || ''));
    if (!target) throw new Error(`找不到这部番：${input?.title ?? '(未指定)'}`);
    return singleAnimeAnalysis(target, ctx.list, { signal: ctx.signal, stream: ctx.stream, run: ctx.run });
  },
  summarize: (out) => out.vibePattern || out.coreAppeal?.[0]?.aspect || '',
};

const graphSkill: AISkill<unknown, GraphOptimizationResult> = {
  id: 'graph',
  title: '标签图谱优化',
  icon: '🕸',
  description: '用户想整理标签体系（合并同义、补缺失、发现粒度问题）时使用。',
  effect: 'read',
  context: 'list',
  modelInputs: [],
  inputSchema: NO_INPUT,
  run: (_input, ctx) => graphOptimize(ctx.list, { signal: ctx.signal, run: ctx.run }),
  summarize: (out) => `${out.merges?.length ?? 0} 处可合并`,
};

const autoTagSkill: AISkill<{ title: string }, AutoTagResult> = {
  id: 'auto-tag',
  title: '智能打标签',
  icon: '🏷',
  description: '用户想给某一部番补充标签时使用。只产出建议，是否采纳由用户决定。',
  effect: 'read',
  context: 'entry',
  modelInputs: ['title'],
  inputSchema: ENTRY_INPUT,
  run: (input, ctx) => {
    const target = ctx.entry || resolveEntry(ctx.list, String(input?.title || ''));
    if (!target) throw new Error(`找不到这部番：${input?.title ?? '(未指定)'}`);
    return autoTag(target, { signal: ctx.signal, run: ctx.run });
  },
  summarize: (out) => `${out.suggestedTags?.length ?? 0} 个建议标签`,
};

/**
 * 联网检索：用户问的这部可能**根本不在本地库里**，所以按标题直接去查外部数据源，
 * 同时把本地已有的那份评分带回来做对照（"社区 7.6、你 8.96"正是他最常用的视角）。
 */
const animeLookupSkill: AISkill<{ title: string }, ExternalLookupResult> = {
  id: 'anime-lookup',
  title: '检索番剧资料',
  icon: '🌐',
  description: '用户问某部番的客观资料时使用：放送年份、集数、制作公司、原作来源、简介、社区评分。'
    + '会联网查 Bangumi（失败回落 AniList）。本地库里没有的番也能查。',
  effect: 'read',
  context: 'entry',
  modelInputs: ['title'],
  inputSchema: ENTRY_INPUT,
  run: (input, ctx) => lookupAnime(String(input?.title || ''), ctx.list, ctx.signal),
  summarize: (out) => {
    if (out.candidates.length === 0) return out.note || '没有找到';
    const first = out.candidates[0];
    return `${first.title}${first.score ? ` · 社区 ${first.score}` : ''}${first.airDate ? ` · ${first.airDate}` : ''}`;
  },
};

const animeReviewsSkill: AISkill<{ title: string }, ExternalReviewsResult> = {
  id: 'anime-reviews',
  title: '查社区评论',
  icon: '💬',
  description: '用户想知道某部番在社区里被怎么评价、值不值得看时使用。取 Bangumi 短评摘录。',
  effect: 'read',
  context: 'entry',
  modelInputs: ['title'],
  inputSchema: ENTRY_INPUT,
  run: (input, ctx) => fetchReviews(String(input?.title || ''), ctx.signal),
  summarize: (out) => (out.count > 0 ? `采集到 ${out.count} 条短评` : (out.note || '没有评论')),
};

/** 全部能力。顺序即 UI 里的展示顺序 */
export const AI_SKILLS: readonly AnyAISkill[] = [
  tasteSkill,
  profileSkill,
  recommendSkill,
  animeLookupSkill,
  animeReviewsSkill,
  singleAnimeSkill,
  graphSkill,
  autoTagSkill,
];

export function getSkill(id: string): AnyAISkill | undefined {
  return AI_SKILLS.find((s) => s.id === id);
}

/**
 * 当前权限下可用的能力。
 * read 档会把「AI 连提议都不该发起」的写能力整个挡掉 ——
 * 隐藏入口比让用户点了再拒绝更诚实。
 */
export function getSkillsFor(permission: AIPermission): AnyAISkill[] {
  return AI_SKILLS.filter((s) => s.effect === 'read' || canAIPropose(permission));
}

/** 把能力清单翻译成网关能直接吃的工具定义 */
export function toToolSpecs(skills: readonly AnyAISkill[]): AIToolSpec[] {
  return skills.map((s) => ({
    type: 'function',
    function: {
      // 多数网关的工具名只接受字母数字下划线
      name: s.id.replace(/-/g, '_'),
      description: s.description,
      parameters: s.inputSchema as unknown as Record<string, unknown>,
    },
  }));
}
