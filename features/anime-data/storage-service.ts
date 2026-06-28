/**
 * 本地存储服务
 *   管理用户自定义数据（分类覆盖、在看删除黑名单、维度自定义等）
 *   使用 localStorage 持久化
 */
import type { AnimeCategory, AnimeOverrides, Dimension, EpisodeReview, DimensionReview } from '../../src/types';
import { DEFAULT_DIMENSIONS } from '../../src/types';

const KEYS = {
  OVERRIDES: 'anime_diary_overrides',
  DIMENSIONS: 'anime_diary_dimensions',
  EPISODE_REVIEWS: 'anime_diary_episode_reviews',
  DIM_REVIEWS: 'anime_diary_dim_reviews',
  DELETED_WATCHING: 'anime_diary_watching_deleted',
  CATEGORIES: 'anime_diary_categories',
} as const;

// ── 分类覆盖 ──

export function loadCategoryMap(): Record<string, AnimeCategory> {
  try {
    const raw = localStorage.getItem(KEYS.CATEGORIES);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function saveCategory(animeId: string, category: AnimeCategory): void {
  const map = loadCategoryMap();
  map[animeId] = category;
  localStorage.setItem(KEYS.CATEGORIES, JSON.stringify(map));
}

// ── 在看删除黑名单 ──

export function loadWatchingDeleted(): Set<string> {
  try {
    const raw = localStorage.getItem(KEYS.DELETED_WATCHING);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

export function addToWatchingDeleted(animeId: string): void {
  const set = loadWatchingDeleted();
  set.add(animeId);
  localStorage.setItem(KEYS.DELETED_WATCHING, JSON.stringify([...set]));
}

export function removeFromWatchingDeleted(animeId: string): void {
  const set = loadWatchingDeleted();
  set.delete(animeId);
  localStorage.setItem(KEYS.DELETED_WATCHING, JSON.stringify([...set]));
}

// ── 维度自定义 ──

export function loadDimensions(): Dimension[] {
  try {
    const raw = localStorage.getItem(KEYS.DIMENSIONS);
    return raw ? JSON.parse(raw) : [...DEFAULT_DIMENSIONS];
  } catch {
    return [...DEFAULT_DIMENSIONS];
  }
}

export function saveDimensions(dimensions: Dimension[]): void {
  localStorage.setItem(KEYS.DIMENSIONS, JSON.stringify(dimensions));
}

// ── 单集评价 ──

export function loadEpisodeReviews(animeId?: string): EpisodeReview[] {
  try {
    const raw = localStorage.getItem(KEYS.EPISODE_REVIEWS);
    const all: EpisodeReview[] = raw ? JSON.parse(raw) : [];
    return animeId ? all.filter((r) => r.animeId === animeId) : all;
  } catch {
    return [];
  }
}

export function saveEpisodeReview(review: EpisodeReview): void {
  const all = loadEpisodeReviews();
  const idx = all.findIndex((r) => r.id === review.id);
  if (idx >= 0) {
    all[idx] = review;
  } else {
    all.push(review);
  }
  localStorage.setItem(KEYS.EPISODE_REVIEWS, JSON.stringify(all));
}

export function deleteEpisodeReview(reviewId: string): void {
  const all = loadEpisodeReviews().filter((r) => r.id !== reviewId);
  localStorage.setItem(KEYS.EPISODE_REVIEWS, JSON.stringify(all));
}

// ── 维度专项评价 ──

export function loadDimReviews(animeId?: string): Record<string, DimensionReview[]> {
  try {
    const raw = localStorage.getItem(KEYS.DIM_REVIEWS);
    const all: Record<string, DimensionReview[]> = raw ? JSON.parse(raw) : {};
    return all;
  } catch {
    return {};
  }
}

export function saveDimReview(animeId: string, review: DimensionReview): void {
  const all = loadDimReviews();
  if (!all[animeId]) all[animeId] = [];
  const idx = all[animeId].findIndex((r) => r.dimensionKey === review.dimensionKey);
  if (idx >= 0) {
    all[animeId][idx] = review;
  } else {
    all[animeId].push(review);
  }
  localStorage.setItem(KEYS.DIM_REVIEWS, JSON.stringify(all));
}

// ── 统一加载覆盖 ──

export function loadOverrides(): AnimeOverrides {
  return {
    categories: loadCategoryMap(),
    watchingDeleted: Object.fromEntries([...loadWatchingDeleted()].map((id) => [id, true])),
    dimensions: loadDimensions(),
  };
}

/** 批量保存分类覆盖 */
export function saveCategoryMap(map: Record<string, AnimeCategory>): void {
  localStorage.setItem(KEYS.CATEGORIES, JSON.stringify(map));
}

// ── 海报黑名单（删过的错误海报不再加载） ──

const POSTER_BLACKLIST_KEY = 'anime_diary_poster_blacklist';

export function loadPosterBlacklist(): Set<string> {
  try {
    const raw = localStorage.getItem(POSTER_BLACKLIST_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch { return new Set(); }
}

export function addToPosterBlacklist(animeId: string): void {
  const set = loadPosterBlacklist();
  set.add(animeId);
  localStorage.setItem(POSTER_BLACKLIST_KEY, JSON.stringify([...set]));
}

// ── 用户手动设置的海报（存入 IndexedDB，避免 localStorage 爆配额） ──

const POSTER_DB_NAME = 'anime_diary_poster_overrides';
const POSTER_STORE = 'posters';

function openPosterDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(POSTER_DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(POSTER_STORE)) {
        req.result.createObjectStore(POSTER_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadPosterOverrides(): Promise<Record<string, string>> {
  try {
    const db = await openPosterDB();
    return new Promise((resolve) => {
      const tx = db.transaction(POSTER_STORE, 'readonly');
      const req = tx.objectStore(POSTER_STORE).get('overrides');
      req.onsuccess = () => resolve(req.result || {});
      req.onerror = () => resolve({});
    });
  } catch { return {}; }
}

export async function savePosterOverride(animeId: string, posterUrl: string): Promise<void> {
  try {
    const db = await openPosterDB();
    const overrides = await loadPosterOverrides();
    if (posterUrl) {
      overrides[animeId] = posterUrl;
    } else {
      delete overrides[animeId];
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction(POSTER_STORE, 'readwrite');
      tx.objectStore(POSTER_STORE).put(overrides, 'overrides');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.error('[storage] 保存海报覆盖失败:', e);
  }
}

// ── 海报焦点位置 ──

const POSTER_POS_KEY = 'anime_diary_poster_positions';

export function loadPosterPositions(): Record<string, { x: number; y: number }> {
  try {
    const raw = localStorage.getItem(POSTER_POS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

// ── 图片管理高度偏好 ──

const IMG_HEIGHT_KEY = 'anime_diary_img_height';

export function loadImgHeight(): number {
  try {
    const raw = localStorage.getItem(IMG_HEIGHT_KEY);
    return raw ? parseInt(raw, 10) : 360;
  } catch { return 360; }
}

export function saveImgHeight(h: number): void {
  localStorage.setItem(IMG_HEIGHT_KEY, String(h));
}

export function savePosterPosition(animeId: string, x: number, y: number): void {
  const map = loadPosterPositions();
  map[animeId] = { x, y };
  localStorage.setItem(POSTER_POS_KEY, JSON.stringify(map));
}

// ── 一键导出/导入用户数据 ──

/** localStorage 中属于本项目的所有 key */
const ALL_LOCAL_KEYS = [
  KEYS.CATEGORIES,
  KEYS.DELETED_WATCHING,
  KEYS.DIMENSIONS,
  KEYS.EPISODE_REVIEWS,
  KEYS.DIM_REVIEWS,
  'anime_diary_tag_presets',
  'anime_diary_templates',  // 评分模板
  POSTER_POS_KEY,
  POSTER_BLACKLIST_KEY,
  IMG_HEIGHT_KEY,
];

interface UserBackup {
  version: '1.0';
  exportedAt: string;
  localStorage: Record<string, unknown>;
  indexedDB: Record<string, unknown>;
}

/** 收集全部用户数据（localStorage + IndexedDB） */
async function collectUserData(): Promise<UserBackup> {
  const lsData: Record<string, unknown> = {};
  for (const key of ALL_LOCAL_KEYS) {
    try {
      const raw = localStorage.getItem(key);
      lsData[key] = raw !== null ? JSON.parse(raw) : null;
    } catch {
      lsData[key] = localStorage.getItem(key);
    }
  }

  const indexedData: Record<string, unknown> = {};
  try {
    indexedData.posterOverrides = await loadPosterOverrides();
  } catch {
    indexedData.posterOverrides = {};
  }

  return {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    localStorage: lsData,
    indexedDB: indexedData,
  };
}

/** 导出全部数据为 ZIP 下载（含 images/），返回 void（触发浏览器下载） */
export async function exportAllUserData(): Promise<void> {
  const backup = await collectUserData();

  const resp = await fetch('/api/backup/export-full', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(backup),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: '导出失败' }));
    throw new Error(err.error || '导出失败');
  }

  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const date = new Date().toISOString().split('T')[0];
  a.download = `AnimeDiary_backup_${date}.zip`;
  a.click();
  URL.revokeObjectURL(url);
}

/** 从 ZIP 文件导入全部用户数据（含 images/），返回 void（内部恢复 localStorage/IndexedDB） */
export async function importUserData(zipFile: File): Promise<void> {
  const formData = new FormData();
  formData.append('backup', zipFile);

  const resp = await fetch('/api/backup/import', {
    method: 'POST',
    body: formData,
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: '导入失败' }));
    throw new Error(err.error || '导入失败');
  }

  const result = await resp.json();
  if (!result.success || !result.data) {
    throw new Error('备份文件格式无效');
  }

  const backup = result.data as UserBackup;
  if (!backup.version || !backup.localStorage) throw new Error('格式不符');

  // 恢复 localStorage
  for (const [key, value] of Object.entries(backup.localStorage)) {
    if (value === null) continue;
    try {
      localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
    } catch { /* skip */ }
  }

  // 恢复 IndexedDB 海报覆盖
  if (backup.indexedDB?.posterOverrides) {
    const overrides = backup.indexedDB.posterOverrides as Record<string, string>;
    try {
      const db = await openPosterDB();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(POSTER_STORE, 'readwrite');
        tx.objectStore(POSTER_STORE).put(overrides, 'overrides');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      console.error('[storage] 恢复海报覆盖失败:', e);
    }
  }

  // 重新加载海报缓存
  try { localStorage.removeItem('anilist_cache'); } catch { /* ignore */ }
}
