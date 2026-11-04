/**
 * features/ai-analysis/preference-profile — Skill 2: 偏好画像（含深度模式）
 *
 * 口味偏差 = (总评×0.4 + 电波×0.6) − BGM 评分
 *   正偏差 = 你比社区更喜欢它（藏着偏好线索）
 *   负偏差 = 社区比你更喜欢它（可能的雷区）
 */

import type { AnimeEntry } from '../../src/types';
import { aiJSON, AIError } from './llm-service';
import { extractKeywords } from '../../core/text';
import { getScore, calcOverall, calcTasteDeviation, fmtDims, getDimensionsForList } from './ai-helpers';
import type { DeviationData, PreferenceProfile, ProfileMode, AnimeReviewAnalysis } from './ai-types';
import { PROFILE_SCHEMA, REVIEW_SCHEMA } from './ai-types';

export interface ProfileOptions {
  signal?: AbortSignal;
  stream?: boolean;
}

// ── 数据准备 ──

/** 计算口味偏差相关数据 */
export function buildDeviationData(animeList: AnimeEntry[]): DeviationData {
  const dims = getDimensionsForList(animeList);
  const withDev = animeList
    .map((a) => ({ anime: a, deviation: calcTasteDeviation(a) }))
    .filter((d): d is { anime: AnimeEntry; deviation: number } => d.deviation !== null);

  const posCount = withDev.filter((d) => d.deviation > 0).length;
  const negCount = withDev.filter((d) => d.deviation < 0).length;
  const avgPosDev = posCount > 0
    ? withDev.filter((d) => d.deviation > 0).reduce((s, d) => s + d.deviation, 0) / posCount
    : 0;
  const avgNegDev = negCount > 0
    ? withDev.filter((d) => d.deviation < 0).reduce((s, d) => s + d.deviation, 0) / negCount
    : 0;

  const byDev = [...withDev].sort((a, b) => b.deviation - a.deviation);
  const topPos = byDev.filter((d) => d.deviation > 0).slice(0, 15);
  const topNeg = byDev
    .filter((d) => d.deviation < 0)
    .sort((a, b) => a.deviation - b.deviation)
    .slice(0, 15);

  const byVibe = [...animeList]
    .filter((a) => getScore(a, 'vibe') > 0)
    .sort((a, b) => getScore(b, 'vibe') - getScore(a, 'vibe'));
  const vibeTop = byVibe.slice(0, 10);
  const vibeBottom = byVibe.slice(-10).reverse();

  const sampleSet = new Map<string, AnimeEntry>();
  for (const d of topPos) sampleSet.set(d.anime.id, d.anime);
  for (const d of topNeg) sampleSet.set(d.anime.id, d.anime);
  for (const a of vibeTop) sampleSet.set(a.id, a);
  for (const a of vibeBottom) sampleSet.set(a.id, a);
  const samples = [...sampleSet.values()];

  const hiIds = new Set(topPos.map((d) => d.anime.id));
  const loIds = new Set(topNeg.map((d) => d.anime.id));

  const tagHi: Record<string, number> = {};
  const tagLo: Record<string, number> = {};
  for (const d of topPos) for (const t of d.anime.tags) tagHi[t.name] = (tagHi[t.name] || 0) + 1;
  for (const d of topNeg) for (const t of d.anime.tags) tagLo[t.name] = (tagLo[t.name] || 0) + 1;

  const topHiTags = Object.entries(tagHi).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const topLoTags = Object.entries(tagLo).sort((a, b) => b[1] - a[1]).slice(0, 8);

  const dimAvgHi: Record<string, number> = {};
  const dimAvgLo: Record<string, number> = {};
  for (const dim of dims) {
    if (dim.key === 'overall') continue;
    const hiScores = topPos.map((d) => getScore(d.anime, dim.key)).filter((s) => s > 0);
    const loScores = topNeg.map((d) => getScore(d.anime, dim.key)).filter((s) => s > 0);
    dimAvgHi[dim.key] = hiScores.length > 0
      ? +(hiScores.reduce((a, b) => a + b, 0) / hiScores.length).toFixed(1) : 0;
    dimAvgLo[dim.key] = loScores.length > 0
      ? +(loScores.reduce((a, b) => a + b, 0) / loScores.length).toFixed(1) : 0;
  }

  const hiReviews = topPos.map((d) => d.anime.review || '').filter((r) => r.length > 0);
  const keywords = extractKeywords(hiReviews, 15);

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
    withDev, posCount, negCount,
    avgPosDev: +avgPosDev.toFixed(2),
    avgNegDev: +avgNegDev.toFixed(2),
    topPos, topNeg, vibeTop, vibeBottom,
    samples, hiIds, loIds,
    topHiTags, topLoTags, dimAvgHi, dimAvgLo,
    keywords, topYears,
  };
}

function overallTrend(d: DeviationData): string {
  return d.avgPosDev > 0.8
    ? '整体上比社区更挑剔：喜欢的东西是真的喜欢，但大部分作品在你这儿低于社区评价'
    : d.avgNegDev < -0.8
      ? '整体上比社区更宽容：容易被作品打动，社区觉得一般的东西你也能看出好处'
      : '整体口味与社区接近，偏差集中在个别作品上';
}

function emptyProfile(reason: string): PreferenceProfile {
  return { likes: [], dislikes: [], preferenceProfile: reason, tasteDeviation: '', hiddenGems: [] };
}

// ── Skill 2: 偏好画像（元数据模式）──

export async function preferenceProfile(
  animeList: AnimeEntry[],
  _mode: ProfileMode = 'metadata',
  opts: ProfileOptions = {},
): Promise<PreferenceProfile> {
  const d = buildDeviationData(animeList);
  if (d.samples.length < 5) {
    return emptyProfile('数据不足，需要至少 5 部有 BGM 评分 + 电波评分的番剧才能生成偏好画像');
  }

  const dims = getDimensionsForList(animeList);
  const posLines = d.topPos
    .map((x) => `  ${x.anime.title}｜${fmtDims(x.anime, dims)}｜BGM ${x.anime.bangumiScore}｜偏差 ${x.deviation > 0 ? '+' : ''}${x.deviation.toFixed(2)}`)
    .join('\n');
  const negLines = d.topNeg
    .map((x) => `  ${x.anime.title}｜${fmtDims(x.anime, dims)}｜BGM ${x.anime.bangumiScore}｜偏差 ${x.deviation.toFixed(2)}`)
    .join('\n');
  const hiTagLine = d.topHiTags.map(([name, c]) => `${name}×${c}`).join('、');
  const loTagLine = d.topLoTags.map(([name, c]) => `${name}×${c}`).join('、');

  const dimCompare = dims
    .filter((x) => x.key !== 'overall')
    .map((x) => `  ${x.label}: 高偏差组 ${d.dimAvgHi[x.key] ?? 0} vs 低偏差组 ${d.dimAvgLo[x.key] ?? 0}`)
    .join('\n');

  const systemPrompt = `你是一个番剧口味分析师。任务：从"口味偏差"数据里提炼出这个人真实的偏好结构。

口味偏差 = (总评×0.4 + 电波×0.6) − BGM 评分。正偏差说明他比社区更喜欢，负偏差说明社区比他更喜欢。
分析要求：
- 结论必须落在具体证据上，禁止空泛（不要写"喜欢好剧情"这种谁都会说的话）
- 指出"他自己可能没意识到"的模式，比如某类气质、某个年代的作画、某位演出家的节奏
- hiddenGems 只能从上面列出的番剧里挑，不要编造`;

  const userPrompt = `=== 偏差概况 ===
正偏差 ${d.posCount} 部（平均 +${d.avgPosDev}），负偏差 ${d.negCount} 部（平均 ${d.avgNegDev}）
→ ${overallTrend(d)}

=== 强烈正偏差（个人 >> 社区）===
${posLines || '（无）'}

=== 强烈负偏差（社区 >> 个人）===
${negLines || '（无）'}

=== 标签共现 ===
高偏差番高频标签：${hiTagLine || '（无）'}
低偏差番高频标签：${loTagLine || '（无）'}

=== 两组维度均值对比 ===
${dimCompare}

=== 用户评语里的高频词 ===
${d.keywords.join('、') || '（无）'}

请提炼偏好画像。`;

  const { data } = await aiJSON<PreferenceProfile>({
    schema: PROFILE_SCHEMA,
    system: systemPrompt,
    user: userPrompt,
    purpose: 'profile',
    temperature: 0.5,
    maxTokens: 3500,
    signal: opts.signal,
    stream: opts.stream,
    rules: '用简体中文。likes 3-5 条，dislikes 2-3 条，confidence 是 0-1 的小数。',
  });
  return data;
}

// ── 深度模式 ──

/** 有限并发执行（深度模式逐番调用，串行会等太久） */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      if (signal?.aborted) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** 深度模式 Step 1：逐番调 LLM 分析 Bangumi 社区评论 */
async function deepStep1_PerAnime(
  reviewData: Record<string, { reviews?: string[] }>,
  deviationData: DeviationData,
  onProgress?: (current: number, total: number) => void,
  signal?: AbortSignal,
): Promise<AnimeReviewAnalysis[]> {
  const posTitles = deviationData.topPos.map((d) => d.anime.title).filter((t) => reviewData[t]?.reviews?.length);
  const negTitles = deviationData.topNeg.map((d) => d.anime.title).filter((t) => reviewData[t]?.reviews?.length);
  const allTitles = [...new Set([...posTitles, ...negTitles])].slice(0, 20);
  if (allTitles.length === 0) return [];

  let finished = 0;
  const reviewSystemPrompt = '你是番剧评论归纳器。从 Bangumi 社区评论里提炼社区的共同看法，用 2-6 字短语，不要长句、不要评价。';

  const results = await mapWithConcurrency(
    allTitles,
    3,
    async (title): Promise<AnimeReviewAnalysis> => {
      const data = reviewData[title];
      const reviewsText = (data?.reviews || []).join('\n').slice(0, 2000);
      const dev = deviationData.topPos.find((d) => d.anime.title === title)
        || deviationData.topNeg.find((d) => d.anime.title === title);
      const devLabel = dev ? `（用户口味偏差 ${dev.deviation > 0 ? '+' : ''}${dev.deviation.toFixed(2)}）` : '';

      try {
        const { data: parsed } = await aiJSON<{ strengths: string[]; weaknesses: string[] }>({
          schema: REVIEW_SCHEMA,
          system: reviewSystemPrompt,
          user: `「${title}」的 Bangumi 社区数据${devLabel}：\n\n${reviewsText}\n\n请提炼社区公认的优点和槽点。`,
          purpose: 'review',
          temperature: 0.3,
          maxTokens: 2000,
          signal,
          rules: 'strengths 3 条、weaknesses 2 条，每条 2-6 个字，不要编号。',
        });
        return { title, strengths: parsed.strengths, weaknesses: parsed.weaknesses };
      } catch (e) {
        if (e instanceof AIError && e.code === 'aborted') throw e;
        return { title, strengths: [], weaknesses: [] };
      } finally {
        finished += 1;
        onProgress?.(finished, allTitles.length);
      }
    },
    signal,
  );

  return results.filter((r): r is AnimeReviewAnalysis => Boolean(r));
}

/** 深度模式 Step 2：汇总所有番剧分析结果 */
async function deepStep2_Commonality(
  perAnimeResults: AnimeReviewAnalysis[],
  deviationData: DeviationData,
  opts: ProfileOptions,
): Promise<PreferenceProfile> {
  const posTitles = new Set(deviationData.topPos.map((d) => d.anime.title));
  const negTitles = new Set(deviationData.topNeg.map((d) => d.anime.title));

  const posStrengths = perAnimeResults.filter((r) => posTitles.has(r.title))
    .flatMap((r) => r.strengths.map((s) => `[${r.title}] ${s}`));
  const negWeaknesses = perAnimeResults.filter((r) => negTitles.has(r.title))
    .flatMap((r) => r.weaknesses.map((w) => `[${r.title}] ${w}`));

  const systemPrompt = `你是一个番剧口味分析师。多看少说：下面的优点/雷点来自社区评论的归纳，你要判断"这个人真正在意哪一个"，
结合口味偏差给出整体偏好模型。不要复述社区观点，要指出他的取舍。`;

  const userPrompt = `=== 偏差概况 ===
正偏差 ${deviationData.posCount} 部（平均 +${deviationData.avgPosDev}），负偏差 ${deviationData.negCount} 部（平均 ${deviationData.avgNegDev}）
→ ${overallTrend(deviationData)}

=== 他格外喜欢的作品，社区认可的优点 ===
${posStrengths.join('\n') || '（无数据）'}

=== 社区更喜欢、他不买账的作品，社区吐槽的点 ===
${negWeaknesses.join('\n') || '（无数据）'}

=== 他评语里的高频词 ===
${deviationData.keywords.join('、') || '（无）'}

请提炼偏好画像。`;

  const { data } = await aiJSON<PreferenceProfile>({
    schema: PROFILE_SCHEMA,
    system: systemPrompt,
    user: userPrompt,
    purpose: 'profile-deep',
    temperature: 0.5,
    maxTokens: 3500,
    signal: opts.signal,
    stream: opts.stream,
    rules: 'likes 3-5 条，dislikes 2-3 条，evidence 要指出具体作品或评论里反复出现的词。',
  });
  return data;
}

/** 深度模式偏好画像（完整流程：采集评论 → 逐番归纳 → 汇总） */
export async function preferenceProfileDeep(
  animeList: AnimeEntry[],
  onPhase?: (phase: 'collecting' | 'analyzing' | 'synthesizing') => void,
  onProgress?: (current: number, total: number) => void,
  opts: ProfileOptions = {},
): Promise<PreferenceProfile> {
  const d = buildDeviationData(animeList);
  if (d.samples.length < 5) {
    return emptyProfile('数据不足，需要至少 5 部有 BGM 评分 + 电波评分的番剧');
  }

  onPhase?.('collecting');
  const titles = [...new Set([...d.topPos, ...d.topNeg].map((x) => x.anime.title))];
  let reviewData: Record<string, { reviews?: string[] }> = {};

  try {
    const resp = await fetch('/api/bangumi/reviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ titles }),
      signal: opts.signal,
    });
    if (resp.ok) {
      const json = await resp.json();
      reviewData = json.results || {};
    }
  } catch (e) {
    if (opts.signal?.aborted) throw new AIError('aborted', '请求已取消');
    return await preferenceProfile(animeList, 'metadata', opts);
  }

  onPhase?.('analyzing');
  const perAnimeResults = await deepStep1_PerAnime(reviewData, d, onProgress, opts.signal);
  if (perAnimeResults.length === 0) {
    return await preferenceProfile(animeList, 'metadata', opts);
  }

  onPhase?.('synthesizing');
  return await deepStep2_Commonality(perAnimeResults, d, opts);
}
