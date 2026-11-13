/**
 * 本地条目 → Bangumi subject_id 的映射持久化。
 *
 * key 用**归一化标题**而不是 entry.id：entry.id 是 `excel-${行号}`，
 * 在 Excel 里插一行就整体错位，映射会静默指到别的番剧上。
 * 标题改动会让映射失效（需要重匹配），但至少不会传错人。
 */
import { normalizeTitle } from '../../../core/bangumi-match';

const STORAGE_KEY = 'anime_diary_bangumi_map';
const CHANGE_EVENT = 'anime_diary_bangumi_map_changed';

export interface SavedMatch {
  subjectId: number;
  /** 存一份显示名，避免候选列表没加载时下拉框是空的 */
  subjectName: string;
  updatedAt: string;
}

export type MatchMap = Record<string, SavedMatch>;

export function matchKey(title: string): string {
  return normalizeTitle(title);
}

export function loadMatchMap(): MatchMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as MatchMap) : {};
  } catch {
    return {};
  }
}

function persist(next: MatchMap): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    /* 存不进去只影响下次打开，不打断本次上传 */
  }
}

export function getSavedMatch(title: string): SavedMatch | undefined {
  return loadMatchMap()[matchKey(title)];
}

export function saveMatch(title: string, subjectId: number, subjectName: string): void {
  const map = loadMatchMap();
  map[matchKey(title)] = { subjectId, subjectName, updatedAt: new Date().toISOString() };
  persist(map);
}

export function removeMatch(title: string): void {
  const map = loadMatchMap();
  delete map[matchKey(title)];
  persist(map);
}

/** 批量写入（一次匹配流程结束只落一次盘，避免 189 次 localStorage 写入） */
export function saveMatches(entries: Array<{ title: string; subjectId: number; subjectName: string }>): void {
  if (entries.length === 0) return;
  const map = loadMatchMap();
  const now = new Date().toISOString();
  for (const e of entries) {
    map[matchKey(e.title)] = { subjectId: e.subjectId, subjectName: e.subjectName, updatedAt: now };
  }
  persist(map);
}
