/**
 * features/ai-analysis/smart-recommend — Skill 3: 智能推荐
 *   四层降级发现：AniList → Bangumi v0 → Bangumi 搜索 → LLM 直接推荐
 */

import type { AnimeEntry } from '../../src/types';
import { DEFAULT_DIMENSIONS } from '../../src/types';
import { chat } from './llm-service';
import { extractJSON } from '../../core/text';
import { cosineSimilarity, jaccardArrays } from '../../core/math';
import { getScore, calcOverall, buildScoreVector } from './ai-helpers';
import { buildDeviationData } from './preference-profile';
import type { PreferenceProfile, RecommendResult, Recommendation, DiscoverItem } from './ai-types';

/**
 * 从 Bangumi 按偏好标签发现番剧
 * @param animeList 用户已有番剧（用于排除）
 * @param profile 偏好画像（可选）
 * @param onProgress 进度回调
 */
export async function smartRecommend(
  animeList: AnimeEntry[],
  profile?: PreferenceProfile | null,
  onProgress?: (phase: string) => void,
): Promise<RecommendResult> {
  // 1. 提取搜索标签：高偏差番标签 + 评价关键词 → LLM 提炼为搜索词
  const devData = buildDeviationData(animeList);

  // 从高偏差番提取标签（这是实际标签名，如"科幻""战争"）
  const hiTagNames = devData.topHiTags.map(([name]) => name);
  // 从评价提取关键词（如"泽野弘之""A-1"）
  const kwNames = devData.keywords;

  // 合并去重，过滤太泛的词
  const genericWords = new Set([
    '制作', '剧情', '画风', '音乐', '角色', '声优', '动画', '番剧',
    '作品', '动漫', '设定', '节奏', '演出', '氛围', '很好', '非常',
    '不错', '感觉', '觉得', '比较', '特别', '真的',
  ]);
  const rawTags = [...new Set([...hiTagNames, ...kwNames])]
    .filter((t) => !genericWords.has(t) && t.length >= 2);

  // 如果有偏好画像，用 LLM 从画像中提炼 3-5 个搜索关键词
  let llmSearchKeywords: string[] = [];
  if (profile && rawTags.length >= 3) {
    try {
      const kwSystemPrompt = `你是一个搜索关键词提取器。根据用户偏好画像和已知标签，输出最适合用来在动漫数据库中搜索新番的3-5个关键词。必须是具体的题材/风格/类型词（如：科幻、机甲、催泪、悬疑、日常），不要输出完整的句子。

必须只输出JSON：{"keywords":["关键词1","关键词2",...]}`;

      const kwUserPrompt = `用户偏好: ${profile.preferenceProfile}
喜欢: ${profile.likes.map((l) => l.aspect).join('; ')}
已知标签: ${rawTags.slice(0, 10).join('、')}

请输出搜索关键词。`;

      const kwRaw = await chat(kwSystemPrompt, kwUserPrompt, {
        maxTokens: 200,
        temperature: 0.2,
      });
      const kwParsed = JSON.parse(extractJSON(kwRaw)) as { keywords: string[] };
      llmSearchKeywords = (kwParsed.keywords || []).filter(
        (k: string) => k.length >= 2 && k.length <= 6,
      );
    } catch {
      // 提炼失败，降级使用原始标签
    }
  }

  // 最终搜索标签：LLM 提炼关键词优先，原始标签补充
  const searchTags = [
    ...new Set([...llmSearchKeywords, ...rawTags]),
  ].slice(0, 8);

  if (searchTags.length === 0) {
    // 兜底：用高偏差番的标签
    searchTags.push(...hiTagNames.slice(0, 5));
  }

  // 2. 三层降级发现：AniList → Bangumi v0 标签浏览 → Bangumi 搜索
  onProgress?.('正在搜索匹配番剧…');

  // 取已有番剧标题（优先高分番剧，取前 30 部）
  const excludeTitles = animeList
    .filter((a) => a.scores.some((s) => s.score > 0))
    .sort((a, b) => {
      const sa = getScore(a, 'overall') || calcOverall(a);
      const sb = getScore(b, 'overall') || calcOverall(b);
      return sb - sa;
    })
    .map((a) => a.title)
    .slice(0, 30);

  let discoverResults: DiscoverItem[] = [];
  let sourceLabel = '';

  // Tier 1: AniList GraphQL（海外可直连，搜索最精准）
  try {
    console.log('[推荐] 尝试 AniList 发现…');
    const resp = await fetch('/api/anilist/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: searchTags, excludeTitles }),
    });
    if (resp.ok) {
      const data = await resp.json();
      discoverResults = data.results || [];
      sourceLabel = 'AniList';
      console.log(`[推荐] AniList 返回 ${discoverResults.length} 部`);
    } else {
      console.log(`[推荐] AniList 端点返回 ${resp.status}`);
    }
  } catch (e) {
    console.log('[推荐] AniList 不可用:', e instanceof Error ? e.message : e);
  }

  // Tier 2: Bangumi v0 标签浏览（/v0/subjects?tag=xxx）
  if (discoverResults.length === 0) {
    onProgress?.('AniList 不可用，切换到 Bangumi 标签浏览…');
    try {
      console.log('[推荐] 尝试 Bangumi v0 标签浏览…');
      const resp = await fetch('/api/bangumi/browse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: searchTags }),
      });
      if (resp.ok) {
        const data = await resp.json();
        discoverResults = data.results || [];
        sourceLabel = 'Bangumi';
        console.log(`[推荐] Bangumi v0 返回 ${discoverResults.length} 部`);
      } else {
        console.log(`[推荐] Bangumi v0 端点返回 ${resp.status}`);
      }
    } catch (e) {
      console.log('[推荐] Bangumi v0 不可用:', e instanceof Error ? e.message : e);
    }
  }

  // Tier 3: Bangumi 标题搜索（搜标签关键词 → 能用的最后一招）
  if (discoverResults.length === 0) {
    onProgress?.('尝试 Bangumi 搜索…');
    try {
      console.log('[推荐] 尝试 Bangumi 搜索降级…');
      const resp = await fetch('/api/bangumi/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: searchTags }),
      });
      if (resp.ok) {
        const data = await resp.json();
        discoverResults = data.results || [];
        sourceLabel = 'Bangumi搜索';
        console.log(`[推荐] Bangumi 搜索返回 ${discoverResults.length} 部`);
      }
    } catch (e) {
      console.log('[推荐] Bangumi 搜索不可用:', e instanceof Error ? e.message : e);
    }
  }

  // Tier 4: LLM 直接推荐（利用 LLM 训练数据中的番剧知识）
  if (discoverResults.length === 0) {
    onProgress?.('AI 正在直接从知识库推荐…');
    console.log('[推荐] Tier 4: LLM 直接推荐模式启动');

    const profileText = profile
      ? `偏好画像: ${profile.preferenceProfile}\n喜欢: ${profile.likes.map((l) => l.aspect).join('; ')}\n雷区: ${profile.dislikes.map((d) => d.aspect).join('; ')}`
      : `高偏差番: ${devData.topPos.slice(0, 5).map((d) => d.anime.title).join('、')}\n标签: ${searchTags.join('、')}`;

    const knownTitles = animeList.map((a) => a.title).join('、');

    const directSystemPrompt = `你是番剧推荐大师。根据用户偏好推荐他没看过的番剧。

必须只输出 JSON，无任何前缀后缀：
{"recommendations":[{"title":"番剧名（中文通用译名）","year":"年份","reason":"为什么适合（结合偏好）","intro":"100字风格介绍（不剧透）","confidence":0.9}]}

选3-5部。title 用中文通用译名。超冷门番也可以。`;

    const directUserPrompt = `=== 用户品味 ===
${profileText}

=== 用户已看过（不要推荐这些）===
${knownTitles.slice(0, 1000)}

请推荐。`;

    try {
      console.log('[推荐] 调用 LLM 直接推荐…');
      const directRaw = await chat(directSystemPrompt, directUserPrompt, {
        maxTokens: 1500,
        temperature: 0.6,
      });
      console.log('[推荐] LLM 返回长度:', directRaw.length);

      const parsed = JSON.parse(extractJSON(directRaw)) as {
        recommendations: { title: string; year?: string; reason: string; intro: string; confidence: number }[];
      };
      console.log('[推荐] 解析到', parsed.recommendations?.length, '条推荐');

      if (parsed.recommendations?.length > 0) {
        discoverResults = parsed.recommendations.map((rec) => ({
          id: -(Math.random() * 10000) | 0,
          name: rec.title,
          name_cn: rec.title,
          summary: rec.intro || '',
          images: {},
          rating: { score: 0 },
          air_date: rec.year || '',
          eps: 0,
          matchedTag: 'AI推荐',
        }));
        sourceLabel = 'AI直接推荐';
        console.log('[推荐] LLM 直接推荐成功:', discoverResults.length, '部');
      } else {
        console.log('[推荐] LLM 返回空推荐列表');
      }
    } catch (e) {
      console.error('[推荐] LLM 直接推荐失败:', e instanceof Error ? e.message : e);
    }
  }

  // 3. 排除用户已有番剧（AI 直接推荐时跳过——LLM 已在 prompt 中知晓已看列表）
  const isDirectLLM = sourceLabel === 'AI直接推荐';
  const norm = (s: string) => (s || '').replace(/[\s\-_:：・().,，、　]+/g, '').toLowerCase();

  const externalCandidates = isDirectLLM
    ? discoverResults
    : (() => {
        const existingTitles = new Set(
          animeList.map((a) => [norm(a.title), norm(a.titleJa || ''), norm(a.searchAlias || '')]).flat(),
        );
        return discoverResults.filter((item) => {
          const cn = norm(item.name_cn || '');
          const en = norm((item as DiscoverItem & { name_en?: string }).name_en || '');
          const jp = norm(item.name || '');
          return (
            !existingTitles.has(cn) &&
            !existingTitles.has(en) &&
            !existingTitles.has(jp) &&
            cn.length >= 2
          );
        });
      })();

  if (externalCandidates.length < 3) {
    return {
      recommendations: externalCandidates.map((item) => ({
        title: item.name_cn || item.name,
        reason: `匹配标签「${item.matchedTag}」`,
        intro: item.summary?.slice(0, 120) || '暂无简介',
        bgmScore: item.rating?.score,
        posterUrl: item.images?.large || item.images?.common,
        airDate: item.air_date,
        matchedTags: [item.matchedTag],
        confidence: 0.5,
      })),
      candidateCount: externalCandidates.length,
      searchedTags: searchTags,
    };
  }

  // 4. 组装候选列表 → LLM 精选
  onProgress?.('AI 正在筛选最佳推荐…');

  const candidateLines = externalCandidates
    .map((item) => {
      const title = item.name_cn || item.name;
      const score = item.rating?.score ? `评分${item.rating.score}` : '';
      const date = item.air_date ? `(${item.air_date})` : '';
      const genres = item.genres?.length
        ? `类型: ${item.genres.slice(0, 5).join('/')}`
        : '';
      const summary = (item.summary || '').replace(/<[^>]+>/g, '').slice(0, 200);
      return `- ${title} ${date} ${score} ${genres} | 搜索: ${item.matchedTag}\n  简介: ${summary}`;
    })
    .join('\n\n');

  const profileText = profile
    ? `偏好画像: ${profile.preferenceProfile}\n喜欢: ${profile.likes.map((l) => l.aspect).join('、')}\n雷区: ${profile.dislikes.map((d) => d.aspect).join('、')}`
    : `高偏差番高频标签: ${hiTagNames.join('、')}\n用户评价关键词: ${kwNames.join('、')}`;

  const systemPrompt = `你是一个番剧推荐师。根据用户的品味偏好，从 Bangumi 发现的候选番剧中精选推荐。

核心原则：
- 绝不剧透剧情走向、关键转折或结局
- 简介只描述番剧的类型、风格、氛围和看点，不提及具体情节
- 推荐理由要结合用户偏好，说清楚"为什么这部适合你"

必须只输出一个 JSON 对象：
{"recommendations":[{"title":"番剧名","reason":"为什么适合你（结合偏好，不剧透）","intro":"100字以内的风格介绍（不剧透）","confidence":0.9}]}

选3-5部，confidence 0-1。用中文。`;

  const userPrompt = `=== 用户品味特征 ===
${profileText}

搜索标签: ${searchTags.join('、')}

=== Bangumi 候选番剧（共${externalCandidates.length}部）===
${candidateLines}

请精选推荐。`;

  onProgress?.('AI 正在生成推荐理由…');

  const raw = await chat(systemPrompt, userPrompt, {
    maxTokens: 1500,
    temperature: 0.4,
  });

  const llmResult = JSON.parse(extractJSON(raw)) as {
    recommendations: { title: string; reason: string; intro: string; confidence: number }[];
  };

  // 5. 合并 LLM 推荐与 AniList 元数据（封面、评分、类型、年份）
  const merged: Recommendation[] = llmResult.recommendations.map((rec) => {
    const normTitle = norm(rec.title);
    const match = externalCandidates.find(
      (item) =>
        norm(item.name_cn || '').includes(normTitle) ||
        norm(item.name || '').includes(normTitle) ||
        normTitle.includes(norm(item.name_cn || '')) ||
        normTitle.includes(norm(item.name || '')),
    );
    // 收集匹配标签：搜索命中标签 + AniList genres + 前几个 AniList tags
    const matchedTags = [
      ...new Set([
        ...(match?.matchedTag ? [match.matchedTag] : []),
        ...(match?.genres?.slice(0, 3) || []),
        ...(match?.tags?.slice(0, 3) || []),
      ]),
    ];
    return {
      title: rec.title,
      reason: rec.reason,
      intro: rec.intro || match?.summary?.replace(/<[^>]+>/g, '').slice(0, 120) || '',
      bgmScore: match?.rating?.score,
      posterUrl: match?.images?.large || match?.images?.common || '',
      airDate: match?.air_date || '',
      matchedTags,
      confidence: rec.confidence,
    };
  });

  return {
    recommendations: merged,
    candidateCount: externalCandidates.length,
    searchedTags: searchTags,
    sourceLabel,
  };
}
