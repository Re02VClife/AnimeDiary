/**
 * features/ai-analysis/graph-optimize — Skill 5: 标签图谱优化
 *
 * 先在本地算 Jaccard 找出"疑似重复"的标签对，再让模型判断该不该合并、合并到哪边。
 * 把计算交给 JS、把判断交给模型，比让模型自己数标签可靠得多。
 */

import type { AnimeEntry } from '../../src/types';
import { aiJSON } from './llm-service';
import { jaccardArrays } from '../../core/math';
import { getScore, getDimensionsForList } from './ai-helpers';
import type { GraphOptimizationResult } from './ai-types';
import { GRAPH_SCHEMA } from './ai-types';

export interface GraphOptimizeOptions {
  signal?: AbortSignal;
}

export async function graphOptimize(
  animeList: AnimeEntry[],
  opts: GraphOptimizeOptions = {},
): Promise<GraphOptimizationResult> {
  const tagAnimeMap: Record<string, AnimeEntry[]> = {};
  for (const a of animeList) {
    for (const t of a.tags) {
      if (!tagAnimeMap[t.name]) tagAnimeMap[t.name] = [];
      tagAnimeMap[t.name].push(a);
    }
  }

  const tagNames = Object.keys(tagAnimeMap).filter((name) => tagAnimeMap[name].length >= 2);

  // Jaccard 高的不同名标签 → 疑似重复
  const redundantPairs: { from: string; to: string; jaccard: number }[] = [];
  for (let i = 0; i < tagNames.length; i++) {
    for (let j = i + 1; j < tagNames.length; j++) {
      const idsA = new Set(tagAnimeMap[tagNames[i]].map((a) => a.id));
      const idsB = new Set(tagAnimeMap[tagNames[j]].map((a) => a.id));
      const jac = jaccardArrays([...idsA], [...idsB]);
      if (jac >= 0.4) {
        // 合并方向：用得多的那个留作主标签
        const aLen = idsA.size;
        const bLen = idsB.size;
        redundantPairs.push({
          from: aLen >= bLen ? tagNames[j] : tagNames[i],
          to: aLen >= bLen ? tagNames[i] : tagNames[j],
          jaccard: jac,
        });
      }
    }
  }
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

  const rareTags = Object.keys(tagAnimeMap).filter((name) => tagAnimeMap[name].length === 1).slice(0, 15);

  const dims = getDimensionsForList(animeList);
  const untaggedScored = animeList
    .filter((a) => a.tags.length === 0
      && a.scores.some((s) => s.score > 0)
      && dims.filter((d) => d.key !== 'overall').every((d) => getScore(a, d.key) > 0))
    .slice(0, 10);

  const pairLines = topPairs
    .map((p) => `  "${p.from}"(${tagAnimeMap[p.from]?.length || 0}部) ↔ "${p.to}"(${tagAnimeMap[p.to]?.length || 0}部) — 共现率 ${(p.jaccard * 100).toFixed(0)}%`)
    .join('\n');

  const rareLines = rareTags.map((name) => `  ${name}`).join('\n');

  const untaggedLines = untaggedScored
    .map((a) => {
      const dimText = dims.filter((d) => d.key !== 'overall')
        .map((d) => `${d.label}${getScore(a, d.key).toFixed(1)}`).join(' ');
      return `  ${a.title} | ${dimText}`;
    })
    .join('\n');

  const systemPrompt = `你是一个标签体系设计师。用户维护着一套番剧标签库，标签会越用越乱。请判断哪些该合并、哪些作品该补标签。
原则：
- 合并只在"含义确实相同"时提出（"机战"和"机甲"可以合并，"科幻"和"机甲"不行）
- 新标签要能复用，不要为单部作品定制
- from 必须是数据里真实存在的标签名，to 也必须是已有标签或一个明确的新名字`;

  const userPrompt = `标签总数 ${Object.keys(tagAnimeMap).length} 个，番剧 ${animeList.length} 部。

=== 疑似冗余（共现率 ≥ 40%）===
${pairLines || '无显著冗余对'}

=== 只用过一次的标签 ===
${rareLines || '无'}

=== 无标签但评分完整的作品 ===
${untaggedLines || '无'}

请给出优化建议。`;

  const { data } = await aiJSON<GraphOptimizationResult>({
    schema: GRAPH_SCHEMA,
    system: systemPrompt,
    user: userPrompt,
    purpose: 'graph',
    temperature: 0.35,
    maxTokens: 2500,
    signal: opts.signal,
    rules: 'merges 最多 5 条，newTags 最多 5 条，issues 最多 3 条。',
  });

  // 防御：模型编出来的标签名不该进建议
  const known = new Set(Object.keys(tagAnimeMap));
  return {
    merges: data.merges.filter((m) => known.has(m.from)),
    newTags: data.newTags.filter((t) => animeList.some((a) => a.title === t.anime)),
    issues: data.issues,
  };
}
