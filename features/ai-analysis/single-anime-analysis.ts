/**
 * features/ai-analysis/single-anime-analysis — Skill 4: 单番深度分析
 */

import type { AnimeEntry } from '../../src/types';
import { DEFAULT_DIMENSIONS } from '../../src/types';
import { buildPercentileMap, getPercentileScores } from '../ranking/ranking-service';
import { chat } from './llm-service';
import { extractJSON } from '../../core/text';
import { cosineSimilarity } from '../../core/math';
import { getScore, calcOverall, calcTasteDeviation, fmtDims, buildScoreVector } from './ai-helpers';
import type { SingleAnimeAnalysisResult } from './ai-types';

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
