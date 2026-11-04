/**
 * features/ai-analysis/single-anime-analysis — Skill 4: 单番深度分析
 *
 * 回答的是"这部番对我意味着什么"：为什么电波高/低、和社区差在哪、
 * 跟哪些番在评分结构上同构。
 */

import type { AnimeEntry } from '../../src/types';
import { getActiveDimensions } from '../anime-data/template-service';
import { buildPercentileMap, getPercentileScores } from '../ranking/ranking-service';
import { aiJSON } from './llm-service';
import { cosineSimilarity } from '../../core/math';
import { getScore, calcOverall, calcTasteDeviation, fmtDims, buildScoreVector } from './ai-helpers';
import type { SingleAnimeAnalysisResult } from './ai-types';
import { SINGLE_ANIME_SCHEMA } from './ai-types';
import type { AIRun } from './ai-runtime';

export interface SingleAnimeOptions {
  signal?: AbortSignal;
  stream?: boolean;
  /** 用量/流式收集器；不传落到默认实例 */
  run?: AIRun;
}

/**
 * 对单部番剧做深度分析——为什么电波高/低，口味偏差的原因
 * @param anime 目标番剧
 * @param allAnime 全部番剧列表（用于百分位和相似度计算）
 */
export async function singleAnimeAnalysis(
  anime: AnimeEntry,
  allAnime: AnimeEntry[],
  opts: SingleAnimeOptions = {},
): Promise<SingleAnimeAnalysisResult> {
  const templateDims = getActiveDimensions(anime);
  const stats = buildPercentileMap(allAnime);
  const pcts = getPercentileScores(anime, stats, templateDims);

  const dimLines = templateDims
    .filter((d) => d.key !== 'overall')
    .map((d) => {
      const s = getScore(anime, d.key);
      const p = pcts.find((pct) => pct.dimensionKey === d.key);
      return `  ${d.label}: ${s.toFixed(d.key === 'vibe' ? 2 : 1)}${p ? `（同类中排前 ${100 - p.percentile}%）` : ''}`;
    })
    .join('\n');

  const overall = getScore(anime, 'overall') || calcOverall(anime, templateDims);
  const vibe = getScore(anime, 'vibe');
  const deviation = calcTasteDeviation(anime);
  const devText = deviation !== null
    ? (deviation > 0
      ? `+${deviation.toFixed(2)}（你比社区更喜欢它）`
      : `${deviation.toFixed(2)}（社区比你更喜欢它）`)
    : '无 BGM 数据';

  const sims = allAnime
    .filter((a) => a.id !== anime.id && a.scores.some((s) => s.score > 0))
    .map((a) => ({ anime: a, sim: cosineSimilarity(buildScoreVector(anime, templateDims), buildScoreVector(a, templateDims)) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, 3);

  const simLines = sims
    .map((x) => `  ${x.anime.title}（评分结构相似度 ${(x.sim * 100).toFixed(0)}%，你的总评 ${calcOverall(x.anime, templateDims).toFixed(1)}）`)
    .join('\n');

  const review = (anime.review || '').trim();
  const notes = (anime.notes || '').trim();
  const dimReviews = (anime.dimensionReviews || [])
    .filter((r) => r.content?.trim())
    .map((r) => `  ${templateDims.find((d) => d.key === r.dimensionKey)?.label || r.dimensionKey}：${r.content}`)
    .join('\n');

  const systemPrompt = `你是一个懂番也懂人的分析者。给一部作品写"它为什么对这个人重要"的剖析。
要求：
- 结论必须能追溯到分数、评语或标签，不要泛泛而谈
- 允许说出"可能你自己都没意识到"的东西，但要给出证据
- 不剧透具体情节，只谈气质、结构、节奏、演出`;

  const userPrompt = `=== 作品 ===
${anime.title}${anime.titleJa ? `（${anime.titleJa}）` : ''}${anime.releaseDate ? `｜${anime.releaseDate}` : ''}${anime.studio ? `｜${anime.studio}` : ''}

=== 你的评分 ===
总评 ${overall.toFixed(2)}${vibe > 0 ? `，电波 ${vibe.toFixed(2)}` : ''}
${dimLines}

=== 与社区的关系 ===
BGM ${anime.bangumiScore ?? '无'}，口味偏差 ${devText}

=== 标签 ===
${anime.tags.map((t) => t.name).join('、') || '（无）'}

=== 你写的评语 ===
${review ? `"${review.slice(0, 600)}"` : '（没写）'}
${notes ? `备注：${notes.slice(0, 300)}` : ''}
${dimReviews ? `\n=== 维度专项评语 ===\n${dimReviews}` : ''}

=== 评分结构最接近的作品 ===
${simLines || '（数据不足）'}

请分析：打动你的核心是什么（coreAppeal）、这属于你哪一类电波（vibePattern）、和社区的差距从哪来（communityGap）、还有什么类似的作品（similarAnime）。`;

  const { data } = await aiJSON<SingleAnimeAnalysisResult>({
    schema: SINGLE_ANIME_SCHEMA,
    system: systemPrompt,
    user: userPrompt,
    purpose: 'single',
    temperature: 0.55,
    maxTokens: 3000,
    signal: opts.signal,
    stream: opts.stream,
    run: opts.run,
    rules: `用简体中文。若没有 BGM 数据，communityGap 直接写"无社区对比数据"。similarAnime 只在确实相似时给，宁缺毋滥。`,
  });

  return data;
}
