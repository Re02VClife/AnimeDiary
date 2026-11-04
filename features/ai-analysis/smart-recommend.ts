/**
 * features/ai-analysis/smart-recommend — Skill 3: 智能推荐
 *
 * 流程：口味偏移 → 搜索标签 → 外部发现（AniList / Bangumi）→ 本地粗排 → 模型精选 → 元数据回填
 *
 * 几个刻意的设计：
 *   - 粗排放在本地：把 200 个候选压到 24 个再给模型，省钱且更准；
 *   - LLM 只允许从候选里选（Tier 4 纯知识推荐除外），选不中的会被标记 verified=false；
 *   - Tier 4 的纯模型推荐会回查 Bangumi 补封面/评分，避免"只给个名字"的幻觉感。
 */

import type { AnimeEntry } from '../../src/types';
import { aiJSON } from './llm-service';
import type { JSONSchema } from '../../core/ai-json';
import type { AIRun } from './ai-runtime';
import { getScore, calcOverall, getDimensionsForList } from './ai-helpers';
import { buildDeviationData } from './preference-profile';
import type { PreferenceProfile, RecommendResult, Recommendation, DiscoverItem } from './ai-types';
import { RECOMMEND_SCHEMA } from './ai-types';

const KEYWORD_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    keywords: {
      type: 'array',
      items: { type: 'string' },
      description: '3-5 个用于在动漫数据库检索的具体题材/风格词（2-6 个汉字）',
    },
  },
  required: ['keywords'],
  additionalProperties: false,
};

const norm = (s: string) => (s || '').replace(/[\s\-_:：・().,，、　]+/g, '').toLowerCase();

/** 给外部发现请求加硬超时：Bangumi/AniList 慢起来能把整个面板卡五分钟 */
function withDeadline(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  if (!signal) return timeout;
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === 'function') return anyFn.call(AbortSignal, [signal, timeout]);

  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  timeout.addEventListener('abort', abort, { once: true });
  return controller.signal;
}

const DISCOVER_TIMEOUT_MS = 15000;
const LOOKUP_TIMEOUT_MS = 8000;

export interface RecommendOptions {
  signal?: AbortSignal;
  stream?: boolean;
  /** 用量/流式收集器；不传落到默认实例 */
  run?: AIRun;
}

/** 从 Bangumi 回查单个标题，补齐封面/评分/日期（超时 8 秒，失败返回 null） */
async function lookupTitle(title: string, signal?: AbortSignal): Promise<DiscoverItem | null> {
  try {
    const resp = await fetch(`/api/bangumi/search?keyword=${encodeURIComponent(title)}`, {
      signal: withDeadline(signal, LOOKUP_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data?.offline) return null; // 服务端已声明 Bangumi 不可达，别再等
    const item = (data?.list || [])[0];
    if (!item) return null;
    return {
      id: Number(item.id) || 0,
      name: item.name || title,
      name_cn: item.name_cn || item.name || title,
      summary: item.summary || '',
      images: item.images || {},
      rating: item.rating || {},
      air_date: item.air_date || '',
      eps: item.eps || 0,
      matchedTag: 'AI推荐回查',
    };
  } catch {
    return null;
  }
}

/**
 * 从外部发现番剧
 * @param animeList 用户已有番剧（用于排除）
 * @param profile 偏好画像（可选）
 * @param onProgress 进度回调
 */
export async function smartRecommend(
  animeList: AnimeEntry[],
  profile?: PreferenceProfile | null,
  onProgress?: (phase: string) => void,
  opts: RecommendOptions = {},
): Promise<RecommendResult> {
  const dims = getDimensionsForList(animeList);
  const devData = buildDeviationData(animeList);

  const hiTagNames = devData.topHiTags.map(([name]) => name);
  const kwNames = devData.keywords;

  const genericWords = new Set([
    '制作', '剧情', '画风', '音乐', '角色', '声优', '动画', '番剧',
    '作品', '动漫', '设定', '节奏', '演出', '氛围', '很好', '非常',
    '不错', '感觉', '觉得', '比较', '特别', '真的',
  ]);
  const rawTags = [...new Set([...hiTagNames, ...kwNames])]
    .filter((t) => !genericWords.has(t) && t.length >= 2);

  // 有画像时让模型把画像压成检索词（画像本身是长句，不能直接搜）
  let llmKeywords: string[] = [];
  if (profile && rawTags.length >= 3) {
    try {
      const { data } = await aiJSON<{ keywords: string[] }>({
        schema: KEYWORD_SCHEMA,
        system: '你是动漫检索词生成器。把用户偏好翻译成最可能在动漫数据库命中好结果的具体类型词。只输出 JSON。',
        user: `偏好画像：${profile.preferenceProfile}
喜欢：${profile.likes.map((l) => l.aspect).join('；')}
雷区：${profile.dislikes.map((d) => d.aspect).join('；')}
已有标签：${rawTags.slice(0, 12).join('、')}

请给出 3-5 个检索词。`,
        purpose: 'recommend-keywords',
        temperature: 0.2,
        maxTokens: 1200,
        signal: opts.signal,
        rules: '只要具体的题材/风格词（如：机甲、催泪、悬疑、日常、太空歌剧），不要句子。',
      });
      llmKeywords = (data.keywords || []).filter((k) => k.length >= 2 && k.length <= 6);
    } catch {
      // 提炼失败就用原始标签，不影响主流程
    }
  }

  const searchTags = [...new Set([...llmKeywords, ...rawTags])].slice(0, 8);
  if (searchTags.length === 0) searchTags.push(...hiTagNames.slice(0, 5));

  onProgress?.('正在搜索匹配番剧…');

  const excludeTitles = animeList
    .filter((a) => a.scores.some((s) => s.score > 0))
    .sort((a, b) => calcOverall(b, dims) - calcOverall(a, dims))
    .map((a) => a.title)
    .slice(0, 40);

  let discoverResults: DiscoverItem[] = [];
  let sourceLabel = '';

  /** 每个来源都带硬超时：慢的那个不许拖着整个面板 */
  const postJson = async (path: string, payload: unknown): Promise<DiscoverItem[]> => {
    try {
      const resp = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: withDeadline(opts.signal, DISCOVER_TIMEOUT_MS),
      });
      if (!resp.ok) return [];
      const data = await resp.json();
      return Array.isArray(data?.results) ? data.results : [];
    } catch {
      if (opts.signal?.aborted) throw new Error('请求已取消');
      return [];
    }
  };

  // 三个来源并行（互相独立，串行只会把 20 秒等成 60 秒）
  onProgress?.('正在搜索匹配番剧…');
  const [anilistResults, bangumiResults, bangumiSearchResults] = await Promise.all([
    postJson('/api/anilist/discover', { tags: searchTags, excludeTitles }),
    postJson('/api/bangumi/browse', { tags: searchTags }),
    postJson('/api/bangumi/discover', { tags: searchTags }),
  ]);
  if (anilistResults.length > 0) {
    discoverResults = anilistResults;
    sourceLabel = 'AniList';
  } else if (bangumiResults.length > 0) {
    discoverResults = bangumiResults;
    sourceLabel = 'Bangumi';
  } else if (bangumiSearchResults.length > 0) {
    discoverResults = bangumiSearchResults;
    sourceLabel = 'Bangumi搜索';
  }

  const isDirectLLM = discoverResults.length === 0;

  // Tier 4: 完全依赖模型的知识（外部全挂时兜底）
  if (isDirectLLM) {
    onProgress?.('外部数据不可用，AI 正在直接推荐…');
    sourceLabel = 'AI直接推荐';

    const profileText = profile
      ? `偏好画像：${profile.preferenceProfile}
喜欢：${profile.likes.map((l) => l.aspect).join('；')}
雷区：${profile.dislikes.map((d) => d.aspect).join('；')}`
      : `高偏差作品：${devData.topPos.slice(0, 6).map((d) => d.anime.title).join('、')}
标签：${searchTags.join('、')}`;

    try {
      const { data } = await aiJSON<{ recommendations: { title: string; reason: string; intro: string; confidence: number }[] }>({
        schema: RECOMMEND_SCHEMA,
        system: '你是番剧推荐师，熟悉各种冷门作品。根据用户口味推荐他没看过的番剧。绝不剧透情节。',
        user: `=== 用户品味 ===
${profileText}

=== 已看过（不要推荐）===
${animeList.map((a) => a.title).join('、').slice(0, 2000)}

请推荐 3-5 部。`,
        purpose: 'recommend-direct',
        temperature: 0.7,
        maxTokens: 3000,
        signal: opts.signal,
        rules: 'title 用中文通用译名；intro 100 字以内，只谈风格氛围，不谈剧情。',
      });

      // 回查 Bangumi 校验是否真实存在，并补齐封面/评分
      onProgress?.('正在校验推荐结果…');
      const recs = data.recommendations.slice(0, 5);
      // 并发查（3 路）且连续失败就熔断：Bangumi 不可用时不该让用户干等 5 次超时
      const hits = new Map<string, DiscoverItem | null>();
      let consecutiveFailures = 0;
      let cursor = 0;
      const worker = async () => {
        for (;;) {
          if (opts.signal?.aborted) throw new Error('请求已取消');
          const index = cursor++;
          if (index >= recs.length) return;
          if (consecutiveFailures >= 2) { hits.set(recs[index].title, null); continue; }
          const hit = await lookupTitle(recs[index].title, opts.signal);
          hits.set(recs[index].title, hit);
          consecutiveFailures = hit ? 0 : consecutiveFailures + 1;
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, recs.length) }, worker));

      const enriched: Recommendation[] = recs.map((rec) => {
        const hit = hits.get(rec.title) || null;
        return {
          title: rec.title,
          reason: rec.reason,
          intro: rec.intro || (hit?.summary || '').replace(/<[^>]+>/g, '').slice(0, 120),
          bgmScore: hit?.rating?.score,
          posterUrl: hit?.images?.large || hit?.images?.common || '',
          airDate: hit?.air_date || '',
          matchedTags: hit ? ['AI推荐'] : [],
          confidence: hit ? Math.min(1, rec.confidence) : rec.confidence * 0.6,
          verified: Boolean(hit),
        };
      });
      return {
        recommendations: enriched,
        candidateCount: enriched.length,
        searchedTags: searchTags,
        sourceLabel,
      };
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      return { recommendations: [], candidateCount: 0, searchedTags: searchTags, sourceLabel };
    }
  }

  // 本地粗排：按"命中用户高频标签"的数量 + 社区评分，压到 24 个候选
  const existingTitles = new Set(
    animeList.flatMap((a) => [norm(a.title), norm(a.titleJa || ''), norm(a.searchAlias || '')]),
  );
  const hiTagSet = new Set(hiTagNames.map((t) => t.toLowerCase()));

  const scored = discoverResults
    .map((item) => {
      const tags = [...(item.tags || []), ...(item.genres || [])].map((t) => String(t).toLowerCase());
      const overlap = tags.filter((t) => hiTagSet.has(t)).length;
      const rating = item.rating?.score || 0;
      return { item, score: overlap * 3 + rating };
    })
    .filter(({ item }) => {
      const names = [norm(item.name_cn || ''), norm(item.name || ''), norm((item as DiscoverItem & { name_en?: string }).name_en || '')];
      return names.some((n) => n.length >= 2 && !existingTitles.has(n));
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 24)
    .map(({ item }) => item);

  if (scored.length === 0) {
    return { recommendations: [], candidateCount: 0, searchedTags: searchTags, sourceLabel };
  }

  onProgress?.('AI 正在挑选最合适的几部…');

  const candidateLines = scored
    .map((item) => {
      const title = item.name_cn || item.name;
      const score = item.rating?.score ? `评分${item.rating.score}` : '';
      const date = item.air_date ? `(${item.air_date})` : '';
      const genres = item.genres?.length ? `类型: ${item.genres.slice(0, 5).join('/')}` : '';
      const summary = (item.summary || '').replace(/<[^>]+>/g, '').slice(0, 160);
      return `- ${title} ${date} ${score} ${genres}\n  简介: ${summary}`;
    })
    .join('\n\n');

  const profileText = profile
    ? `偏好画像：${profile.preferenceProfile}
喜欢：${profile.likes.map((l) => l.aspect).join('、')}
雷区：${profile.dislikes.map((d) => d.aspect).join('、')}`
    : `高偏差作品高频标签：${hiTagNames.join('、')}
评语关键词：${kwNames.join('、')}`;

  const { data: picked } = await aiJSON<{ recommendations: { title: string; reason: string; intro: string; confidence: number }[] }>({
    schema: RECOMMEND_SCHEMA,
    system: `你是番剧推荐师。只能从下面给出的候选列表里挑选，不允许推荐列表外的作品。
选片标准：跟用户的口味结构匹配，而不是选评分最高的。
写作要求：绝不剧透剧情走向、关键转折或结局；intro 只描述类型、风格、氛围和看点。`,
    user: `=== 用户品味 ===
${profileText}

=== 候选（共 ${scored.length} 部）===
${candidateLines}

请精选 3-5 部。`,
    purpose: 'recommend-pick',
    temperature: 0.45,
    maxTokens: 3000,
    signal: opts.signal,
    run: opts.run,
    rules: 'title 必须逐字来自候选列表。',
  });

  const merged: Recommendation[] = picked.recommendations.map((rec) => {
    const target = norm(rec.title);
    const match = scored.find((item) => {
      const cn = norm(item.name_cn || '');
      const jp = norm(item.name || '');
      return (cn && (cn.includes(target) || target.includes(cn)))
        || (jp && (jp.includes(target) || target.includes(jp)));
    });
    return {
      title: match ? (match.name_cn || match.name) : rec.title,
      reason: rec.reason,
      intro: rec.intro || (match?.summary || '').replace(/<[^>]+>/g, '').slice(0, 120),
      bgmScore: match?.rating?.score,
      posterUrl: match?.images?.large || match?.images?.common || '',
      airDate: match?.air_date || '',
      matchedTags: [
        ...new Set([
          ...(match?.matchedTag ? [match.matchedTag] : []),
          ...(match?.genres?.slice(0, 3) || []),
          ...(match?.tags?.slice(0, 3) || []),
        ]),
      ],
      confidence: match ? rec.confidence : rec.confidence * 0.7,
      verified: Boolean(match),
    };
  });

  return {
    recommendations: merged,
    candidateCount: scored.length,
    searchedTags: searchTags,
    sourceLabel,
  };
}
