/**
 * features/local-library/local-match — 「Excel 条目 ↔ 本地番剧目录」的匹配打分（纯函数）
 *
 * 三级判定，优先级从高到低：
 *   1. **bangumiId 直连**：Excel 条目里存的 subject id 与目录名前缀一致 → 铁定是这部。
 *      这是最理想的情况，而 Kazumi 的目录名恰好就自带 ID，等于白送一个主键。
 *   2. **已保存的同步映射**：用户在「同步到 Bangumi」里确认过的 标题→subject_id，
 *      说明他认过这条对应关系，直接沿用。
 *   3. **标题相似度**：拿 Bangumi 的 name / name_cn 跟 title / titleJa / searchAlias 比。
 *      复用 core/bangumi-match 的打分（二元组 Dice + 包含关系 + 年份加分），
 *      它对「第二季/剧场版」这类限定词已经做了降权，不会把续作匹配到第一季。
 *
 * 目录名不是 Kazumi 结构（没有 ID）时退到第 3 级，用目录名本身当标题。
 */
import { confidenceOf, matchScore } from '../../../core/bangumi-match';
import type { MatchConfidence } from '../../../core/bangumi-match';
import { animeKeyFor } from '../../../core/music-links';
import type { LocalEpisode, LocalFolder } from '../../../core/local-library';
import type { AnimeEntry } from '../../types';

export type MatchReason = 'bangumiId' | 'savedMatch' | 'title' | 'none';

export interface FolderMatch {
  folder: LocalFolder;
  /** 0–1 */
  score: number;
  confidence: MatchConfidence;
  reason: MatchReason;
}

/** 参与匹配的条目字段（AnimeEntry 的子集，测试时不用造整个对象） */
export type MatchableAnime = Pick<AnimeEntry, 'title'> & {
  titleJa?: string;
  searchAlias?: string;
  bangumiId?: number;
  releaseDate?: string;
};

/**
 * 给「一个目录」打「属于某部番」的分。
 * savedSubjectId 来自 bangumi-map（用户在同步面板确认过的映射），可选。
 */
export function scoreFolderForAnime(
  anime: MatchableAnime,
  folder: LocalFolder,
  savedSubjectId?: number,
): FolderMatch {
  // 1. subject id 完全相同：不再看标题，标题写法千奇百怪但 ID 只有一个
  if (anime.bangumiId && folder.bangumiId && anime.bangumiId === folder.bangumiId) {
    return { folder, score: 1, confidence: 'high', reason: 'bangumiId' };
  }

  // 2. 用户确认过的映射
  if (savedSubjectId && folder.bangumiId && savedSubjectId === folder.bangumiId) {
    return { folder, score: 0.96, confidence: 'high', reason: 'savedMatch' };
  }

  // 3. 标题相似度
  const meta = folder.meta;
  const name = meta?.name || '';
  const nameCn = meta?.nameCn || '';
  // 没有元数据时（识别失败 / 普通目录）退回目录名
  const fallback = folder.guessedTitle;
  if (!name && !nameCn && !fallback) {
    return { folder, score: 0, confidence: 'none', reason: 'none' };
  }

  const score = matchScore(
    {
      title: anime.title,
      titleJa: anime.titleJa,
      searchAlias: anime.searchAlias,
      releaseDate: anime.releaseDate,
    },
    {
      id: folder.bangumiId ?? 0,
      name: name || fallback,
      nameCn: nameCn || undefined,
      airDate: meta?.airDate,
    },
  );
  return { folder, score, confidence: confidenceOf(score), reason: score > 0 ? 'title' : 'none' };
}

/** 一条建议：某部番 → 哪些目录 */
export interface BindingSuggestion {
  /** animeKeyFor(番剧) */
  key: string;
  animeId: string;
  animeTitle: string;
  dirPaths: string[];
  confidence: 'high' | 'medium';
  /** 取其中最高的分数 */
  score: number;
  reason: MatchReason;
  /** 同一个目录被多部番的高置信匹配同时认领 —— 不参与「一键绑定」，留给人工判断 */
  conflict: boolean;
}

export interface SuggestOptions {
  /**
   * 标题 → 已确认的 subjectId（bangumi-map 的 loadMatchMap 结果）。
   * 传函数而不是 record：bangumi-map 的 key 是**归一化标题**，
   * 直接拿 `record[anime.title]` 会全部查不到（归一化会去掉空格和标点）。
   */
  savedSubjectLookup?: (title: string) => number | undefined;
  /** 已存在的绑定（key → dirPaths），有绑定的条目不再建议 */
  existingKeys?: Set<string>;
}

/**
 * 给整个番剧列表算建议绑定。
 *
 * 判定细节：
 *   - 有 bangumiId 时，**把所有同 ID 的目录都绑上**（同一部番可能从两个来源站各下了一份，
 *     集数互补是常态）；
 *   - 没有 ID 但标题高置信命中时，只绑分数最高的那一个目录，避免"同系列第 2 季目录"
 *     因为标题互相包含而被一起绑进来。
 */
export function suggestBindings(
  animeList: MatchableAnime[],
  folders: LocalFolder[],
  options: SuggestOptions = {},
): BindingSuggestion[] {
  const { savedSubjectLookup, existingKeys = new Set<string>() } = options;
  if (folders.length === 0) return [];

  const suggestions: BindingSuggestion[] = [];
  /** dirPath → 认领它的 key 集合（冲突检测） */
  const claimedBy = new Map<string, Set<string>>();

  for (const anime of animeList) {
    const key = animeKeyFor(anime);
    if (existingKeys.has(key)) continue;

    const saved = savedSubjectLookup?.(anime.title);
    const matches = folders
      .map((folder) => scoreFolderForAnime(anime, folder, saved))
      .filter((m) => m.confidence !== 'none');

    if (matches.length === 0) continue;

    let chosen: FolderMatch[];
    if (anime.bangumiId) {
      // ID 命中 → 所有同 ID 目录全绑
      chosen = matches.filter((m) => m.reason === 'bangumiId');
    } else {
      // 没有 ID：只取最高分那一个（同分时取第一个，保持稳定）
      matches.sort((a, b) => b.score - a.score);
      chosen = matches.slice(0, 1);
    }
    if (chosen.length === 0) continue;

    const best = chosen.reduce((acc, m) => (m.score > acc.score ? m : acc), chosen[0]);
    if (best.confidence === 'none') continue;

    for (const m of chosen) {
      const set = claimedBy.get(m.folder.dirPath) ?? new Set<string>();
      set.add(key);
      claimedBy.set(m.folder.dirPath, set);
    }

    suggestions.push({
      key,
      animeId: (anime as AnimeEntry).id ?? key,
      animeTitle: anime.title,
      dirPaths: chosen.map((m) => m.folder.dirPath),
      confidence: best.confidence === 'high' ? 'high' : 'medium',
      score: best.score,
      reason: best.reason,
      conflict: false,
    });
  }

  // 冲突标记：一个目录被两条不同的建议认领，就都不能自动绑
  for (const s of suggestions) {
    s.conflict = s.dirPaths.some((dir) => (claimedBy.get(dir)?.size ?? 0) > 1);
  }
  return suggestions.sort((a, b) => b.score - a.score);
}

/** 把多个绑定目录的集数合起来（同一集号取第一个目录的，按集号排序） */
export interface PlayableEpisode {
  /** 集号 */
  number: number;
  /** 来自哪个目录 */
  dirPath: string;
  relPath: string;
  fileName: string;
  size: number;
}

export function mergeEpisodes(dirPaths: string[], folders: LocalFolder[]): PlayableEpisode[] {
  const byDir = new Map(folders.map((f) => [f.dirPath, f]));
  const byNumber = new Map<number, PlayableEpisode>();

  for (const dirPath of dirPaths) {
    const folder = byDir.get(dirPath);
    if (!folder) continue;
    for (const ep of folder.episodes) {
      if (byNumber.has(ep.number)) continue; // 前一个目录已有这集
      byNumber.set(ep.number, {
        number: ep.number,
        dirPath,
        relPath: ep.relPath,
        fileName: ep.fileName,
        size: ep.size,
      });
    }
  }
  return Array.from(byNumber.values()).sort((a, b) => a.number - b.number);
}
