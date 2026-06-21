/**
 * features/ai-analysis/graph-optimize — Skill 5: 标签图谱优化
 */

import type { AnimeEntry } from '../../src/types';
import { DEFAULT_DIMENSIONS } from '../../src/types';
import { chat } from './llm-service';
import { extractJSON } from '../../core/text';
import { jaccardArrays } from '../../core/math';
import { getScore } from './ai-helpers';
import type { GraphOptimizationResult } from './ai-types';

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
