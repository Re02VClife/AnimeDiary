/**
 * features/ai-analysis/taste-analysis — Skill 1: 品味分析
 */

import type { AnimeEntry, Dimension } from '../../src/types';
import { DEFAULT_DIMENSIONS } from '../../src/types';
import { buildPercentileMap, getPercentileScores } from '../ranking/ranking-service';
import { chat } from './llm-service';
import { extractJSON } from '../../core/text';
import { getScore, calcOverall } from './ai-helpers';
import type { TasteStats, TasteReport } from './ai-types';
import { TASTE_SCHEMA } from './ai-types';

/** 计算全体番剧的数据统计（独立导出，供 UI 展示中间过程） */
export function buildTasteStats(animeList: AnimeEntry[], dimensions?: Dimension[]): TasteStats {
  const stats = buildPercentileMap(animeList);
  const scored = animeList.filter((a) => a.scores.some((s) => s.score > 0));
  const dims = dimensions || DEFAULT_DIMENSIONS;

  // 各维度平均百分位
  const dimAvg: Record<string, number> = {};
  for (const dim of dims) {
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
  for (const dim of dims) {
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
