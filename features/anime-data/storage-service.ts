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

/**
 * 整表写回维度专项评价。
 * 合并重复角色卡时要把被移除卡片的评价迁到保留的那张，逐条 saveDimReview 会
 * 「读整表→改→写整表」重复多次，并发下互相覆盖（这个坑海报覆盖那边踩过）。
 */
export function saveDimReviews(all: Record<string, DimensionReview[]>): void {
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

/**
 * 海报覆盖的写队列。
 * 覆盖表是「整体存成一个键」，写入必须"读整个 map → 改 → 整体写回"，
 * 并发调用会互相覆盖（实测批量把 13 张 base64 海报转本地文件时只存下 2 张）。
 * 这里把写操作串行化，保证每次都基于上一次的结果。
 */
let posterWriteQueue: Promise<void> = Promise.resolve();

function enqueuePosterWrite(task: () => Promise<void>): Promise<void> {
  const run = posterWriteQueue.then(task, task);
  posterWriteQueue = run.catch(() => { /* 队列不因单次失败中断 */ });
  return run;
}

/** 整体写入覆盖表（调用方自行合并好），用于批量归一化等一次写多条的场合 */
export async function savePosterOverrides(overrides: Record<string, string>): Promise<void> {
  return enqueuePosterWrite(async () => {
    const db = await openPosterDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(POSTER_STORE, 'readwrite');
      tx.objectStore(POSTER_STORE).put(overrides, 'overrides');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }).catch((e) => {
    console.error('[storage] 保存海报覆盖失败:', e);
  });
}

export async function savePosterOverride(animeId: string, posterUrl: string): Promise<void> {
  return enqueuePosterWrite(async () => {
    const overrides = await loadPosterOverrides();
    if (posterUrl) {
      overrides[animeId] = posterUrl;
    } else {
      delete overrides[animeId];
    }
    const db = await openPosterDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(POSTER_STORE, 'readwrite');
      tx.objectStore(POSTER_STORE).put(overrides, 'overrides');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }).catch((e) => {
    console.error('[storage] 保存海报覆盖失败:', e);
  });
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

// ── 物理删除 Excel 行之后：把本地按行号索引的数据整体前移 ──

/**
 * `excel-<行号>` 的 id 按删行结果重映射。
 * 返回 null 表示这条正好属于被删的那一行（应当丢弃）；
 * 非 `excel-` 前缀的 id（手工建的 `char-...` 等）不受影响，原样返回。
 */
function shiftExcelId(id: string, deletedRowIndex: number): string | null {
  const m = /^excel-(\d+)$/.exec(id);
  if (!m) return id;
  const row = Number(m[1]);
  if (row === deletedRowIndex) return null;
  return row > deletedRowIndex ? `excel-${row - 1}` : id;
}

function shiftRecord<T>(rec: Record<string, T>, deletedRowIndex: number): { next: Record<string, T>; moved: number } {
  const next: Record<string, T> = {};
  let moved = 0;
  for (const [k, v] of Object.entries(rec)) {
    const nk = shiftExcelId(k, deletedRowIndex);
    if (nk !== k) moved++;
    if (nk !== null) next[nk] = v;
  }
  return { next, moved };
}

function shiftIdSet(set: Set<string>, deletedRowIndex: number): { next: Set<string>; moved: number } {
  const next = new Set<string>();
  let moved = 0;
  for (const id of set) {
    const nid = shiftExcelId(id, deletedRowIndex);
    if (nid !== id) moved++;
    if (nid !== null) next.add(nid);
  }
  return { next, moved };
}

/**
 * 物理删除第 deletedRowIndex 行之后，把本地所有以 `excel-<行号>` 为键的数据前移一位。
 *
 * 为什么必须做：条目 id 就是行号（`excel-N`），删掉一行会让它后面每一行的 id 都变。
 * 不迁移的话，海报覆盖、焦点位置、分类、维度点评会集体错位到**别的条目**身上 ——
 * 而且错得很隐蔽：不是数据丢失，是张冠李戴。
 *
 * 返回迁移到的键数量，供界面提示。
 */
export async function shiftLocalRefsAfterRowDelete(deletedRowIndex: number): Promise<number> {
  let moved = 0;

  const cats = shiftRecord(loadCategoryMap(), deletedRowIndex);
  saveCategoryMap(cats.next);
  moved += cats.moved;

  const del = shiftIdSet(loadWatchingDeleted(), deletedRowIndex);
  localStorage.setItem(KEYS.DELETED_WATCHING, JSON.stringify([...del.next]));
  moved += del.moved;

  const bl = shiftIdSet(loadPosterBlacklist(), deletedRowIndex);
  localStorage.setItem(POSTER_BLACKLIST_KEY, JSON.stringify([...bl.next]));
  moved += bl.moved;

  const pos = shiftRecord(loadPosterPositions(), deletedRowIndex);
  localStorage.setItem(POSTER_POS_KEY, JSON.stringify(pos.next));
  moved += pos.moved;

  const dim = shiftRecord(loadDimReviews(), deletedRowIndex);
  saveDimReviews(dim.next);
  moved += dim.moved;

  // 单集评价是数组，元素自带 animeId
  const nextEps: EpisodeReview[] = [];
  for (const r of loadEpisodeReviews()) {
    const nid = shiftExcelId(r.animeId, deletedRowIndex);
    if (nid === null) { moved++; continue; }
    if (nid !== r.animeId) { moved++; nextEps.push({ ...r, animeId: nid }); }
    else nextEps.push(r);
  }
  localStorage.setItem(KEYS.EPISODE_REVIEWS, JSON.stringify(nextEps));

  // 海报覆盖存在 IndexedDB 里，异步
  const ov = shiftRecord(await loadPosterOverrides(), deletedRowIndex);
  await savePosterOverrides(ov.next);
  moved += ov.moved;

  return moved;
}

// ── 一键导出/导入用户数据 ──

/** localStorage 中属于本项目的所有 key */
const ALL_LOCAL_KEYS = [
  KEYS.CATEGORIES,
  KEYS.DELETED_WATCHING,
  KEYS.DIMENSIONS,
  KEYS.EPISODE_REVIEWS,
  KEYS.DIM_REVIEWS,
  KEYS.OVERRIDES,
  'anime_diary_tag_presets',
  'anime_diary_templates',  // 评分模板
  POSTER_POS_KEY,
  POSTER_BLACKLIST_KEY,
  IMG_HEIGHT_KEY,
  // 以下原先漏了，导致"备份"不完整：换机后主题、当前模板、雷达图设置、AI 配置会丢
  'anime_diary_theme',
  'anime_diary_active_template',
  'anime_diary_radar_mode',
  'anime_diary_radar_min',
  'anime_diary_ai_config',
  'anime_diary_character_seeded',
];

/** 导入前的本地数据快照（仅保留最近一次，供用户手工回滚） */
const PRE_IMPORT_SNAPSHOT_KEY = 'anime_diary_pre_import_snapshot';

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

  // 覆盖前先留一份当前本地数据的快照，导错了还能手工回滚
  try {
    const snapshot: Record<string, string | null> = {};
    for (const k of ALL_LOCAL_KEYS) snapshot[k] = localStorage.getItem(k);
    localStorage.setItem(PRE_IMPORT_SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch { /* skip */ }

  // 只恢复已知的键：原先会把备份文件里的任意 key 都直接写进 localStorage
  const allowed = new Set<string>(ALL_LOCAL_KEYS);
  let skipped = 0;
  for (const [key, value] of Object.entries(backup.localStorage)) {
    if (value === null) continue;
    if (!allowed.has(key)) { skipped++; continue; }
    try {
      localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
    } catch { /* skip */ }
  }
  if (skipped > 0) {
    console.warn(`导入时跳过了 ${skipped} 个不在白名单内的本地数据键`);
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
