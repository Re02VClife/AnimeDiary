/**
 * features/ai-analysis/auto-tag — Skill 6: 智能打 Tag
 */

import type { AnimeEntry } from '../../src/types';
import { DEFAULT_DIMENSIONS } from '../../src/types';
import { chat } from './llm-service';
import { extractJSON } from '../../core/text';
import { getScore } from './ai-helpers';
import type { AutoTagResult } from './ai-types';

/** 调用 Bangumi 获取番剧标签，让 LLM 筛选建议标签 */
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
