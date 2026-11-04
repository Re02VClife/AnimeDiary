/**
 * features/ai-analysis/auto-tag — Skill 6: 智能打 Tag
 *
 * 先用 Bangumi 的社区标签当"事实底座"，再让模型挑出这个人自己的标签体系里缺的那几个。
 */

import type { AnimeEntry } from '../../src/types';
import { aiJSON } from './llm-service';
import { getActiveDimensions } from '../anime-data/template-service';
import { getScore } from './ai-helpers';
import { normalizeTagName } from '../../core/tag-name';
import type { AutoTagResult } from './ai-types';
import { AUTO_TAG_SCHEMA } from './ai-types';
import type { AIRun } from './ai-runtime';

export interface AutoTagOptions {
  signal?: AbortSignal;
  /** 用量/流式收集器；不传落到默认实例 */
  run?: AIRun;
  /**
   * 用户已有的标签库（按使用频率排序）。
   *
   * 为什么必须传：不传的话每次调用都只看得到"这一部番自己的标签"，
   * 模型会为同一个概念各写各的 —— 批量打了 189 部之后库里同时出现了
   * `漫改`/`漫改画`、`轻小说改`/`轻改`、`群像`/`群像剧` 三组近义词，
   * 还出现了 `科幻` 和 `科幻 `（尾空格）这种肉眼看不出来的重复。
   * 把词库喂进去并要求"优先复用"，从源头减少分化。
   */
  vocabulary?: string[];
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
禁止提出已有标签的近义词。
**如果能用「我的标签库」里已有的词，就必须用原词**，不要造新说法（不要说"漫改画"，用户库里叫"漫改"）。`;

  const vocabulary = (opts.vocabulary || []).filter(Boolean);
  const vocabText = vocabulary.length > 0
    ? vocabulary.slice(0, 120).join('、')
    : '（暂无）';

  const userPrompt = `=== 作品 ===
${anime.title}${anime.studio ? `｜${anime.studio}` : ''}${anime.releaseDate ? `｜${anime.releaseDate}` : ''}

=== 我的评分 ===
${dimText || '（未评分）'}

=== 我给它打的标签 ===
${existingTags.length > 0 ? existingTags.join('、') : '（空）'}

=== 我的标签库（跨全部番剧，按使用频率排序；能复用就复用）===
${vocabText}

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
    run: opts.run,
    rules: '每个标签 2-4 个汉字，理由一句话。不要输出与已有标签重复的项。',
  });

  // 模型偶尔还是会吐已有标签，这里兜一层；同时把名字归一化，
  // 免得 `科幻 ` / `３D动画` 这类变体真的写进 Excel
  const existingNorm = new Set(existingTags.map(normalizeTagName));
  const seen = new Set<string>();
  const suggestedTags = (data.suggestedTags || [])
    .map((t) => ({ name: normalizeTagName(t?.name || ''), reason: (t?.reason || '').trim() }))
    .filter((t) => {
      if (!t.name || existingNorm.has(t.name) || seen.has(t.name)) return false;
      seen.add(t.name);
      return true;
    })
    .slice(0, 6);

  return { suggestedTags };
}
