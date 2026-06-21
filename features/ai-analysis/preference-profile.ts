/**
 * features/ai-analysis/preference-profile — Skill 2: 偏好画像 + 深度模式
 */

import type { AnimeEntry } from '../../src/types';
import { DEFAULT_DIMENSIONS } from '../../src/types';
import { buildPercentileMap, getPercentileScores } from '../ranking/ranking-service';
import { chat } from './llm-service';
import { extractJSON, extractKeywords } from '../../core/text';
import { getScore, calcOverall, calcTasteDeviation, fmtDims } from './ai-helpers';
import type { DeviationData, PreferenceProfile, ProfileMode, AnimeReviewAnalysis } from './ai-types';
import { PROFILE_SCHEMA } from './ai-types';

// ── 数据准备 ──

/** 计算口味偏差相关数据 */
export function buildDeviationData(animeList: AnimeEntry[]): DeviationData {
  const withDev = animeList
    .map((a) => ({ anime: a, deviation: calcTasteDeviation(a) }))
    .filter((d): d is { anime: AnimeEntry; deviation: number } => d.deviation !== null);

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
  const vibeBottom = byVibe.filter((a) => getScore(a, 'vibe') > 0).slice(-10).reverse();

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

  const hiReviews = topPos
    .map((d) => d.anime.review || '')
    .filter((r) => r.length > 0);
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

// ── Skill 2: 偏好画像（元数据模式）──

export async function preferenceProfile(
  animeList: AnimeEntry[],
  _mode: ProfileMode = 'metadata',
): Promise<PreferenceProfile> {
  const d = buildDeviationData(animeList);

  if (d.samples.length < 5) {
    return {
      likes: [], dislikes: [],
      preferenceProfile: '数据不足，需要至少 5 部有 BGM 评分 + 电波评分的番剧才能生成偏好画像',
      tasteDeviation: '', hiddenGems: [],
    };
  }

  const overallTrend =
    d.avgPosDev > 0.8
      ? '用户总体比 BGM 社区评分更挑剔，对某些特定类型的番有强烈个人偏好'
      : d.avgNegDev < -0.8
        ? '用户总体比 BGM 社区评分更宽容，容易被打动'
        : '用户口味与社区基本一致，偏差不大';

  const posLines = d.topPos
    .map((x) => {
      const dev = x.deviation > 0 ? `+${x.deviation.toFixed(2)}` : x.deviation.toFixed(2);
      return `  ${x.anime.title} | ${fmtDims(x.anime)} | BGM ${x.anime.bangumiScore} | 偏差 ${dev}`;
    })
    .join('\n');

  const negLines = d.topNeg
    .map((x) => {
      const dev = x.deviation > 0 ? `+${x.deviation.toFixed(2)}` : x.deviation.toFixed(2);
      return `  ${x.anime.title} | ${fmtDims(x.anime)} | BGM ${x.anime.bangumiScore} | 偏差 ${dev}`;
    })
    .join('\n');

  const hiTagLine = d.topHiTags.map(([name, c]) => `${name}×${c}`).join(' ');
  const loTagLine = d.topLoTags.map(([name, c]) => `${name}×${c}`).join(' ');

  const dimCompare = DEFAULT_DIMENSIONS
    .filter((x) => x.key !== 'overall')
    .map((x) => `  ${x.label}: 高偏差组${d.dimAvgHi[x.key]} vs 低偏差组${d.dimAvgLo[x.key]}`)
    .join('\n');

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

// ── 深度模式 ──

/** 深度模式 Step 1：逐番调 LLM 分析 Bangumi 社区评论 */
async function deepStep1_PerAnime(
  reviewData: Record<string, { reviews: string[] }>,
  deviationData: DeviationData,
  onProgress?: (current: number, total: number) => void,
): Promise<AnimeReviewAnalysis[]> {
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
      results.push({ title, strengths: [], weaknesses: [] });
    }

    onProgress?.(i + 1, total);

    if (i < allTitles.length - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return results;
}

/** 深度模式 Step 2：汇总所有番剧分析结果 */
async function deepStep2_Commonality(
  perAnimeResults: AnimeReviewAnalysis[],
  deviationData: DeviationData,
): Promise<PreferenceProfile> {
  const posTitles = new Set(deviationData.topPos.map((d) => d.anime.title));
  const negTitles = new Set(deviationData.topNeg.map((d) => d.anime.title));

  const posResults = perAnimeResults.filter((r) => posTitles.has(r.title));
  const negResults = perAnimeResults.filter((r) => negTitles.has(r.title));

  const posStrengths = posResults.flatMap((r) =>
    r.strengths.map((s) => `[${r.title}] ${s}`),
  );
  const negWeaknesses = negResults.flatMap((r) =>
    r.weaknesses.map((w) => `[${r.title}] ${w}`),
  );

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

/** 深度模式偏好画像（完整流程） */
export async function preferenceProfileDeep(
  animeList: AnimeEntry[],
  onPhase?: (phase: 'collecting' | 'analyzing' | 'synthesizing') => void,
  onProgress?: (current: number, total: number) => void,
): Promise<PreferenceProfile> {
  const d = buildDeviationData(animeList);

  if (d.samples.length < 5) {
    return {
      likes: [], dislikes: [],
      preferenceProfile: '数据不足，需要至少 5 部有 BGM 评分 + 电波评分的番剧',
      tasteDeviation: '', hiddenGems: [],
    };
  }

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
    return await preferenceProfile(animeList, 'metadata');
  }

  onPhase?.('analyzing');
  const perAnimeResults = await deepStep1_PerAnime(reviewData, d, onProgress);

  if (perAnimeResults.length === 0) {
    return await preferenceProfile(animeList, 'metadata');
  }

  onPhase?.('synthesizing');
  return await deepStep2_Commonality(perAnimeResults, d);
}
