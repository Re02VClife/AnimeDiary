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

/** 从 LLM 原始输出中提取 JSON（处理 markdown 代码块等） */
function extractJSON(raw: string): string {
  // 去掉 ```json ... ``` 包裹
  const codeBlock = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) return codeBlock[1].trim();
  // 尝试找到第一个 { 到最后一个 }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) return raw.slice(start, end + 1);
  return raw.trim();
}

// ════════════════════════════════════════════════════════════════════
// 工具函数
// ════════════════════════════════════════════════════════════════════

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

/** 简单中文分词 + 关键词提取（频次统计，不调 LLM） */
function extractKeywords(
  texts: string[],
  topN: number = 20,
): string[] {
  const stopWords = new Set([
    '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
    '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着',
    '没有', '看', '好', '自己', '这', '他', '她', '它', '们', '那', '但',
    '而', '且', '或', '与', '及', '之', '为', '以', '可以', '这个', '那个',
    '还', '更', '最', '被', '把', '从', '让', '对', '所以', '因为', '如果',
    '虽然', '但是', '然而', '然后', '于是', '因此', '不过', '只是', '觉得',
    '感觉', '真的', '非常', '比较', '特别', '一些', '很多', '这部', '这部番',
    '番', '动漫', '动画', '作品', '剧情', '角色', '制作', '画面', '音乐',
  ]);

  const wordFreq: Record<string, number> = {};
  for (const text of texts) {
    // 按标点/空格分割
    const segments = text.split(/[，,。.!！？?、；;：:（）()【】\[\]""''\s\n\r]+/);
    for (const seg of segments) {
      if (!seg || seg.length < 2 || seg.length > 8) continue;
      if (stopWords.has(seg)) continue;
      wordFreq[seg] = (wordFreq[seg] || 0) + 1;
    }
  }

  return Object.entries(wordFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([w]) => w);
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
// 推荐候选池工具
// ════════════════════════════════════════════════════════════════════

/** 8 维评分向量（排除 overall） */
function buildScoreVector(a: AnimeEntry): number[] {
  return DEFAULT_DIMENSIONS
    .filter((d) => d.key !== 'overall')
    .map((d) => getScore(a, d.key));
}

/** 余弦相似度 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Jaccard 相似度 */
function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = [...setA].filter((x) => setB.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

export interface Candidate {
  anime: AnimeEntry;
  score: number;
  reason: string;
}

/**
 * 构建推荐候选池
 * 1. 余弦相似度 top-15（基于 8 维评分向量）
 * 2. 图谱路径推荐（同公司 + 共享标签 >= 2）
 * 3. 排除已看/在看/抛弃/弃番
 */
export function buildCandidatePool(
  allAnime: AnimeEntry[],
  profile?: PreferenceProfile | null,
): Candidate[] {
  const exclude = new Set(['watched', 'watching', 'dropped', 'onHold']);
  const candidates = allAnime.filter((a) => !exclude.has(a.category));
  if (candidates.length === 0) return [];

  const scored = allAnime.filter((a) =>
    a.scores.some((s) => s.score > 0),
  );
  // 以所有有评分的番作为参考
  const refVectors = scored.map((a) => ({
    anime: a,
    vector: buildScoreVector(a),
  }));

  const candidateSet = new Map<string, Candidate>();

  // 1. 余弦相似度（对每个候选，取与所有参考番的最大相似度）
  for (const c of candidates) {
    const cv = buildScoreVector(c);
    let maxSim = 0;
    for (const ref of refVectors) {
      const sim = cosineSimilarity(cv, ref.vector);
      if (sim > maxSim) maxSim = sim;
    }
    if (maxSim > 0.3) {
      candidateSet.set(c.id, {
        anime: c,
        score: maxSim,
        reason: `评分向量余弦相似度 ${(maxSim * 100).toFixed(0)}%`,
      });
    }
  }

  // 2. 图谱路径（同公司 + 共享标签）
  for (const c of candidates) {
    const existing = candidateSet.get(c.id);
    for (const ref of refVectors) {
      let graphScore = 0;
      const reasons: string[] = [];
      if (c.studio && ref.anime.studio === c.studio) {
        graphScore += 0.3;
        reasons.push(`同公司: ${c.studio}`);
      }
      const sharedTags = c.tags
        .filter((t) => ref.anime.tags.some((rt) => rt.name === t.name));
      if (sharedTags.length >= 2) {
        graphScore += 0.15 * sharedTags.length;
        reasons.push(`共享标签: ${sharedTags.map((t) => t.name).join(', ')}`);
      }
      if (graphScore > 0 && (!existing || graphScore > existing.score)) {
        candidateSet.set(c.id, {
          anime: c,
          score: Math.min(graphScore, 0.95),
          reason: reasons.join('; '),
        });
      }
    }
  }

  // 排序取 top-20
  return [...candidateSet.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
}

// ════════════════════════════════════════════════════════════════════
// Skill 3: 智能推荐
// ════════════════════════════════════════════════════════════════════

export interface Recommendation {
  title: string;
  reason: string;
  confidence: number;
}

export interface RecommendResult {
  recommendations: Recommendation[];
}

export async function smartRecommend(
  allAnime: AnimeEntry[],
  profile?: PreferenceProfile | null,
): Promise<RecommendResult> {
  const candidates = buildCandidatePool(allAnime, profile);
  if (candidates.length < 3) {
    return {
      recommendations: candidates.map((c) => ({
        title: c.anime.title,
        reason: c.reason,
        confidence: c.score,
      })),
    };
  }

  // 候选列表
  const candidateLines = candidates
    .map((c) => {
      const dims = DEFAULT_DIMENSIONS
        .filter((d) => d.key !== 'overall')
        .map((d) => `${d.label}${getScore(c.anime, d.key).toFixed(1)}`)
        .join(' ');
      const tags = c.anime.tags.map((t) => t.name).join('/');
      return `- ${c.anime.title} | ${dims} | 标签: ${tags} | 匹配: ${c.reason}`;
    })
    .join('\n');

  const profileText = profile
    ? `偏好: ${profile.preferenceProfile}\n喜欢: ${profile.likes.map((l) => l.aspect).join('、')}\n雷区: ${profile.dislikes.map((d) => d.aspect).join('、')}`
    : '（未生成偏好画像，基于评分相似度推荐）';

  const systemPrompt = `你是番剧推荐专家。从候选列表中选3-5部最适合用户的番。

必须只输出JSON，无前缀后缀：
{"recommendations":[{"title":"番剧名","reason":"推荐理由","confidence":0.9}]}

confidence=推荐把握度(0-1)，reason结合用户偏好说明为什么匹配。用中文。`;

  const userPrompt = `用户偏好画像：
${profileText}

候选列表（共${candidates.length}部）：
${candidateLines}

请推荐。`;

  const raw = await chat(systemPrompt, userPrompt, {
    maxTokens: 600,
    temperature: 0.3,
  });
  return JSON.parse(extractJSON(raw)) as RecommendResult;
}
