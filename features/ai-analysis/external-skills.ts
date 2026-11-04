/**
 * features/ai-analysis/external-skills — 联网检索能力
 *
 * 这个应用本来就有完整的番剧数据链路（Bangumi / AniList，见 server/api-routes.ts），
 * 但一直只服务于「搜索入库」和「智能推荐」两个界面流程。对话窗口要回答
 * 「这部番哪年播的、原作是什么、社区怎么评价」，就得把同一条链路暴露成工具。
 *
 * 两条纪律：
 *
 * 1) **外部数据是数据，不是指令**。抓回来的简介与评论原样交给模型当资料，
 *    不拼进 system prompt，也不执行其中任何内容。
 *
 * 2) **失败要说清楚，不要假装有数据**。Bangumi 不可达时接口会返回 offline:true，
 *    这里必须把它变成明确的工具错误 —— 让模型告诉用户"查不到"，
 *    而不是拿着空数组继续编。
 */

import type { AnimeEntry } from '../../src/types';
import { getScore, calcOverall, getDimensionsForList } from './ai-helpers';

export interface ExternalLookupResult {
  query: string;
  source: 'bangumi' | 'anilist' | 'none';
  /** 本地库里有没有这部（有的话带上你自己的分数，方便和社区对比） */
  local?: {
    title: string;
    overall: number;
    bangumiScore: number | null;
    tags: string[];
  };
  candidates: {
    title: string;
    originalTitle: string;
    score: number | null;
    airDate: string;
    episodes: number;
    tags: string[];
    studio: string;
    url: string;
    summary: string;
  }[];
  note?: string;
}

export interface ExternalReviewsResult {
  title: string;
  count: number;
  reviews: string[];
  note?: string;
}

/** 给外部请求加个截止时间，同时尊重用户点「停止」时传进来的 signal */
function withDeadline(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

function truncate(text: string, max: number): string {
  const s = (text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 本地库里找同名条目（用于"你给了多少分"的对照） */
function findLocal(list: AnimeEntry[], title: string): ExternalLookupResult['local'] | undefined {
  const norm = (s: string) => s.replace(/[\s\-_:：・().（）]+/g, '').toLowerCase();
  const want = norm(title);
  if (!want) return undefined;
  const hit = list.find((a) => norm(a.title) === want
    || norm(a.title).includes(want)
    || want.includes(norm(a.title)));
  if (!hit) return undefined;
  const dims = getDimensionsForList(list);
  return {
    title: hit.title,
    overall: +(getScore(hit, 'overall') || calcOverall(hit, dims)).toFixed(2),
    bangumiScore: hit.bangumiScore ?? null,
    tags: hit.tags.map((t) => t.name),
  };
}

async function searchBangumi(
  keyword: string,
  signal: AbortSignal,
): Promise<{ list: Record<string, unknown>[]; offline: boolean; cached: boolean; error?: string }> {
  const resp = await fetch(`/api/bangumi/search?keyword=${encodeURIComponent(keyword)}`, { signal });
  if (!resp.ok) throw new Error(`Bangumi 搜索接口返回 HTTP ${resp.status}`);
  const json = await resp.json();
  return {
    list: Array.isArray(json?.list) ? json.list : [],
    offline: Boolean(json?.offline),
    // 接口在联网失败时会回落到本地缓存，缓存里可能有用户自己的备注 ——
    // 必须把这个状态带出来，否则会把"你自己的话"当成社区资料交给模型
    cached: Boolean(json?.cached || json?.partial),
    error: typeof json?.error === 'string' ? json.error : undefined,
  };
}

async function searchAniList(
  keyword: string,
  signal: AbortSignal,
): Promise<Record<string, unknown>[]> {
  const resp = await fetch(`/api/anilist/search?keyword=${encodeURIComponent(keyword)}`, { signal });
  if (!resp.ok) return [];
  const json = await resp.json();
  return Array.isArray(json?.list) ? json.list : [];
}

/**
 * 在 Bangumi 检索番剧（失败时回落到 AniList）。
 * Bangumi 优先是因为它带中文名和中文简介，而且用户自己的 BGM 评分就来自这里。
 */
export async function lookupAnime(
  title: string,
  list: AnimeEntry[],
  signal?: AbortSignal,
): Promise<ExternalLookupResult> {
  const query = title.trim();
  if (!query) throw new Error('没有给番剧名');

  const deadline = withDeadline(signal, 20000);
  try {
    let source: ExternalLookupResult['source'] = 'bangumi';
    let raw: Record<string, unknown>[] = [];
    const notes: string[] = [];
    const bgm = await searchBangumi(query, deadline.signal);
    raw = bgm.list;
    if (bgm.cached && raw.length > 0) {
      notes.push('这批结果来自本地缓存（之前查过），可能不是最新的');
    }
    if (bgm.offline) {
      notes.push(`Bangumi 当前不可达${bgm.error ? `（${bgm.error}）` : ''}，已尝试 AniList`);
      source = 'anilist';
      raw = await searchAniList(query, deadline.signal);
    }

    if (raw.length === 0 && source === 'bangumi') {
      // Bangumi 有响应但没结果：再问一次 AniList（译名差异很常见）
      const al = await searchAniList(query, deadline.signal);
      if (al.length > 0) {
        source = 'anilist';
        raw = al;
      }
    }

    if (raw.length === 0) {
      return {
        query,
        source: 'none',
        candidates: [],
        note: notes.join('；') || '两个数据源都没有搜到，可能需要换个译名',
      };
    }

    const local = findLocal(list, query);
    const candidates = raw.slice(0, 5).map((m) => {
      const images = (m.images || {}) as Record<string, string>;
      const rating = (m.rating || {}) as Record<string, number>;
      const tags = Array.isArray(m.tags)
        ? (m.tags as { name?: string }[]).map((t) => t?.name).filter((n): n is string => !!n)
        : [];
      return {
        title: String(m.name_cn || m.name || ''),
        originalTitle: String(m.name || ''),
        score: typeof rating.score === 'number' && rating.score > 0 ? rating.score : null,
        airDate: String(m.air_date || ''),
        episodes: Number(m.eps) || 0,
        tags: tags.slice(0, 8),
        studio: String(m.studio || ''),
        url: String(m.link || (images.large ? '' : '')),
        summary: truncate(String(m.summary || ''), 220),
      };
    });

    return {
      query, source, candidates,
      ...(local ? { local } : {}),
      ...(notes.length > 0 ? { note: notes.join('；') } : {}),
    };
  } finally {
    deadline.dispose();
  }
}

/** 取 Bangumi 社区短评（接口本身有 24h 缓存，重复问同一部不会打网络） */
export async function fetchReviews(
  title: string,
  signal?: AbortSignal,
): Promise<ExternalReviewsResult> {
  const query = title.trim();
  if (!query) throw new Error('没有给番剧名');

  const deadline = withDeadline(signal, 25000);
  try {
    const resp = await fetch('/api/bangumi/reviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ titles: [query] }),
      signal: deadline.signal,
    });
    if (!resp.ok) throw new Error(`评论接口返回 HTTP ${resp.status}`);
    const json = await resp.json();
    const entry = json?.results?.[query] as { reviews?: string[] } | undefined;
    const reviews = (entry?.reviews || []).filter((r) => typeof r === 'string' && r.trim());
    if (reviews.length === 0) {
      return {
        title: query,
        count: 0,
        reviews: [],
        note: '这部没有采集到社区评论（可能太冷门，或 Bangumi 不可达）',
      };
    }
    return {
      title: query,
      count: reviews.length,
      // 单条限长，否则一条长评就能把上下文挤满
      reviews: reviews.slice(0, 12).map((r) => truncate(r, 300)),
    };
  } finally {
    deadline.dispose();
  }
}
