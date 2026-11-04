/**
 * features/ai-analysis/taste-analysis — Skill 1: 品味分析
 *
 * 纯统计数据在前端算好（用户可以立刻看到），只把"数据摘要"交给模型写报告。
 * 这样既省 token，也不会让模型去编造数字。
 */

import type { AnimeEntry, Dimension } from '../../src/types';
import { buildPercentileMap, getPercentileScores } from '../ranking/ranking-service';
import { aiJSON } from './llm-service';
import { getScore, calcOverall, getDimensionsForList } from './ai-helpers';
import type { TasteStats, TasteReport } from './ai-types';
import { TASTE_SCHEMA } from './ai-types';

/** 计算全体番剧的数据统计（独立导出，供 UI 展示中间过程） */
export function buildTasteStats(animeList: AnimeEntry[], dimensions?: Dimension[]): TasteStats {
  const stats = buildPercentileMap(animeList);
  const scored = animeList.filter((a) => a.scores.some((s) => s.score > 0));
  const dims = dimensions || getDimensionsForList(animeList);

  // 各维度平均百分位
  const dimAvg: Record<string, number> = {};
  for (const dim of dims) {
    if (dim.key === 'overall') continue;
    const vals: number[] = [];
    for (const a of scored) {
      const pct = getPercentileScores(a, stats, dims).find((p) => p.dimensionKey === dim.key);
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
    const rawScores = scored.map((a) => getScore(a, dim.key)).filter((s) => s > 0);
    if (rawScores.length < 2) continue;
    const mean = rawScores.reduce((a, b) => a + b, 0) / rawScores.length;
    const variance = rawScores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / rawScores.length;
    dimStdDev.push({ key: dim.key, label: dim.label, std: Math.sqrt(variance) });
  }
  dimStdDev.sort((a, b) => b.std - a.std);

  // 标签统计（按使用次数降序，取 top 15）
  const tagCounts: Record<string, { count: number; totalScore: number; scoreCount: number }> = {};
  for (const a of animeList) {
    const overall = getScore(a, 'overall') || calcOverall(a, dims);
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
      avgScore: v.scoreCount > 0 ? +(v.totalScore / v.scoreCount).toFixed(1) : null,
    }));

  // 月度追番密度（基于 createdAt）
  const monthCounts: Record<string, number> = {};
  for (const a of animeList) {
    const m = a.createdAt?.slice(0, 7); // "YYYY-MM"
    if (m && /^\d{4}-\d{2}$/.test(m)) monthCounts[m] = (monthCounts[m] || 0) + 1;
  }
  const topMonths = Object.entries(monthCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);

  return {
    animeCount: animeList.length,
    scoredCount: scored.length,
    dimAvg,
    dimStdDev,
    topTags,
    topMonths,
  };
}

export interface TasteAnalysisOptions {
  signal?: AbortSignal;
  /** 把模型思考过程流式喂给 UI */
  stream?: boolean;
}

export async function tasteAnalysis(
  animeList: AnimeEntry[],
  opts: TasteAnalysisOptions = {},
): Promise<TasteReport> {
  const dims = getDimensionsForList(animeList);
  const stats = buildTasteStats(animeList, dims);
  const { dimAvg, dimStdDev, topTags, topMonths, scoredCount } = stats;

  const dimLines = dims
    .filter((d) => d.key !== 'overall')
    .map((d) => `  ${d.label}: 平均百分位 ${dimAvg[d.key] ?? 0}%`)
    .join('\n');

  const tagLines = topTags
    .map((t) => `  ${t.name}：${t.count} 部${t.avgScore !== null ? `，均分 ${t.avgScore}` : ''}`)
    .join('\n');

  const monthLines = topMonths.map(([m, c]) => `  ${m}: ${c} 部`).join('\n');

  const stdLines = dimStdDev
    .slice(0, 3)
    .map((d) => `  ${d.label}: σ=${d.std.toFixed(2)}`)
    .join('\n');

  // 评分两端各取 5 部，给模型"具体到番剧"的抓手
  const scored = animeList.filter((a) => a.scores.some((s) => s.score > 0));
  const byOverall = [...scored].sort((a, b) => calcOverall(b, dims) - calcOverall(a, dims));
  const topLine = byOverall.slice(0, 5).map((a) => `${a.title} ${calcOverall(a, dims).toFixed(1)}`).join('、');
  const bottomLine = byOverall.slice(-5).map((a) => `${a.title} ${calcOverall(a, dims).toFixed(1)}`).join('、');
  const yearLine = (() => {
    const years: Record<string, number> = {};
    for (const a of scored) {
      const y = a.releaseDate?.slice(0, 4);
      if (y) years[y] = (years[y] || 0) + 1;
    }
    return Object.entries(years).sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([y, c]) => `${y}年 ${c}部`).join('、');
  })();

  const systemPrompt = `你是一个番剧品味分析师，擅长从评分数据里读出一个人自己都没说出口的偏好。
写作风格：冷静、具体、有洞察，像一位熟悉他的朋友在做总结；不要用"总的来说""可以看出"这类空话，不要编造数据里没有的番剧或数字。`;

  const userPrompt = `以下是用户的评分数据统计。

=== 规模 ===
共 ${animeList.length} 部，其中 ${scoredCount} 部有评分。

=== 各维度平均百分位（100% = 在该维度上高于所有番剧）===
${dimLines || '（无数据）'}

=== 高分段 vs 低分段 ===
最高：${topLine || '无'}
最低：${bottomLine || '无'}

=== 评分最集中的标签 ===
${tagLines || '（无标签）'}

=== 追番密度最高的月份 ===
${monthLines || '（无日期数据）'}

=== 评分波动最大的维度（越大说明这类维度上你越挑剔/越两极）===
${stdLines || '（数据不足）'}

=== 年代分布 ===
${yearLine || '（无数据）'}

请写一份品味报告：summary 概括这个人的口味本质；highlights 挑 3-5 条最值得说的数据洞察（必须引用上面的具体数字或番剧名）；notes 补 2-3 条别人容易忽略的细节。`;

  const { data } = await aiJSON<TasteReport>({
    schema: TASTE_SCHEMA,
    system: systemPrompt,
    user: userPrompt,
    purpose: 'taste',
    temperature: 0.5,
    maxTokens: 3000,
    signal: opts.signal,
    stream: opts.stream,
    rules: '用简体中文。highlights 和 notes 每条独立成句，不要用编号或前缀。',
  });

  return data;
}
