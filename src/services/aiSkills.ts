/**
 * AI Skill 层 — 数据准备 + Prompt 组装 + LLM 调用
 *
 * 每个 skill 做三件事：
 *   1. 纯计算提取数据特征
 *   2. 将数据填入 Prompt 模板
 *   3. 调用 LLM → 解析结构化 JSON → 返回
 */

import type { AnimeEntry } from '../types';
import { DEFAULT_DIMENSIONS } from '../types';
import { buildPercentileMap, getPercentileScores } from './rankingService';
import { chat } from './llmService';

// ── core/ 工具函数 ──
import { cosineSimilarity, jaccardArrays } from '../../core/math';
import { extractJSON, extractKeywords } from '../../core/text';

// ════════════════════════════════════════════════════════════════════
// 工具函数

/** 获取番剧某维度分数 */
function getScore(a: AnimeEntry, dimKey: string): number {
  return a.scores.find((s) => s.dimensionKey === dimKey)?.score ?? 0;
}

/** 计算加权总评（DEFAULT_DIMENSIONS 权重表） */
function calcOverall(a: AnimeEntry): number {
  let total = 0;
  let totalWeight = 0;
  for (const dim of DEFAULT_DIMENSIONS) {
    if (dim.key === 'overall') continue;
    const s = getScore(a, dim.key);
    if (s > 0) {
      total += s * dim.weight;
      totalWeight += dim.weight;
    }
  }
  return totalWeight > 0 ? total / totalWeight : 0;
}

/**
 * 口味偏差值: (总评 × 0.4 + 电波 × 0.6) - BGM 评分
 * 正值 = 个人偏好高于社区，负值 = 社区评分高于个人
 */
function calcTasteDeviation(a: AnimeEntry): number | null {
  const bgm = a.bangumiScore;
  if (bgm === undefined || bgm <= 0) return null;
  const overall = getScore(a, 'overall') || calcOverall(a);
  const vibe = getScore(a, 'vibe');
  if (overall <= 0 || vibe <= 0) return null;
  return (overall * 0.4 + vibe * 0.6) - bgm;
}

/** 格式化维度分数为一行 */
function fmtDims(a: AnimeEntry): string {
  return DEFAULT_DIMENSIONS
    .filter((d) => d.key !== 'overall')
    .map((d) => `${d.label}${getScore(a, d.key).toFixed(d.key === 'vibe' ? 2 : 1)}`)
    .join(' ');
}

// ════════════════════════════════════════════════════════════════════
// Skill 输出类型
// ════════════════════════════════════════════════════════════════════

export interface TasteReport {
  summary: string;
  highlights: string[];
  notes: string[];
}

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
  /** 各维度平均百分位 */
  dimAvg: Record<string, number>;
  /** 评分波动最大的维度（降序） */
  dimStdDev: { key: string; label: string; std: number }[];
  /** 使用次数最多的标签 */
  topTags: { name: string; count: number; avgScore: number | null }[];
  /** 追番密度最高月 */
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

// ════════════════════════════════════════════════════════════════════
// JSON Schemas
// ════════════════════════════════════════════════════════════════════

const TASTE_SCHEMA = {
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

const PROFILE_SCHEMA = {
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

// ════════════════════════════════════════════════════════════════════
// 数据准备
// ════════════════════════════════════════════════════════════════════

/** 计算全体番剧的数据统计（独立导出，供 UI 展示中间过程） */
export function buildTasteStats(animeList: AnimeEntry[]): TasteStats {
  const stats = buildPercentileMap(animeList);
  const scored = animeList.filter((a) => a.scores.some((s) => s.score > 0));

  // 各维度平均百分位
  const dimAvg: Record<string, number> = {};
  for (const dim of DEFAULT_DIMENSIONS) {
    if (dim.key === 'overall') continue;
    const vals: number[] = [];
    for (const a of scored) {
      const pct = getPercentileScores(a, stats).find(
        (p) => p.dimensionKey === dim.key,
      );
      if (pct && pct.rawScore > 0) vals.push(pct.percentile);
    }
    dimAvg[dim.key] = vals.length > 0
      ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length)
      : 0;
  }

  // 评分标准差最大的维度
  const dimStdDev: { key: string; label: string; std: number }[] = [];
  for (const dim of DEFAULT_DIMENSIONS) {
    if (dim.key === 'overall') continue;
    const rawScores = scored
      .map((a) => getScore(a, dim.key))
      .filter((s) => s > 0);
    if (rawScores.length < 2) continue;
    const mean = rawScores.reduce((a, b) => a + b, 0) / rawScores.length;
    const variance =
      rawScores.reduce((sum, s) => sum + (s - mean) ** 2, 0) /
      rawScores.length;
    dimStdDev.push({ key: dim.key, label: dim.label, std: Math.sqrt(variance) });
  }
  dimStdDev.sort((a, b) => b.std - a.std);

  // 标签统计（按使用次数降序，取 top 15）
  const tagCounts: Record<string, { count: number; totalScore: number; scoreCount: number }> = {};
  for (const a of animeList) {
    const overall = getScore(a, 'overall') || calcOverall(a);
    for (const t of a.tags) {
      if (!tagCounts[t.name]) tagCounts[t.name] = { count: 0, totalScore: 0, scoreCount: 0 };
      tagCounts[t.name].count++;
      if (overall > 0) {
        tagCounts[t.name].totalScore += overall;
        tagCounts[t.name].scoreCount++;
      }
    }
  }
  const topTags = Object.entries(tagCounts)
    .filter(([, v]) => v.count >= 2)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 15)
    .map(([name, v]) => ({
      name,
      count: v.count,
      avgScore: v.scoreCount > 0
        ? +(v.totalScore / v.scoreCount).toFixed(1)
        : null,
    }));

  // 月度追番密度（基于 createdAt）
  const monthCounts: Record<string, number> = {};
  for (const a of animeList) {
    const m = a.createdAt?.slice(0, 7); // "YYYY-MM"
    if (m && /^\d{4}-\d{2}$/.test(m)) {
      monthCounts[m] = (monthCounts[m] || 0) + 1;
    }
  }
  const topMonths = Object.entries(monthCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  return { animeCount: animeList.length, scoredCount: scored.length, dimAvg, dimStdDev, topTags, topMonths };
}

/** 计算口味偏差相关数据（独立导出，供 UI 展示中间过程） */
export function buildDeviationData(animeList: AnimeEntry[]): DeviationData {
  // 计算所有番的口味偏差值
  const withDev = animeList
    .map((a) => ({ anime: a, deviation: calcTasteDeviation(a) }))
    .filter((d): d is { anime: AnimeEntry; deviation: number } => d.deviation !== null);

  // 统计整体倾向
  const posCount = withDev.filter((d) => d.deviation > 0).length;
  const negCount = withDev.filter((d) => d.deviation < 0).length;
  const avgPosDev =
    posCount > 0
      ? withDev
          .filter((d) => d.deviation > 0)
          .reduce((s, d) => s + d.deviation, 0) / posCount
      : 0;
  const avgNegDev =
    negCount > 0
      ? withDev
          .filter((d) => d.deviation < 0)
          .reduce((s, d) => s + d.deviation, 0) / negCount
      : 0;

  // 按偏差排序
  const byDev = [...withDev].sort((a, b) => b.deviation - a.deviation);
  const topPos = byDev.filter((d) => d.deviation > 0).slice(0, 15);
  const topNeg = byDev
    .filter((d) => d.deviation < 0)
    .sort((a, b) => a.deviation - b.deviation)
    .slice(0, 15);

  // 按电波排序
  const byVibe = [...animeList]
    .filter((a) => getScore(a, 'vibe') > 0)
    .sort((a, b) => getScore(b, 'vibe') - getScore(a, 'vibe'));
  const vibeTop = byVibe.slice(0, 10);
  const vibeBottom = byVibe.filter((a) => getScore(a, 'vibe') > 0).slice(-10).reverse();

  // 合并去重样本
  const sampleSet = new Map<string, AnimeEntry>();
  for (const d of topPos) sampleSet.set(d.anime.id, d.anime);
  for (const d of topNeg) sampleSet.set(d.anime.id, d.anime);
  for (const a of vibeTop) sampleSet.set(a.id, a);
  for (const a of vibeBottom) sampleSet.set(a.id, a);
  const samples = [...sampleSet.values()];

  // 高偏差番 vs 低偏差番 标签共现
  const hiIds = new Set(topPos.map((d) => d.anime.id));
  const loIds = new Set(topNeg.map((d) => d.anime.id));

  const tagHi: Record<string, number> = {};
  const tagLo: Record<string, number> = {};
  for (const d of topPos) {
    for (const t of d.anime.tags) tagHi[t.name] = (tagHi[t.name] || 0) + 1;
  }
  for (const d of topNeg) {
    for (const t of d.anime.tags) tagLo[t.name] = (tagLo[t.name] || 0) + 1;
  }

  const topHiTags = Object.entries(tagHi)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  const topLoTags = Object.entries(tagLo)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  // 高低偏差组维度均值
  const dimAvgHi: Record<string, number> = {};
  const dimAvgLo: Record<string, number> = {};
  for (const dim of DEFAULT_DIMENSIONS) {
    if (dim.key === 'overall') continue;
    const hiScores = topPos.map((d) => getScore(d.anime, dim.key)).filter((s) => s > 0);
    const loScores = topNeg.map((d) => getScore(d.anime, dim.key)).filter((s) => s > 0);
    dimAvgHi[dim.key] = hiScores.length > 0
      ? +(hiScores.reduce((a, b) => a + b, 0) / hiScores.length).toFixed(1)
      : 0;
    dimAvgLo[dim.key] = loScores.length > 0
      ? +(loScores.reduce((a, b) => a + b, 0) / loScores.length).toFixed(1)
      : 0;
  }

  // 提取用户评价关键词
  const hiReviews = topPos
    .map((d) => d.anime.review || '')
    .filter((r) => r.length > 0);
  const keywords = extractKeywords(hiReviews, 15);

  // 年代分布
  const decadeHi: Record<string, number> = {};
  const decadeLo: Record<string, number> = {};
  for (const d of topPos) {
    const yr = d.anime.releaseDate?.slice(0, 4);
    if (yr) decadeHi[yr] = (decadeHi[yr] || 0) + 1;
  }
  for (const d of topNeg) {
    const yr = d.anime.releaseDate?.slice(0, 4);
    if (yr) decadeLo[yr] = (decadeLo[yr] || 0) + 1;
  }
  const topYears = [
    ...new Set(
      [...Object.entries(decadeHi), ...Object.entries(decadeLo)]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([yr]) => yr),
    ),
  ];

  return {
    withDev,
    posCount,
    negCount,
    avgPosDev: +avgPosDev.toFixed(2),
    avgNegDev: +avgNegDev.toFixed(2),
    topPos,
    topNeg,
    vibeTop,
    vibeBottom,
    samples,
    hiIds,
    loIds,
    topHiTags,
    topLoTags,
    dimAvgHi,
    dimAvgLo,
    keywords,
    topYears,
  };
}

// ════════════════════════════════════════════════════════════════════
// Skill 1: 品味分析
// ════════════════════════════════════════════════════════════════════

export async function tasteAnalysis(
  animeList: AnimeEntry[],
): Promise<TasteReport> {
  const { dimAvg, dimStdDev, topTags, topMonths, scoredCount } =
    buildTasteStats(animeList);

  // 组装维度平均百分位
  const dimLines = DEFAULT_DIMENSIONS
    .filter((d) => d.key !== 'overall')
    .map((d) => `  ${d.label}: ${dimAvg[d.key]}%`)
    .join('\n');

  // 组装标签统计
  const tagLines = topTags
    .map((t) => {
      const avg = t.avgScore !== null ? ` 均值${t.avgScore}` : '';
      return `  ${t.name}（${t.count}部${avg}）`;
    })
    .join('\n');

  // 月度密度
  const monthLines = topMonths
    .map(([m, c]) => `  ${m}: ${c}部`)
    .join('\n');

  // 标准差最大维度
  const stdLines = dimStdDev
    .slice(0, 3)
    .map((d) => `  ${d.label}: σ=${d.std.toFixed(2)}`)
    .join('\n');

  const systemPrompt = `你是一个番剧品味分析师。根据评分数据生成品味报告。

必须只输出一个 JSON 对象，不要有任何前缀或后缀文字：
{"summary":"一句话总览","highlights":["亮点1","亮点2","亮点3"],"notes":["细节发现1","细节发现2"]}

要求：summary 简洁有力，highlights 列3-5个数据洞察，notes 补2-3个有趣观察。用中文。`;

  const userPrompt = `用户共有 ${animeList.length} 部番剧，其中 ${scoredCount} 部有评分数据。

=== 各维度平均百分位（在所有番剧中的位置）===
${dimLines}

=== 评分最集中的标签 ===
${tagLines}

=== 追番密度最高月 ===
${monthLines}

=== 评分波动最大的维度（品味稳定性） ===
${stdLines}

请分析以上数据，输出 JSON。`;

  const raw = await chat(systemPrompt, userPrompt, {
    maxTokens: 800,
    temperature: 0.4,
  });

  return JSON.parse(extractJSON(raw)) as TasteReport;
}

// ════════════════════════════════════════════════════════════════════
// Skill 2: 偏好画像
// ════════════════════════════════════════════════════════════════════

/**
 * 偏好画像分析
 * @param animeList 番剧列表
 * @param mode 'metadata'（默认）或 'deep'（二期实现）
 */
export async function preferenceProfile(
  animeList: AnimeEntry[],
  _mode: ProfileMode = 'metadata',
): Promise<PreferenceProfile> {
  const d = buildDeviationData(animeList);

  if (d.samples.length < 5) {
    // 样本不足，返回兜底
    return {
      likes: [],
      dislikes: [],
      preferenceProfile: '数据不足，需要至少 5 部有 BGM 评分 + 电波评分的番剧才能生成偏好画像',
      tasteDeviation: '',
      hiddenGems: [],
    };
  }

  // 组装偏差概况
  const overallTrend =
    d.avgPosDev > 0.8
      ? '用户总体比 BGM 社区评分更挑剔，对某些特定类型的番有强烈个人偏好'
      : d.avgNegDev < -0.8
        ? '用户总体比 BGM 社区评分更宽容，容易被打动'
        : '用户口味与社区基本一致，偏差不大';

  // 组装正偏差番列表
  const posLines = d.topPos
    .map((x) => {
      const dev = x.deviation > 0 ? `+${x.deviation.toFixed(2)}` : x.deviation.toFixed(2);
      return `  ${x.anime.title} | ${fmtDims(x.anime)} | BGM ${x.anime.bangumiScore} | 偏差 ${dev}`;
    })
    .join('\n');

  // 组装负偏差番列表
  const negLines = d.topNeg
    .map((x) => {
      const dev = x.deviation > 0 ? `+${x.deviation.toFixed(2)}` : x.deviation.toFixed(2);
      return `  ${x.anime.title} | ${fmtDims(x.anime)} | BGM ${x.anime.bangumiScore} | 偏差 ${dev}`;
    })
    .join('\n');

  // 高偏差组标签
  const hiTagLine = d.topHiTags.map(([name, c]) => `${name}×${c}`).join(' ');
  const loTagLine = d.topLoTags.map(([name, c]) => `${name}×${c}`).join(' ');

  // 维度均值对比
  const dimCompare = DEFAULT_DIMENSIONS
    .filter((x) => x.key !== 'overall')
    .map((x) => `  ${x.label}: 高偏差组${d.dimAvgHi[x.key]} vs 低偏差组${d.dimAvgLo[x.key]}`)
    .join('\n');

  // 关键词
  const kwLine = d.keywords.join('、');

  const systemPrompt = `你是一个番剧品味分析师。根据口味偏差数据提炼偏好画像。

口味偏差 = (总评×0.4 + 电波×0.6) − BGM评分。正偏差=隐藏偏好信号，负偏差=潜在雷区。

必须只输出一个 JSON 对象，不要有任何前缀或后缀：
{"likes":[{"aspect":"偏好方面","confidence":0.9,"evidence":"数据证据"}],"dislikes":[{"aspect":"雷区","confidence":0.85,"evidence":"证据"}],"preferenceProfile":"一句话总结用户品味","tasteDeviation":"与社区口味的差异趋势"}

likes 写3-5个偏好倾向，dislikes 写2-3个雷区。用中文，引用具体番剧名和数据。`;

  const userPrompt = `=== 口味偏差概况 ===
用户整体倾向：正偏差番 ${d.posCount} 部（平均偏差 +${d.avgPosDev}），负偏差番 ${d.negCount} 部（平均偏差 ${d.avgNegDev}）
→ ${overallTrend}

=== 强烈正偏差番（个人 >> 社区） ===
${posLines || '(无)'}

=== 强烈负偏差番（社区 >> 个人） ===
${negLines || '(无)'}

=== 样本共性 ===
高偏差番共现标签：${hiTagLine || '(无)'}
低偏差番共现标签：${loTagLine || '(无)'}

高低偏差组维度均值对比：
${dimCompare}

用户评价关键词：${kwLine || '(无)'}

请分析并输出 JSON。`;

  const raw = await chat(systemPrompt, userPrompt, {
    maxTokens: 1500,
    temperature: 0.4,
  });

  return JSON.parse(extractJSON(raw)) as PreferenceProfile;
}

// ════════════════════════════════════════════════════════════════════
// 推荐引擎 — 外部数据源发现模式
// ════════════════════════════════════════════════════════════════════

/** 8 维评分向量（排除 overall） */
function buildScoreVector(a: AnimeEntry): number[] {
  return DEFAULT_DIMENSIONS
    .filter((d) => d.key !== 'overall')
    .map((d) => getScore(a, d.key));
}

/** Jaccard 相似度（数组版本 — 已从 core/math 导入 jaccardArrays） */

/** AniList 搜索结果条目 */
interface DiscoverItem {
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

// ════════════════════════════════════════════════════════════════════
// Skill 3: 智能推荐（外部发现）
// ════════════════════════════════════════════════════════════════════

export interface Recommendation {
  title: string;
  /** 非剧透推荐理由 */
  reason: string;
  /** 简介（非剧透） */
  intro: string;
  /** Bangumi 评分 */
  bgmScore?: number;
  /** 封面图 URL */
  posterUrl?: string;
  /** 上映年份 */
  airDate?: string;
  /** 匹配的偏好标签 */
  matchedTags: string[];
  confidence: number;
}

export interface RecommendResult {
  recommendations: Recommendation[];
  /** 外部发现总数 */
  candidateCount: number;
  /** 搜索用的标签 */
  searchedTags: string[];
  /** 数据来源 */
  sourceLabel?: string;
}

/**
 * 从 Bangumi 按偏好标签发现番剧
 * @param animeList 用户已有番剧（用于排除）
 * @param profile 偏好画像（可选）
 * @param onProgress 进度回调
 */
export async function smartRecommend(
  animeList: AnimeEntry[],
  profile?: PreferenceProfile | null,
  onProgress?: (phase: string) => void,
): Promise<RecommendResult> {
  // 1. 提取搜索标签：高偏差番标签 + 评价关键词 → LLM 提炼为搜索词
  const devData = buildDeviationData(animeList);

  // 从高偏差番提取标签（这是实际标签名，如"科幻""战争"）
  const hiTagNames = devData.topHiTags.map(([name]) => name);
  // 从评价提取关键词（如"泽野弘之""A-1"）
  const kwNames = devData.keywords;

  // 合并去重，过滤太泛的词
  const genericWords = new Set([
    '制作', '剧情', '画风', '音乐', '角色', '声优', '动画', '番剧',
    '作品', '动漫', '设定', '节奏', '演出', '氛围', '很好', '非常',
    '不错', '感觉', '觉得', '比较', '特别', '真的',
  ]);
  const rawTags = [...new Set([...hiTagNames, ...kwNames])]
    .filter((t) => !genericWords.has(t) && t.length >= 2);

  // 如果有偏好画像，用 LLM 从画像中提炼 3-5 个搜索关键词
  let llmSearchKeywords: string[] = [];
  if (profile && rawTags.length >= 3) {
    try {
      const kwSystemPrompt = `你是一个搜索关键词提取器。根据用户偏好画像和已知标签，输出最适合用来在动漫数据库中搜索新番的3-5个关键词。必须是具体的题材/风格/类型词（如：科幻、机甲、催泪、悬疑、日常），不要输出完整的句子。

必须只输出JSON：{"keywords":["关键词1","关键词2",...]}`;

      const kwUserPrompt = `用户偏好: ${profile.preferenceProfile}
喜欢: ${profile.likes.map((l) => l.aspect).join('; ')}
已知标签: ${rawTags.slice(0, 10).join('、')}

请输出搜索关键词。`;

      const kwRaw = await chat(kwSystemPrompt, kwUserPrompt, {
        maxTokens: 200,
        temperature: 0.2,
      });
      const kwParsed = JSON.parse(extractJSON(kwRaw)) as { keywords: string[] };
      llmSearchKeywords = (kwParsed.keywords || []).filter(
        (k: string) => k.length >= 2 && k.length <= 6,
      );
    } catch {
      // 提炼失败，降级使用原始标签
    }
  }

  // 最终搜索标签：LLM 提炼关键词优先，原始标签补充
  const searchTags = [
    ...new Set([...llmSearchKeywords, ...rawTags]),
  ].slice(0, 8);

  if (searchTags.length === 0) {
    // 兜底：用高偏差番的标签
    searchTags.push(...hiTagNames.slice(0, 5));
  }

  // 2. 三层降级发现：AniList → Bangumi v0 标签浏览 → Bangumi 搜索
  onProgress?.('正在搜索匹配番剧…');

  // 取已有番剧标题（优先高分番剧，取前 30 部）
  const excludeTitles = animeList
    .filter((a) => a.scores.some((s) => s.score > 0))
    .sort((a, b) => {
      const sa = getScore(a, 'overall') || calcOverall(a);
      const sb = getScore(b, 'overall') || calcOverall(b);
      return sb - sa;
    })
    .map((a) => a.title)
    .slice(0, 30);

  let discoverResults: DiscoverItem[] = [];
  let sourceLabel = '';

  // Tier 1: AniList GraphQL（海外可直连，搜索最精准）
  try {
    console.log('[推荐] 尝试 AniList 发现…');
    const resp = await fetch('/api/anilist/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: searchTags, excludeTitles }),
    });
    if (resp.ok) {
      const data = await resp.json();
      discoverResults = data.results || [];
      sourceLabel = 'AniList';
      console.log(`[推荐] AniList 返回 ${discoverResults.length} 部`);
    } else {
      console.log(`[推荐] AniList 端点返回 ${resp.status}`);
    }
  } catch (e) {
    console.log('[推荐] AniList 不可用:', e instanceof Error ? e.message : e);
  }

  // Tier 2: Bangumi v0 标签浏览（/v0/subjects?tag=xxx）
  if (discoverResults.length === 0) {
    onProgress?.('AniList 不可用，切换到 Bangumi 标签浏览…');
    try {
      console.log('[推荐] 尝试 Bangumi v0 标签浏览…');
      const resp = await fetch('/api/bangumi/browse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: searchTags }),
      });
      if (resp.ok) {
        const data = await resp.json();
        discoverResults = data.results || [];
        sourceLabel = 'Bangumi';
        console.log(`[推荐] Bangumi v0 返回 ${discoverResults.length} 部`);
      } else {
        console.log(`[推荐] Bangumi v0 端点返回 ${resp.status}`);
      }
    } catch (e) {
      console.log('[推荐] Bangumi v0 不可用:', e instanceof Error ? e.message : e);
    }
  }

  // Tier 3: Bangumi 标题搜索（搜标签关键词 → 能用的最后一招）
  if (discoverResults.length === 0) {
    onProgress?.('尝试 Bangumi 搜索…');
    try {
      console.log('[推荐] 尝试 Bangumi 搜索降级…');
      const resp = await fetch('/api/bangumi/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: searchTags }),
      });
      if (resp.ok) {
        const data = await resp.json();
        discoverResults = data.results || [];
        sourceLabel = 'Bangumi搜索';
        console.log(`[推荐] Bangumi 搜索返回 ${discoverResults.length} 部`);
      }
    } catch (e) {
      console.log('[推荐] Bangumi 搜索不可用:', e instanceof Error ? e.message : e);
    }
  }

  // Tier 4: LLM 直接推荐（利用 LLM 训练数据中的番剧知识）
  if (discoverResults.length === 0) {
    onProgress?.('AI 正在直接从知识库推荐…');
    console.log('[推荐] Tier 4: LLM 直接推荐模式启动');

    const profileText = profile
      ? `偏好画像: ${profile.preferenceProfile}\n喜欢: ${profile.likes.map((l) => l.aspect).join('; ')}\n雷区: ${profile.dislikes.map((d) => d.aspect).join('; ')}`
      : `高偏差番: ${devData.topPos.slice(0, 5).map((d) => d.anime.title).join('、')}\n标签: ${searchTags.join('、')}`;

    const knownTitles = animeList.map((a) => a.title).join('、');

    const directSystemPrompt = `你是番剧推荐大师。根据用户偏好推荐他没看过的番剧。

必须只输出 JSON，无任何前缀后缀：
{"recommendations":[{"title":"番剧名（中文通用译名）","year":"年份","reason":"为什么适合（结合偏好）","intro":"100字风格介绍（不剧透）","confidence":0.9}]}

选3-5部。title 用中文通用译名。超冷门番也可以。`;

    const directUserPrompt = `=== 用户品味 ===
${profileText}

=== 用户已看过（不要推荐这些）===
${knownTitles.slice(0, 1000)}

请推荐。`;

    try {
      console.log('[推荐] 调用 LLM 直接推荐…');
      const directRaw = await chat(directSystemPrompt, directUserPrompt, {
        maxTokens: 1500,
        temperature: 0.6,
      });
      console.log('[推荐] LLM 返回长度:', directRaw.length);

      const parsed = JSON.parse(extractJSON(directRaw)) as {
        recommendations: { title: string; year?: string; reason: string; intro: string; confidence: number }[];
      };
      console.log('[推荐] 解析到', parsed.recommendations?.length, '条推荐');

      if (parsed.recommendations?.length > 0) {
        discoverResults = parsed.recommendations.map((rec) => ({
          id: -(Math.random() * 10000) | 0,
          name: rec.title,
          name_cn: rec.title,
          summary: rec.intro || '',
          images: {},
          rating: { score: 0 },
          air_date: rec.year || '',
          eps: 0,
          matchedTag: 'AI推荐',
        }));
        sourceLabel = 'AI直接推荐';
        console.log('[推荐] LLM 直接推荐成功:', discoverResults.length, '部');
      } else {
        console.log('[推荐] LLM 返回空推荐列表');
      }
    } catch (e) {
      console.error('[推荐] LLM 直接推荐失败:', e instanceof Error ? e.message : e);
    }
  }

  // 3. 排除用户已有番剧（AI 直接推荐时跳过——LLM 已在 prompt 中知晓已看列表）
  const isDirectLLM = sourceLabel === 'AI直接推荐';
  const norm = (s: string) => (s || '').replace(/[\s\-_:：・().,，、　]+/g, '').toLowerCase();

  const externalCandidates = isDirectLLM
    ? discoverResults
    : (() => {
        const existingTitles = new Set(
          animeList.map((a) => [norm(a.title), norm(a.titleJa || ''), norm(a.searchAlias || '')]).flat(),
        );
        return discoverResults.filter((item) => {
          const cn = norm(item.name_cn || '');
          const en = norm((item as DiscoverItem & { name_en?: string }).name_en || '');
          const jp = norm(item.name || '');
          return (
            !existingTitles.has(cn) &&
            !existingTitles.has(en) &&
            !existingTitles.has(jp) &&
            cn.length >= 2
          );
        });
      })();

  if (externalCandidates.length < 3) {
    return {
      recommendations: externalCandidates.map((item) => ({
        title: item.name_cn || item.name,
        reason: `匹配标签「${item.matchedTag}」`,
        intro: item.summary?.slice(0, 120) || '暂无简介',
        bgmScore: item.rating?.score,
        posterUrl: item.images?.large || item.images?.common,
        airDate: item.air_date,
        matchedTags: [item.matchedTag],
        confidence: 0.5,
      })),
      candidateCount: externalCandidates.length,
      searchedTags: searchTags,
    };
  }

  // 4. 组装候选列表 → LLM 精选
  onProgress?.('AI 正在筛选最佳推荐…');

  const candidateLines = externalCandidates
    .map((item) => {
      const title = item.name_cn || item.name;
      const score = item.rating?.score ? `评分${item.rating.score}` : '';
      const date = item.air_date ? `(${item.air_date})` : '';
      const genres = item.genres?.length
        ? `类型: ${item.genres.slice(0, 5).join('/')}`
        : '';
      const summary = (item.summary || '').replace(/<[^>]+>/g, '').slice(0, 200);
      return `- ${title} ${date} ${score} ${genres} | 搜索: ${item.matchedTag}\n  简介: ${summary}`;
    })
    .join('\n\n');

  const profileText = profile
    ? `偏好画像: ${profile.preferenceProfile}\n喜欢: ${profile.likes.map((l) => l.aspect).join('、')}\n雷区: ${profile.dislikes.map((d) => d.aspect).join('、')}`
    : `高偏差番高频标签: ${hiTagNames.join('、')}\n用户评价关键词: ${kwNames.join('、')}`;

  const systemPrompt = `你是一个番剧推荐师。根据用户的品味偏好，从 Bangumi 发现的候选番剧中精选推荐。

核心原则：
- 绝不剧透剧情走向、关键转折或结局
- 简介只描述番剧的类型、风格、氛围和看点，不提及具体情节
- 推荐理由要结合用户偏好，说清楚"为什么这部适合你"

必须只输出一个 JSON 对象：
{"recommendations":[{"title":"番剧名","reason":"为什么适合你（结合偏好，不剧透）","intro":"100字以内的风格介绍（不剧透）","confidence":0.9}]}

选3-5部，confidence 0-1。用中文。`;

  const userPrompt = `=== 用户品味特征 ===
${profileText}

搜索标签: ${searchTags.join('、')}

=== Bangumi 候选番剧（共${externalCandidates.length}部）===
${candidateLines}

请精选推荐。`;

  onProgress?.('AI 正在生成推荐理由…');

  const raw = await chat(systemPrompt, userPrompt, {
    maxTokens: 1500,
    temperature: 0.4,
  });

  const llmResult = JSON.parse(extractJSON(raw)) as {
    recommendations: { title: string; reason: string; intro: string; confidence: number }[];
  };

  // 5. 合并 LLM 推荐与 AniList 元数据（封面、评分、类型、年份）
  const merged: Recommendation[] = llmResult.recommendations.map((rec) => {
    const normTitle = norm(rec.title);
    const match = externalCandidates.find(
      (item) =>
        norm(item.name_cn || '').includes(normTitle) ||
        norm(item.name || '').includes(normTitle) ||
        normTitle.includes(norm(item.name_cn || '')) ||
        normTitle.includes(norm(item.name || '')),
    );
    // 收集匹配标签：搜索命中标签 + AniList genres + 前几个 AniList tags
    const matchedTags = [
      ...new Set([
        ...(match?.matchedTag ? [match.matchedTag] : []),
        ...(match?.genres?.slice(0, 3) || []),
        ...(match?.tags?.slice(0, 3) || []),
      ]),
    ];
    return {
      title: rec.title,
      reason: rec.reason,
      intro: rec.intro || match?.summary?.replace(/<[^>]+>/g, '').slice(0, 120) || '',
      bgmScore: match?.rating?.score,
      posterUrl: match?.images?.large || match?.images?.common || '',
      airDate: match?.air_date || '',
      matchedTags,
      confidence: rec.confidence,
    };
  });

  return {
    recommendations: merged,
    candidateCount: externalCandidates.length,
    searchedTags: searchTags,
    sourceLabel,
  };
}

// ════════════════════════════════════════════════════════════════════
// Skill 4: 单部分析
// ════════════════════════════════════════════════════════════════════

export interface SingleAnimeAnalysisResult {
  coreAppeal: { aspect: string; evidence: string; confidence: number }[];
  vibePattern: string;
  communityGap: string;
  similarAnime: { title: string; why: string }[];
}

/**
 * 对单部番剧做深度分析——为什么电波高/低，口味偏差的原因
 * @param anime 目标番剧
 * @param allAnime 全部番剧列表（用于百分位和相似度计算）
 */
export async function singleAnimeAnalysis(
  anime: AnimeEntry,
  allAnime: AnimeEntry[],
): Promise<SingleAnimeAnalysisResult> {
  const stats = buildPercentileMap(allAnime);
  const pcts = getPercentileScores(anime, stats);

  // 维度分数 + 百分位
  const dimLines = DEFAULT_DIMENSIONS
    .filter((d) => d.key !== 'overall')
    .map((d) => {
      const s = getScore(anime, d.key);
      const p = pcts.find((pct) => pct.dimensionKey === d.key);
      const pct = p ? `${p.percentile}%` : '-';
      return `  ${d.label}: ${s.toFixed(d.key === 'vibe' ? 2 : 1)}（百分位${pct}）`;
    })
    .join('\n');

  const overall = getScore(anime, 'overall') || calcOverall(anime);
  const vibe = getScore(anime, 'vibe');
  const deviation = calcTasteDeviation(anime);
  const devText = deviation !== null
    ? (deviation > 0
        ? `+${deviation.toFixed(2)}（你远比社区更喜欢这部番）`
        : `${deviation.toFixed(2)}（社区评分高于你的个人感受）`)
    : '无 BGM 数据，无法计算偏差';

  const bgm = anime.bangumiScore ? `BGM ${anime.bangumiScore}` : '无';

  // 余弦相似度 top-3
  const targetVec = buildScoreVector(anime);
  const sims = allAnime
    .filter((a) => a.id !== anime.id && a.scores.some((s) => s.score > 0))
    .map((a) => ({ anime: a, sim: cosineSimilarity(targetVec, buildScoreVector(a)) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, 3);

  const simLines = sims
    .map((x) => `  ${x.anime.title}（余弦${(x.sim * 100).toFixed(0)}%）`)
    .join('\n');

  const review = anime.review || '（无评价）';
  const tags = anime.tags.map((t) => t.name).join('、');

  const systemPrompt = `你是一个番剧分析专家。根据用户的评分数据，分析一部番剧为什么对用户有特别的意义（或为什么不来电）。

必须只输出一个 JSON 对象，不要有任何前缀或后缀：
{"coreAppeal":[{"aspect":"打动用户的方面","evidence":"数据证据","confidence":0.9}],"vibePattern":"与其他高电波番共性的总结，或为什么电波低的模式","communityGap":"用户和社区口味差距的原因分析","similarAnime":[{"title":"相似的番剧名","why":"为什么相似"}]}

coreAppeal 写2-4个方面，communityGap 如果无 BGM 数据写"无社区对比数据"。用中文。`;

  const userPrompt = `番剧：${anime.title}
维度分数：${fmtDims(anime)}
百分位排名：${dimLines}
口味偏差值：${devText}
${bgm}
标签：${tags || '无'}

用户评价：
"${review.slice(0, 500)}"

相似番剧（余弦相似度 top-3）：
${simLines || '无足够数据'}

请分析并输出 JSON。`;

  const raw = await chat(systemPrompt, userPrompt, {
    maxTokens: 800,
    temperature: 0.4,
  });

  return JSON.parse(extractJSON(raw)) as SingleAnimeAnalysisResult;
}

// ════════════════════════════════════════════════════════════════════
// Skill 5: 图谱优化
// ════════════════════════════════════════════════════════════════════

export interface GraphOptimizationResult {
  merges: { from: string; to: string; reason: string }[];
  newTags: { anime: string; tag: string; reason: string }[];
  issues: string[];
}

/**
 * 分析标签体系，建议合并/新增标签
 */
export async function graphOptimize(
  animeList: AnimeEntry[],
): Promise<GraphOptimizationResult> {
  // 1. 标签使用统计
  const tagAnimeMap: Record<string, AnimeEntry[]> = {};
  for (const a of animeList) {
    for (const t of a.tags) {
      if (!tagAnimeMap[t.name]) tagAnimeMap[t.name] = [];
      tagAnimeMap[t.name].push(a);
    }
  }

  // 2. 找到 Jaccard 高但名称不同的标签对
  const tagNames = Object.keys(tagAnimeMap).filter(
    (name) => tagAnimeMap[name].length >= 2,
  );
  const redundantPairs: { from: string; to: string; jaccard: number }[] = [];
  for (let i = 0; i < tagNames.length; i++) {
    for (let j = i + 1; j < tagNames.length; j++) {
      const idsA = new Set(tagAnimeMap[tagNames[i]].map((a) => a.id));
      const idsB = new Set(tagAnimeMap[tagNames[j]].map((a) => a.id));
      const jac = jaccardArrays([...idsA], [...idsB]);
      if (jac >= 0.4 && tagNames[i] !== tagNames[j]) {
        const aLen = idsA.size;
        const bLen = idsB.size;
        // 建议合并方向：更多番剧的标签为主
        redundantPairs.push({
          from: aLen >= bLen ? tagNames[j] : tagNames[i],
          to: aLen >= bLen ? tagNames[i] : tagNames[j],
          jaccard: jac,
        });
      }
    }
  }
  // 去重并取 top-10
  const seenPairs = new Set<string>();
  const topPairs = redundantPairs
    .filter((p) => {
      const key = [p.from, p.to].sort().join('|');
      if (seenPairs.has(key)) return false;
      seenPairs.add(key);
      return true;
    })
    .sort((a, b) => b.jaccard - a.jaccard)
    .slice(0, 10);

  // 3. 单次使用的稀有标签
  const rareTags = tagNames.filter(
    (name) => tagAnimeMap[name].length === 1,
  ).slice(0, 10);

  // 4. 无标签但评分完整的番剧
  const untaggedScored = animeList
    .filter(
      (a) =>
        a.tags.length === 0 &&
        a.scores.some((s) => s.score > 0) &&
        DEFAULT_DIMENSIONS.filter((d) => d.key !== 'overall').every(
          (d) => getScore(a, d.key) > 0,
        ),
    )
    .slice(0, 10);

  // 5. 组装 Prompt
  const pairLines = topPairs
    .map(
      (p) =>
        `  "${p.from}"(${tagAnimeMap[p.from]?.length || 0}部) ↔ "${p.to}"(${tagAnimeMap[p.to]?.length || 0}部) — Jaccard ${(p.jaccard * 100).toFixed(0)}%`,
    )
    .join('\n');

  const rareLines = rareTags
    .map((name) => `  ${name}（${tagAnimeMap[name]?.length || 0}部）`)
    .join('\n');

  const untaggedLines = untaggedScored
    .map((a) => {
      const dims = DEFAULT_DIMENSIONS
        .filter((d) => d.key !== 'overall')
        .map((d) => `${d.label}${getScore(a, d.key).toFixed(1)}`)
        .join(' ');
      return `  ${a.title} | ${dims} | 现有标签：无`;
    })
    .join('\n');

  const systemPrompt = `你是一个标签体系优化专家。分析动漫标签数据，发现可合并的冗余标签和应添加的标签。

必须只输出一个 JSON 对象，不要有任何前缀或后缀：
{"merges":[{"from":"标签名","to":"目标标签","reason":"合并理由"}],"newTags":[{"anime":"番剧名","tag":"建议标签","reason":"理由"}],"issues":["其他发现的问题"]}

merges 建议2-5个合并，newTags 建议2-5个新增标签，issues 写1-3个体系问题。用中文。`;

  const userPrompt = `标签总数：${tagNames.length} 个，番剧总数：${animeList.length} 部

=== 疑似冗余标签对（Jaccard ≥ 0.4）===
${pairLines || '无显著冗余对'}

=== 低频使用标签（仅1部番剧使用）===
${rareLines || '无'}

=== 无标签但评分完整的番剧 ===
${untaggedLines || '无'}

请分析并输出 JSON。`;

  const raw = await chat(systemPrompt, userPrompt, {
    maxTokens: 1200,
    temperature: 0.3,
  });

  return JSON.parse(extractJSON(raw)) as GraphOptimizationResult;
}

// ════════════════════════════════════════════════════════════════════
// Skill 6: 智能打 tag
// ════════════════════════════════════════════════════════════════════

export interface AutoTagResult {
  suggestedTags: { name: string; reason: string }[];
}

/**
 * 调用 Bangumi 获取番剧标签，让 LLM 筛选建议标签
 */
export async function autoTag(
  anime: AnimeEntry,
): Promise<AutoTagResult> {
  // 1. 从 Bangumi 搜索该番剧的标签数据
  let bangumiTags: string[] = [];
  let bangumiSummary = '';
  try {
    const getResp = await fetch(
      `/api/bangumi/search?keyword=${encodeURIComponent(anime.title)}`,
    );
    if (getResp.ok) {
      const data = await getResp.json();
      const list = data?.list || [];
      if (list.length > 0) {
        // 提取标签
        const item = list[0];
        bangumiSummary = item.summary || '';
        const tags = item.tags || [];
        bangumiTags = tags.map((t: { name: string }) => t.name);
      }
    }
  } catch {
    // Bangumi 不可用时降级
  }

  // 2. 提取番剧维度特征
  const dims = DEFAULT_DIMENSIONS
    .filter((d) => d.key !== 'overall')
    .map((d) => `${d.label}${getScore(anime, d.key).toFixed(1)}`)
    .join(' ');

  const existingTags = anime.tags.map((t) => t.name);

  const systemPrompt = `你是一个番剧标签专家。根据番剧信息和已有标签，建议最合适的补充标签。

必须只输出一个 JSON 对象，不要有任何前缀或后缀：
{"suggestedTags":[{"name":"标签名","reason":"建议理由"}]}

建议3-5个标签，应为2-4个汉字或常见动漫分类术语，不应与已有标签重复。用中文。`;

  const userPrompt = `番剧：${anime.title}
制作公司：${anime.studio || '未知'}
维度评分：${dims}
已有标签：${existingTags.length > 0 ? existingTags.join('、') : '无'}
Bangumi 社区标签：${bangumiTags.length > 0 ? bangumiTags.join('、') : '无数据'}
Bangumi 简介：${bangumiSummary ? bangumiSummary.slice(0, 300) : '无'}

请建议应补充的标签。`;

  const raw = await chat(systemPrompt, userPrompt, {
    maxTokens: 500,
    temperature: 0.3,
  });

  return JSON.parse(extractJSON(raw)) as AutoTagResult;
}

// ════════════════════════════════════════════════════════════════════
// Skill 2-extended: 偏好画像（深度模式）
// ════════════════════════════════════════════════════════════════════

/** 逐番分析结果（深度模式 Step 1） */
interface AnimeReviewAnalysis {
  title: string;
  strengths: string[];
  weaknesses: string[];
}

/**
 * 深度模式 Step 1：逐番调 LLM 分析 Bangumi 社区评论
 * @param reviewData /api/bangumi/reviews 返回的 { title: { reviews[] } }
 * @param deviationData 口味偏差数据
 * @param onProgress 进度回调 (current, total)
 */
async function deepStep1_PerAnime(
  reviewData: Record<string, { reviews: string[] }>,
  deviationData: DeviationData,
  onProgress?: (current: number, total: number) => void,
): Promise<AnimeReviewAnalysis[]> {
  // 取有评论数据的番剧（正负偏差各取有数据的，最多 10 + 10 = 20 部）
  const posTitles = deviationData.topPos
    .map((d) => d.anime.title)
    .filter((t) => reviewData[t]?.reviews?.length > 0)
    .slice(0, 10);
  const negTitles = deviationData.topNeg
    .map((d) => d.anime.title)
    .filter((t) => reviewData[t]?.reviews?.length > 0)
    .slice(0, 10);
  const allTitles = [...new Set([...posTitles, ...negTitles])];

  if (allTitles.length === 0) return [];

  const results: AnimeReviewAnalysis[] = [];
  const total = allTitles.length;

  const reviewSystemPrompt = `从以下 Bangumi 社区评论和标签数据中提取 3 个社区普遍认可的"优点"和 2 个社区普遍吐槽的"雷点"，用短语概括。

必须只输出一个 JSON，无前缀后缀：
{"strengths":["优点1","优点2","优点3"],"weaknesses":["雷点1","雷点2"]}

用中文短语（2-6字），不要长句。`;

  for (let i = 0; i < allTitles.length; i++) {
    const title = allTitles[i];
    const data = reviewData[title];
    if (!data) continue;

    const reviewsText = data.reviews.join('\n').slice(0, 2000);

    try {
      // 找到该番剧的偏差方向
      const dev =
        deviationData.topPos.find((d) => d.anime.title === title) ||
        deviationData.topNeg.find((d) => d.anime.title === title);
      const devLabel = dev
        ? `口味偏差 ${dev.deviation > 0 ? '+' : ''}${dev.deviation.toFixed(2)}`
        : '';

      const userPrompt = `以下是「${title}」的 Bangumi 社区数据${devLabel ? `（用户${devLabel}）` : ''}：

${reviewsText}

请提取优点和雷点。`;

      const raw = await chat(reviewSystemPrompt, userPrompt, {
        maxTokens: 600,
        temperature: 0.3,
      });

      const parsed = JSON.parse(extractJSON(raw)) as {
        strengths: string[];
        weaknesses: string[];
      };
      results.push({
        title,
        strengths: parsed.strengths || [],
        weaknesses: parsed.weaknesses || [],
      });
    } catch {
      // 单部失败不影响整体
      results.push({ title, strengths: [], weaknesses: [] });
    }

    onProgress?.(i + 1, total);

    // 请求间隔（避免 LLM 限流）
    if (i < allTitles.length - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return results;
}

/**
 * 深度模式 Step 2：汇总所有番剧分析结果，提取共性
 */
async function deepStep2_Commonality(
  perAnimeResults: AnimeReviewAnalysis[],
  deviationData: DeviationData,
): Promise<PreferenceProfile> {
  // 组装正偏差番的优点 + 负偏差番的雷点
  const posTitles = new Set(
    deviationData.topPos.map((d) => d.anime.title),
  );
  const negTitles = new Set(
    deviationData.topNeg.map((d) => d.anime.title),
  );

  const posResults = perAnimeResults.filter((r) => posTitles.has(r.title));
  const negResults = perAnimeResults.filter((r) => negTitles.has(r.title));

  const posStrengths = posResults.flatMap((r) =>
    r.strengths.map((s) => `[${r.title}] ${s}`),
  );
  const negWeaknesses = negResults.flatMap((r) =>
    r.weaknesses.map((w) => `[${r.title}] ${w}`),
  );

  // 偏差概况
  const overallTrend =
    deviationData.avgPosDev > 0.8
      ? '用户总体比 BGM 社区评分更挑剔，对某些特定类型有强烈偏好'
      : deviationData.avgNegDev < -0.8
        ? '用户总体比 BGM 社区评分更宽容'
        : '用户口味与社区基本一致';

  const systemPrompt = `你是一个番剧品味分析师。根据多部番剧的优点/雷点分析结果，结合口味偏差值，提炼用户的整体偏好模型。

必须只输出一个 JSON 对象：
{"likes":[{"aspect":"偏好方面","confidence":0.9,"evidence":"数据证据"}],"dislikes":[{"aspect":"雷区","confidence":0.85,"evidence":"证据"}],"preferenceProfile":"一句话总结用户品味","tasteDeviation":"与社区口味的差异趋势描述"}

likes 写3-5个偏好倾向，dislikes 写2-3个雷区。用中文。`;

  const userPrompt = `=== 口味偏差概况 ===
正偏差番 ${deviationData.posCount} 部（平均 +${deviationData.avgPosDev}），负偏差番 ${deviationData.negCount} 部（平均 ${deviationData.avgNegDev}）
→ ${overallTrend}

=== 正偏差番 — 社区认可的优点 ===
${posStrengths.join('\n') || '无数据'}

=== 负偏差番 — 社区吐槽的雷点 ===
${negWeaknesses.join('\n') || '无数据'}

=== 用户评价关键词 ===
${deviationData.keywords.join('、') || '无'}

请提炼偏好画像。`;

  const raw = await chat(systemPrompt, userPrompt, {
    maxTokens: 1500,
    temperature: 0.4,
  });

  return JSON.parse(extractJSON(raw)) as PreferenceProfile;
}

/**
 * 运行深度模式偏好画像（完整流程）
 *
 * 流程：
 *   1. 调 /api/bangumi/reviews 采集社区数据
 *   2. 逐番调 LLM 提取优点/雷点（deepStep1）
 *   3. 汇总共性提取（deepStep2）
 *
 * @param animeList 番剧列表
 * @param onPhase 阶段回调用于 UI 进度展示
 * @param onProgress 逐番进度回调 (current, total)
 */
export async function preferenceProfileDeep(
  animeList: AnimeEntry[],
  onPhase?: (phase: 'collecting' | 'analyzing' | 'synthesizing') => void,
  onProgress?: (current: number, total: number) => void,
): Promise<PreferenceProfile> {
  const d = buildDeviationData(animeList);

  if (d.samples.length < 5) {
    return {
      likes: [],
      dislikes: [],
      preferenceProfile: '数据不足，需要至少 5 部有 BGM 评分 + 电波评分的番剧',
      tasteDeviation: '',
      hiddenGems: [],
    };
  }

  // Phase 1: 采集 Bangumi 评论数据
  onPhase?.('collecting');

  const titles = [...new Set([...d.topPos, ...d.topNeg].map((x) => x.anime.title))];
  let reviewData: Record<string, { reviews: string[] }> = {};

  try {
    const resp = await fetch('/api/bangumi/reviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ titles }),
    });
    if (resp.ok) {
      const json = await resp.json();
      reviewData = json.results || {};
    }
  } catch {
    // 采集失败，降级为元数据模式
    return await preferenceProfile(animeList, 'metadata');
  }

  // Phase 2: 逐番 LLM 分析
  onPhase?.('analyzing');

  const perAnimeResults = await deepStep1_PerAnime(
    reviewData,
    d,
    onProgress,
  );

  if (perAnimeResults.length === 0) {
    return await preferenceProfile(animeList, 'metadata');
  }

  // Phase 3: 共性提取
  onPhase?.('synthesizing');

  return await deepStep2_Commonality(perAnimeResults, d);
}
