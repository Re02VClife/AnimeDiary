/**
 * Excel 数据服务层
 *   通过 Vite 开发服务器的 API 端点读写 Excel 文件
 *   生产模式下降级为本地 Mock 数据
 */
import type { AnimeEntry, AnimeTag, DimensionScore, DimensionReview } from '../types';
import { EXCEL_COL, MAIN_SHEET, DIMENSION_COL_MAP, EDITABLE_COLS } from './excelMapping';
import { loadCategoryMap, loadWatchingDeleted, loadDimReviews, loadPosterBlacklist, loadPosterOverrides, savePosterOverride } from './storageService';

// ── API 基础路径 ──
const API_BASE = '/api/excel';

interface ExcelUpdate {
  sheetName: string;
  rowIndex: number;
  colIndex: number;
  value: string | number;
}

// ── 辅助函数 ──

/** 将 Excel 序列号转为 ISO 日期字符串 */
function excelSerialToDate(serial: number): string {
  if (!serial || serial < 1) return '';
  const utcDays = Math.floor(serial) - 25569;
  const date = new Date(utcDays * 86400 * 1000);
  return date.toISOString().split('T')[0];
}

/** 将 ISO 日期字符串转为 Excel 序列号 */
function dateToExcelSerial(dateStr: string): number {
  if (!dateStr) return 0;
  const d = new Date(dateStr);
  return Math.round(d.getTime() / 86400000) + 25569;
}

/** 解析上映年月（"21/4" → "2021-04"） */
function parseReleaseDate(raw: string): string {
  if (!raw) return '';
  const parts = String(raw).split('/');
  if (parts.length === 2) {
    let year = parseInt(parts[0], 10);
    const month = parts[1].padStart(2, '0');
    if (year < 50) year += 2000;
    else if (year < 100) year += 1900;
    return `${year}-${month}`;
  }
  return String(raw);
}

/** 解析 tag 字符串（"/" 或 "、" 分隔） */
function parseTags(raw: string): AnimeTag[] {
  if (!raw) return [];
  const names = String(raw).split(/[/、]/).map((s) => s.trim()).filter(Boolean);
  return names.map((name) => ({ name, highlighted: false }));
}

/** 解析数值，无效时返回 0 */
function parseNumber(raw: unknown): number {
  if (raw === '' || raw === null || raw === undefined) return 0;
  const n = Number(raw);
  return isNaN(n) ? 0 : n;
}

/** 从行数据提取角色名列表 */
function extractCharacters(row: unknown[]): string[] {
  const chars: string[] = [];
  const charCols = [
    EXCEL_COL.CHAR1_NAME,
    EXCEL_COL.CHAR2_NAME,
    EXCEL_COL.CHAR3_NAME,
    EXCEL_COL.CHAR4_NAME,
  ];
  for (const col of charCols) {
    const name = String(row[col] || '').trim();
    if (name) chars.push(name);
  }
  return chars;
}

// ── 核心映射函数 ──

/** 将 Excel 一行数据映射为 AnimeEntry */
function mapRowToAnime(row: unknown[], rowIndex: number): AnimeEntry | null {
  const title = String(row[EXCEL_COL.TITLE] || '').trim();
  if (!title) return null;

  const scores: DimensionScore[] = [];
  for (const [dimKey, colIdx] of Object.entries(DIMENSION_COL_MAP)) {
    const score = parseNumber(row[colIdx]);
    if (score > 0) {
      scores.push({ dimensionKey: dimKey, score });
    }
  }
  const reviewText = String(row[EXCEL_COL.REVIEW] || '').trim();
  const hasScores = scores.some((s) => s.dimensionKey !== 'overall' && s.score > 0);

  return {
    id: `excel-${rowIndex}`,
    excelRowIndex: rowIndex,
    title,
    searchAlias: String(row[EXCEL_COL.SEARCH_ALIAS] || '').trim(),
    posterUrl: String(row[EXCEL_COL.POSTER_URL] || '').trim(),
    // 数据质量分类：无评分或无评价 → 在看
    category: (!hasScores || !reviewText) ? 'watching' : 'watched',
    tags: parseTags(String(row[EXCEL_COL.TAG] || '')),
    scores,
    releaseDate: parseReleaseDate(String(row[EXCEL_COL.RELEASE_DATE] || '')),
    bangumiScore: parseNumber(row[EXCEL_COL.BGM_SCORE]) || undefined,
    characters: extractCharacters(row),
    episodes: undefined,
    studio: String(row[EXCEL_COL.STUDIO] || '').trim() || undefined,
    frameCount: parseNumber(row[EXCEL_COL.FRAME_COUNT]) || undefined,
    aniListScore: parseNumber(row[EXCEL_COL.ANILIST_SCORE]) || undefined,
    watchDate: excelSerialToDate(parseNumber(row[EXCEL_COL.WATCH_DATE])) || undefined,
    review: reviewText || undefined,
    notes: String(row[EXCEL_COL.NOTES] || '').trim() || undefined,
    createdAt: excelSerialToDate(parseNumber(row[EXCEL_COL.FIRST_WATCH])),
    updatedAt: new Date().toISOString().split('T')[0],
  };
}

/** 将 AnimeEntry 反向映射为 Excel 更新列表 */
function mapAnimeToUpdates(entry: AnimeEntry): ExcelUpdate[] {
  const updates: ExcelUpdate[] = [];
  const rowIdx = entry.excelRowIndex;
  if (rowIdx === undefined) return updates;

  for (const score of entry.scores) {
    const col = DIMENSION_COL_MAP[score.dimensionKey];
    if (col !== undefined && EDITABLE_COLS.includes(col)) {
      updates.push({ sheetName: MAIN_SHEET, rowIndex: rowIdx, colIndex: col, value: score.score });
    }
  }

  if (entry.review !== undefined) {
    updates.push({ sheetName: MAIN_SHEET, rowIndex: rowIdx, colIndex: EXCEL_COL.REVIEW, value: entry.review });
  }

  if (entry.tags) {
    const tagStr = entry.tags.map((t) => t.name).join('/');
    updates.push({ sheetName: MAIN_SHEET, rowIndex: rowIdx, colIndex: EXCEL_COL.TAG, value: tagStr });
  }

  if (entry.notes !== undefined) {
    updates.push({ sheetName: MAIN_SHEET, rowIndex: rowIdx, colIndex: EXCEL_COL.NOTES, value: entry.notes });
  }

  if (entry.searchAlias !== undefined && entry.searchAlias !== '') {
    updates.push({ sheetName: MAIN_SHEET, rowIndex: rowIdx, colIndex: EXCEL_COL.SEARCH_ALIAS, value: entry.searchAlias });
  }

  // 上映日期
  if (entry.releaseDate !== undefined) {
    updates.push({ sheetName: MAIN_SHEET, rowIndex: rowIdx, colIndex: EXCEL_COL.RELEASE_DATE, value: entry.releaseDate });
  }

  // 观看时间（首刷时间）：写入 Excel 序列号
  if (entry.watchDate !== undefined) {
    const serial = dateToExcelSerial(entry.watchDate);
    if (serial > 0) {
      updates.push({ sheetName: MAIN_SHEET, rowIndex: rowIdx, colIndex: EXCEL_COL.WATCH_DATE, value: serial });
    }
  }

  // Bangumi 评分
  if (entry.bangumiScore !== undefined) {
    updates.push({ sheetName: MAIN_SHEET, rowIndex: rowIdx, colIndex: EXCEL_COL.BGM_SCORE, value: entry.bangumiScore });
  }

  // AniList 评分
  if (entry.aniListScore !== undefined) {
    updates.push({ sheetName: MAIN_SHEET, rowIndex: rowIdx, colIndex: EXCEL_COL.ANILIST_SCORE, value: entry.aniListScore });
  }

  // 制作组
  if (entry.studio !== undefined) {
    updates.push({ sheetName: MAIN_SHEET, rowIndex: rowIdx, colIndex: EXCEL_COL.STUDIO, value: entry.studio });
  }

  // 张数
  if (entry.frameCount !== undefined) {
    updates.push({ sheetName: MAIN_SHEET, rowIndex: rowIdx, colIndex: EXCEL_COL.FRAME_COUNT, value: entry.frameCount });
  }

  // 海报 URL
  if (entry.posterUrl) {
    updates.push({ sheetName: MAIN_SHEET, rowIndex: rowIdx, colIndex: EXCEL_COL.POSTER_URL, value: entry.posterUrl });
  }

  return updates;
}

// ── 公开 API ──

/** 从 Excel 加载番剧列表，应用用户覆盖并过滤已删条目 */
export async function loadAnimeList(): Promise<AnimeEntry[]> {
  try {
    const response = await fetch(`${API_BASE}/read`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (data.error) throw new Error(data.error);

    const rows = data[MAIN_SHEET] || [];
    const entries: AnimeEntry[] = [];
    for (let i = 1; i < rows.length; i++) {
      const entry = mapRowToAnime(rows[i], i);
      if (entry) entries.push(entry);
    }

    // ── 应用用户覆盖 ──
    const categoryMap = loadCategoryMap();
    const watchingDeleted = loadWatchingDeleted();
    const dimReviews = loadDimReviews();
    const posterOverrides = await loadPosterOverrides();

    // ── 加载 AniList 海报缓存（仅对 Excel 中无海报的条目进行补完） ──
    const posterBlacklist = loadPosterBlacklist();
    const posterMap: Record<string, string> = {};
    try {
      const posterResp = await fetch('/api/anilist/cache');
      if (posterResp.ok) {
        const posterCache = await posterResp.json();
        // 规范化匹配函数：去除所有空白和特殊字符后全等比较
        const norm = (s: string) => s.replace(/[\s\-_:：・().、，。！？]+/g, '').toLowerCase();
        const cacheEntries = Object.entries(posterCache) as [string, { images?: { large?: string } }][];
        for (const entry of entries) {
          // 已有海报（来自 Excel 列或用户覆盖）则跳过匹配
          if (entry.posterUrl) continue;
          // 跳过黑名单中删过的海报
          if (posterBlacklist.has(entry.id)) continue;
          const keyNorm = norm(entry.title);
          // 同时检查 searchAlias
          const aliasNorm = entry.searchAlias ? norm(entry.searchAlias) : '';
          for (const [cacheKey, cacheVal] of cacheEntries) {
            const cacheNorm = norm(cacheKey);
            // 改为精确匹配：归一化后全等，杜绝"spy"匹配"spyfamily"这类误匹配
            const isExactMatch = cacheNorm === keyNorm || (aliasNorm && cacheNorm === aliasNorm);
            if (isExactMatch) {
              if (cacheVal.images?.large) {
                posterMap[entry.id] = cacheVal.images.large;
                break;
              }
            }
          }
        }
      }
    } catch (_) { /* 缓存加载失败 */ }

    const finalEntries = entries
      .filter((entry) => {
        if (watchingDeleted.has(entry.id)) return false;
        return true;
      })
      .map((entry) => {
        if (categoryMap[entry.id]) {
          entry.category = categoryMap[entry.id];
        }
        if (dimReviews[entry.id]) {
          entry.dimensionReviews = dimReviews[entry.id];
        }
        // 应用海报优先级：用户手动覆盖 > Excel 列持久化 > AniList 缓存匹配
        if (posterOverrides[entry.id]) {
          entry.posterUrl = posterOverrides[entry.id];
        } else if (entry.posterUrl) {
          // 已有 Excel 列中的海报，保持不变
        } else if (posterMap[entry.id]) {
          entry.posterUrl = posterMap[entry.id];
          // 新匹配到的海报自动持久化到 IndexedDB，下次可直接加载
          savePosterOverride(entry.id, posterMap[entry.id]).catch(() => {});
        }
        return entry;
      });

    return finalEntries;
  } catch (e) {
    console.error('Excel 读取失败，使用 Mock 数据:', e);
    return getMockAnimeList();
  }
}

/** 仅保存海报 URL 到 Excel（独立写入，不需依赖主保存按钮） */
export async function savePosterUrlToExcel(entry: AnimeEntry): Promise<void> {
  if (entry.excelRowIndex === undefined || !entry.posterUrl) return;
  const updates: ExcelUpdate[] = [{
    sheetName: MAIN_SHEET,
    rowIndex: entry.excelRowIndex,
    colIndex: EXCEL_COL.POSTER_URL,
    value: entry.posterUrl,
  }];
  const response = await fetch(`${API_BASE}/write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: '请求失败' }));
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  const data = await response.json();
  if (data.error) throw new Error(data.error);
}

/** 批量将所有番剧的海报 URL 写入 Excel（一次 API 调用） */
export async function batchSaveAllPosters(entries: AnimeEntry[]): Promise<number> {
  const allUpdates: ExcelUpdate[] = [];
  for (const entry of entries) {
    if (entry.excelRowIndex === undefined || !entry.posterUrl) continue;
    allUpdates.push({
      sheetName: MAIN_SHEET,
      rowIndex: entry.excelRowIndex,
      colIndex: EXCEL_COL.POSTER_URL,
      value: entry.posterUrl,
    });
  }
  if (allUpdates.length === 0) return 0;

  const response = await fetch(`${API_BASE}/write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(allUpdates),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: '请求失败' }));
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  const data = await response.json();
  if (data.error) throw new Error(data.error);
  return allUpdates.length;
}

/** 保存单条番剧的修改到 Excel */
export async function updateAnimeEntry(entry: AnimeEntry): Promise<void> {
  const updates = mapAnimeToUpdates(entry);
  if (updates.length === 0) return;

  const response = await fetch(`${API_BASE}/write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: '请求失败' }));
    throw new Error(data.error || `HTTP ${response.status}`);
  }

  const data = await response.json();
  if (data.error) {
    throw new Error(data.error);
  }
}

/** 获取 Excel 文件信息 */
export async function getExcelInfo(): Promise<{ exists: boolean; path?: string; size?: number }> {
  try {
    const response = await fetch(`${API_BASE}/info`);
    return response.json();
  } catch {
    return { exists: false };
  }
}

/**
 * 懒加载海报：对单个番剧搜索 AniList
 *   成功则写入缓存并返回海报 URL
 */
export async function fetchPoster(title: string): Promise<string> {
  try {
    const resp = await fetch(`/api/anilist/search?keyword=${encodeURIComponent(title)}`);
    if (!resp.ok) return '';
    const data = await resp.json();
    const item = data?.list?.[0];
    return item?.images?.large || '';
  } catch {
    return '';
  }
}

// ── Mock 数据（API 不可用时降级用） ──
function getMockAnimeList(): AnimeEntry[] {
  return [
    {
      id: 'mock-1', excelRowIndex: 1, title: '86 不存在的战区 Part1',
      posterUrl: '', category: 'watched',
      tags: [{ name: '科幻', highlighted: true }, { name: '战争', highlighted: true }],
      scores: [
        { dimensionKey: 'overall', score: 9.07 }, { dimensionKey: 'audio', score: 9.6 },
        { dimensionKey: 'production', score: 9.3 }, { dimensionKey: 'animation', score: 8.6 },
        { dimensionKey: 'immersion', score: 10 }, { dimensionKey: 'plot', score: 8 },
        { dimensionKey: 'character', score: 8 }, { dimensionKey: 'depth', score: 9 },
        { dimensionKey: 'vibe', score: 9.72 },
      ],
      releaseDate: '2021-04', bangumiScore: 7.6,
      review: 'Excel 文件未连接，这是 Mock 数据',
      createdAt: '2024-01-01', updatedAt: '2024-06-01',
    },
    {
      id: 'mock-2', excelRowIndex: 2, title: '利兹与青鸟',
      posterUrl: '', category: 'watched',
      tags: [{ name: '剧场版', highlighted: true }, { name: '音乐', highlighted: true }],
      scores: [
        { dimensionKey: 'overall', score: 8.88 }, { dimensionKey: 'audio', score: 8.6 },
        { dimensionKey: 'production', score: 8.3 }, { dimensionKey: 'animation', score: 9.2 },
        { dimensionKey: 'immersion', score: 9.5 }, { dimensionKey: 'plot', score: 9 },
        { dimensionKey: 'character', score: 8 }, { dimensionKey: 'depth', score: 9 },
        { dimensionKey: 'vibe', score: 9.27 },
      ],
      releaseDate: '2018-04', bangumiScore: 8.6,
      review: 'Excel 文件未连接，这是 Mock 数据',
      createdAt: '2024-02-01', updatedAt: '2024-05-01',
    },
  ];
}
