/**
 * features/ai-analysis/auto-tag — Skill 6: 智能打 Tag
 *
 * 先用 Bangumi 的社区标签当"事实底座"，再让模型挑出这个人自己的标签体系里缺的那几个。
 */

import type { AnimeEntry } from '../../src/types';
import { aiJSON } from './llm-service';
import { getActiveDimensions } from '../anime-data/template-service';
import { getScore } from './ai-helpers';
import type { AutoTagResult } from './ai-types';
import { AUTO_TAG_SCHEMA } from './ai-types';

export interface AutoTagOptions {
  signal?: AbortSignal;
}

/** 调用 Bangumi 获取番剧标签，让 LLM 筛选建议标签 */
export async function autoTag(anime: AnimeEntry, opts: AutoTagOptions = {}): Promise<AutoTagResult> {
  let bangumiTags: string[] = [];
  let bangumiSummary = '';
  try {
    const resp = await fetch(
      `/api/bangumi/search?keyword=${encodeURIComponent(anime.title)}`,
      { signal: opts.signal },
    );
    if (resp.ok) {
      const data = await resp.json();
      const item = (data?.list || [])[0];
      if (item) {
        bangumiSummary = item.summary || '';
        bangumiTags = (item.tags || []).map((t: { name: string }) => t.name).filter(Boolean);
      }
    }
  } catch {
    if (opts.signal?.aborted) throw new Error('请求已取消');
    // Bangumi 不可用时降级为纯本地判断
  }

  const dims = getActiveDimensions(anime);
  const dimText = dims
    .filter((d) => d.key !== 'overall')
    .map((d) => `${d.label}${getScore(anime, d.key).toFixed(1)}`)
    .join(' ');

  const existingTags = anime.tags.map((t) => t.name);

  const systemPrompt = `你是一个番剧标签体系专家。你的任务不是描述这部作品，而是判断"在这位用户自己的标签体系里，还缺哪几个标签"。
好的标签是能拿来筛选/检索的（题材、气质、制作特征），不是评价（"神作""烂尾"）。
禁止提出已有标签的近义词。`;

  const userPrompt = `=== 作品 ===
${anime.title}${anime.studio ? `｜${anime.studio}` : ''}${anime.releaseDate ? `｜${anime.releaseDate}` : ''}

=== 我的评分 ===
${dimText || '（未评分）'}

=== 我给它打的标签 ===
${existingTags.length > 0 ? existingTags.join('、') : '（空）'}

=== Bangumi 社区标签 ===
${bangumiTags.length > 0 ? bangumiTags.slice(0, 30).join('、') : '（无数据）'}

=== Bangumi 简介 ===
${bangumiSummary ? bangumiSummary.slice(0, 400) : '（无）'}

请建议 3-5 个我该补的标签。`;

  const { data } = await aiJSON<AutoTagResult>({
    schema: AUTO_TAG_SCHEMA,
    system: systemPrompt,
    user: userPrompt,
    purpose: 'auto-tag',
    temperature: 0.3,
    maxTokens: 2000,
    signal: opts.signal,
    rules: '每个标签 2-4 个汉字，理由一句话。不要输出与已有标签重复的项。',
  });

  // 模型偶尔还是会吐已有标签，这里兜一层
  const existing = new Set(existingTags.map((t) => t.trim()));
  const suggestedTags = data.suggestedTags
    .filter((t) => t?.name && !existing.has(t.name.trim()))
    .slice(0, 6);

  return { suggestedTags };
}
