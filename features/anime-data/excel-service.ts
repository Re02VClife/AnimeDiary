/**
 * Excel 数据服务层
 *   通过 Vite 开发服务器的 API 端点读写 Excel 文件
 *   读取失败时直接抛错，不再降级为 Mock 数据
 *   （Mock 条目带 excelRowIndex，一旦被保存会写坏真实文件的前几行）
 */
import type { AnimeEntry, AnimeTag, DimensionScore, DimensionReview } from '../../src/types';
import { DEFAULT_TEMPLATE_ID } from '../../src/types';
import { EXCEL_COL, MAIN_SHEET, DIMENSION_COL_MAP, EDITABLE_COLS, LEGACY_TEMPLATE_JSON_COL } from './excel-mapping';
import { loadCategoryMap, loadWatchingDeleted, loadDimReviews, loadPosterBlacklist, loadPosterOverrides, savePosterOverride, savePosterOverrides } from './storage-service';
import { saveImage } from '../image-management/image-service';

// ── core/ 工具函数 ──
import { excelSerialToDate, dateToExcelSerial, parseReleaseDate, parseNumber } from '../../core/date';
import { parseTagString } from '../../core/text';
import { round2 } from '../../core/math';

// ── API 基础路径 ──
const API_BASE = '/api/excel';

/**
 * 海报 URL 能否写入 Excel。
 * base64 data URL 动辄几 MB，远超 Excel 单元格 32767 字符上限；
 * 写进去会让整批保存以英文异常失败（Text length must not exceed 32767 characters），
 * 而且用户完全看不出是哪一条番剧的问题。
 */
function isWritablePosterUrl(url: string | undefined): url is string {
  return !!url && !url.startsWith('data:');
}

interface ExcelUpdate {
  sheetName: string;
  rowIndex: number;
  colIndex: number;
  value: string | number;
  /**
   * 客户端认为该行应有的标题（写前身份校验用）。
   * 服务器比对不一致时整批拒绝，避免按旧行号写到别的番剧上。
   */
  expectedTitle?: string;
}

// ── 辅助函数 ──

/** 解析 tag 字符串为 AnimeTag 数组（"/" 或 "、" 分隔） */
function parseTags(raw: string): AnimeTag[] {
  if (!raw) return [];
  return parseTagString(raw).map((name) => ({ name, highlighted: false }));
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
    // round2：Excel 公式列（综合/电波等）会带浮点噪声（9.72000000000004），
    // 不收敛的话会原样显示在维度评分输入框里
    const score = round2(parseNumber(row[colIdx]));
    if (score > 0) {
      scores.push({ dimensionKey: dimKey, score });
    }
  }

  // 读取模板信息
  const templateId = String(row[EXCEL_COL.TEMPLATE_ID] || '').trim() || undefined;
  // TEMPLATE_JSON 读新列（42/AM），回退读历史误用的 T 列（19，与用户「列1」同列）
  const templateJson = String(row[EXCEL_COL.TEMPLATE_JSON] || row[LEGACY_TEMPLATE_JSON_COL] || '').trim();

  // 非默认模板：从 JSON 解析自定义维度评分和自定义字段
  let customFields: Record<string, string | number> | undefined;
  if (templateId && templateId !== DEFAULT_TEMPLATE_ID && templateJson) {
    try {
      const parsed = JSON.parse(templateJson);
      if (Array.isArray(parsed)) {
        // 旧格式：纯数组
        if (parsed.length > 0) { scores.length = 0; scores.push(...parsed.filter((s: DimensionScore) => s.score > 0).map((s: DimensionScore) => ({ ...s, score: round2(s.score) }))); }
      } else {
        // 新格式：{ scores, customFields }
        const cs = parsed.scores as DimensionScore[] | undefined;
        if (cs && cs.length > 0) { scores.length = 0; scores.push(...cs.filter((s) => s.score > 0).map((s) => ({ ...s, score: round2(s.score) }))); }
        customFields = parsed.customFields;
      }
    } catch { /* JSON 解析失败，保留列映射提取的分数 */ }
  }

  const reviewText = String(row[EXCEL_COL.REVIEW] || '').trim();
  const hasScores = scores.some((s) => s.dimensionKey !== 'overall' && s.score > 0);

  return {
    id: `excel-${rowIndex}`,
    excelRowIndex: rowIndex,
    // 记下加载时的标题：写回前用它校验行号是否已错位（用户在 Excel 里插行/排序）
    excelTitleSnapshot: title,
    title,
    searchAlias: String(row[EXCEL_COL.SEARCH_ALIAS] || '').trim(),
    posterUrl: String(row[EXCEL_COL.POSTER_URL] || '').trim(),
    // 数据质量分类：无评分或无评价 → 在看
    category: (!hasScores || !reviewText) ? 'watching' : 'watched',
    tags: parseTags(String(row[EXCEL_COL.TAG] || '')),
    templateId,
    scores,
    customFields,
    releaseDate: parseReleaseDate(String(row[EXCEL_COL.RELEASE_DATE] || '')),
    bangumiScore: round2(parseNumber(row[EXCEL_COL.BGM_SCORE])) || undefined,
    characters: extractCharacters(row),
    episodes: parseNumber(row[EXCEL_COL.EPISODES]) || undefined,
    currentEpisode: parseNumber(row[EXCEL_COL.CURRENT_EP]) || undefined,
    studio: String(row[EXCEL_COL.STUDIO] || '').trim() || undefined,
    frameCount: round2(parseNumber(row[EXCEL_COL.FRAME_COUNT])) || undefined,
    aniListScore: round2(parseNumber(row[EXCEL_COL.ANILIST_SCORE])) || undefined,
    watchDate: excelSerialToDate(parseNumber(row[EXCEL_COL.WATCH_DATE])) || undefined,
    link: String(row[EXCEL_COL.LINK] || '').trim() || undefined,
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
      // 写回也收敛到两位小数，避免把浮点噪声（7.500000000000001）落进 Excel
      updates.push({ sheetName: MAIN_SHEET, rowIndex: rowIdx, colIndex: col, value: round2(score.score) });
    }
  }

  // 非默认模板：将评分 + 自定义字段序列化为 JSON 写入备用列
  if (entry.templateId && entry.templateId !== DEFAULT_TEMPLATE_ID) {
    const cleanScores = entry.scores.map((s) => ({ ...s, score: round2(s.score) }));
    updates.push({
      sheetName: MAIN_SHEET,
      rowIndex: rowIdx,
      colIndex: EXCEL_COL.TEMPLATE_JSON,
      value: JSON.stringify({ scores: cleanScores, customFields: entry.customFields }),
    });
  }
  // 模板 ID 始终写入
  if (entry.templateId) {
    updates.push({
      sheetName: MAIN_SHEET,
      rowIndex: rowIdx,
      colIndex: EXCEL_COL.TEMPLATE_ID,
      value: entry.templateId,
    });
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
    updates.push({ sheetName: MAIN_SHEET, rowIndex: rowIdx, colIndex: EXCEL_COL.BGM_SCORE, value: round2(entry.bangumiScore) });
  }

  // AniList 评分
  if (entry.aniListScore !== undefined) {
    updates.push({ sheetName: MAIN_SHEET, rowIndex: rowIdx, colIndex: EXCEL_COL.ANILIST_SCORE, value: round2(entry.aniListScore) });
  }

  // 制作组
  if (entry.studio !== undefined) {
    updates.push({ sheetName: MAIN_SHEET, rowIndex: rowIdx, colIndex: EXCEL_COL.STUDIO, value: entry.studio });
  }

  // 张数
  if (entry.frameCount !== undefined) {
    updates.push({ sheetName: MAIN_SHEET, rowIndex: rowIdx, colIndex: EXCEL_COL.FRAME_COUNT, value: round2(entry.frameCount) });
  }

  // 总集数
  if (entry.episodes !== undefined) {
    updates.push({ sheetName: MAIN_SHEET, rowIndex: rowIdx, colIndex: EXCEL_COL.EPISODES, value: entry.episodes });
  }

  // 当前集数（在看进度）
  if (entry.currentEpisode !== undefined) {
    updates.push({ sheetName: MAIN_SHEET, rowIndex: rowIdx, colIndex: EXCEL_COL.CURRENT_EP, value: entry.currentEpisode });
  }

  // 海报 URL（base64 data URL 不写，见 isWritablePosterUrl）
  if (isWritablePosterUrl(entry.posterUrl)) {
    updates.push({ sheetName: MAIN_SHEET, rowIndex: rowIdx, colIndex: EXCEL_COL.POSTER_URL, value: entry.posterUrl });
  } else if (entry.posterUrl) {
    console.warn(`[海报] 「${entry.title}」的海报是 base64 data URL，跳过写入 Excel（应已自动转存为本地文件）`);
  }

  // 角色名（AA/AD/AG/AJ）—— 原先只读不写，界面上"添加角色"刷新即丢
  if (entry.characters) {
    const charCols = [EXCEL_COL.CHAR1_NAME, EXCEL_COL.CHAR2_NAME, EXCEL_COL.CHAR3_NAME, EXCEL_COL.CHAR4_NAME];
    charCols.forEach((col, i) => {
      if (!EDITABLE_COLS.includes(col)) return;
      updates.push({ sheetName: MAIN_SHEET, rowIndex: rowIdx, colIndex: col, value: entry.characters?.[i] ?? '' });
    });
  }

  // 外部链接
  if (entry.link !== undefined) {
    updates.push({ sheetName: MAIN_SHEET, rowIndex: rowIdx, colIndex: EXCEL_COL.LINK, value: entry.link || '' });
  }

  // 写前身份校验：整批带上「加载时该行应有的标题」，服务器比对通过后才写
  const expectedTitle = entry.excelTitleSnapshot ?? entry.title;
  if (rowIdx !== undefined && expectedTitle) {
    for (const u of updates) u.expectedTitle = expectedTitle;
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

    // ── 海报 data URL 归一化（一次性自愈） ──
    // 历史遗留：手动设定的海报可能是 base64 data URL（实测单张 10MB），存在 IndexedDB 覆盖里。
    // 后果：① 加载/渲染变慢；② 永远写不进 Excel（单元格上限 32767 字符），
    // 一旦「持久化海报到 Excel」就会整批失败并抛出 SheetJS 的英文异常。
    // 这里把它们落盘成本地图片文件，改存 /api/images/file 短链。
    const dataUrlPosters = finalEntries.filter((e) => (e.posterUrl || '').startsWith('data:'));
    if (dataUrlPosters.length > 0) {
      const converted = await Promise.all(dataUrlPosters.map(async (entry) => {
        try {
          const saved = await saveImage(entry.posterUrl as string, entry.title);
          entry.posterUrl = saved.dataUrl;
          console.info(`[海报] 「${entry.title}」的 base64 海报已转存为本地文件 ${saved.fileName}`);
          return [entry.id, saved.dataUrl] as [string, string];
        } catch (e) {
          // 转存失败不能丢海报：保持原值，只提示
          console.warn(`[海报] 「${entry.title}」的 base64 海报转存失败，保持原值：`, e);
          return null;
        }
      }));
      // 一次性合并写回：逐条 savePosterOverride 会各自"读整个表再整体写回"，
      // 并发下互相覆盖（实测 13 张只存下 2 张）
      const merged = Object.fromEntries(converted.filter(Boolean) as [string, string][]);
      if (Object.keys(merged).length > 0) {
        await savePosterOverrides({ ...posterOverrides, ...merged });
      }
    }

    return finalEntries;
  } catch (e) {
    // 不再降级为 Mock：Mock 条目带 excelRowIndex，用户一保存就会写坏真实文件
    console.error('Excel 读取失败:', e);
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`无法读取 Excel 数据（${msg}）。请确认「番评分.xlsx」存在且未被 Excel/WPS 占用后重试。`);
  }
}

/** 仅保存海报 URL 到 Excel（独立写入，不需依赖主保存按钮） */
export async function savePosterUrlToExcel(entry: AnimeEntry): Promise<void> {
  if (entry.excelRowIndex === undefined || !isWritablePosterUrl(entry.posterUrl)) return;
  const updates: ExcelUpdate[] = [{
    sheetName: MAIN_SHEET,
    rowIndex: entry.excelRowIndex,
    colIndex: EXCEL_COL.POSTER_URL,
    value: entry.posterUrl,
    // 写前身份校验：Excel 被外部改过（插行/排序）时按旧行号写会覆盖别的番剧
    expectedTitle: entry.excelTitleSnapshot ?? entry.title,
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

/**
 * 批量将所有番剧的海报 URL 写入 Excel（一次 API 调用）。
 *
 * ⚠️ 必须带 `expectedTitle`：这是**整个文件里唯一按裸行号写入的路径**，
 * 而它一次要写上百行。一旦用户在 Excel/WPS 里插过行或排过序，
 * 行号就全错位了，会把 A 番的海报写到 B 番身上 —— 且没有任何提示。
 * 带上标题后，服务端会逐行核对，不一致就整批拒绝（409）。
 */
export async function batchSaveAllPosters(entries: AnimeEntry[]): Promise<number> {
  const allUpdates: ExcelUpdate[] = [];
  for (const entry of entries) {
    if (entry.excelRowIndex === undefined || !isWritablePosterUrl(entry.posterUrl)) continue;
    allUpdates.push({
      sheetName: MAIN_SHEET,
      rowIndex: entry.excelRowIndex,
      colIndex: EXCEL_COL.POSTER_URL,
      value: entry.posterUrl,
      expectedTitle: entry.excelTitleSnapshot ?? entry.title,
    });
  }
  if (allUpdates.length === 0) return 0;

  const response = await fetch(`${API_BASE}/write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(allUpdates),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as
      | { error?: string; conflicts?: { rowIndex: number; expected: string; actual: string; ambiguous?: boolean }[] }
      | null;
    if (response.status === 409 && body?.conflicts?.length) {
      const c = body.conflicts[0];
      throw new Error(
        c.ambiguous
          ? `表中有多行标题都是「${c.expected}」，无法确定该写哪一行 —— 请刷新页面后重试（本次未写入任何数据）。`
          : `Excel 中第 ${c.rowIndex + 1} 行现在是「${c.actual || '(空)'}」，不是「${c.expected}」。` +
            `Excel 可能被外部改过 —— 请刷新页面后重试（本次未写入任何数据）。`,
      );
    }
    throw new Error(body?.error || `HTTP ${response.status}`);
  }
  const data = await response.json();
  if (data.error) throw new Error(data.error);
  return allUpdates.length;
}

/**
 * 「数据补全」的字段补丁。
 *
 * 刻意**只写明确列出的列**，而不是把整条 AnimeEntry 全量回写：
 * 补全是一次额外的批量操作，不该顺带改动用户自己的评分 / 评价 / 标签 / 备注。
 * 每个字段都是可选的 —— 只补用户勾选的那些，其余数据一概不碰。
 */
export interface CompletionPatch {
  entry: AnimeEntry;
  /** 已下载到本地的海报 URL（必须是本地 /api/images/file 地址） */
  posterUrl?: string;
  releaseDate?: string;
  episodes?: number;
  studio?: string;
  /**
   * ⚠️ 只允许来自 Bangumi 的评分。
   * B 站的 9.9 分和 Bangumi 的 8.3 分是两套完全不同的评分体系，
   * 把 B 站评分写进「BGM」列就是脏数据。
   */
  bangumiScore?: number;
  link?: string;
  /**
   * 修正「检索名」列（A）。仅在用户显式勾选「顺便修正检索名」时提供。
   * 实测该列存在既有错位（190 条里 23 个检索名被多条复用，例如
   * 「利兹与青鸟」的检索名是 トニカクカワイイ），所以修正是有价值的，
   * 但它属于覆盖已有数据，必须由用户主动开启，默认绝不做。
   */
  searchAlias?: string;
}

/**
 * 批量写入补全结果（一次 HTTP 调用）。
 * 服务器端仍会做写前身份校验（expectedTitle）与单元格长度守卫；
 * 任一行冲突则整批拒绝，不会写一半。
 */
export async function applyCompletionPatches(patches: CompletionPatch[]): Promise<number> {
  const updates: ExcelUpdate[] = [];
  for (const patch of patches) {
    const { entry } = patch;
    if (entry.excelRowIndex === undefined) continue;
    const expectedTitle = entry.excelTitleSnapshot ?? entry.title;
    const rowIndex = entry.excelRowIndex;
    const push = (colIndex: number, value: string | number) => {
      updates.push({ sheetName: MAIN_SHEET, rowIndex, colIndex, value, expectedTitle });
    };

    if (patch.posterUrl && isWritablePosterUrl(patch.posterUrl)) push(EXCEL_COL.POSTER_URL, patch.posterUrl);
    if (patch.releaseDate) push(EXCEL_COL.RELEASE_DATE, patch.releaseDate);
    if (patch.episodes !== undefined && patch.episodes > 0) push(EXCEL_COL.EPISODES, patch.episodes);
    if (patch.studio) push(EXCEL_COL.STUDIO, patch.studio);
    if (patch.bangumiScore !== undefined) push(EXCEL_COL.BGM_SCORE, round2(patch.bangumiScore));
    if (patch.link) push(EXCEL_COL.LINK, patch.link);
    if (patch.searchAlias) push(EXCEL_COL.SEARCH_ALIAS, patch.searchAlias);
  }
  if (updates.length === 0) return 0;

  const response = await fetch(`${API_BASE}/write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as
      | { error?: string; conflicts?: { rowIndex: number; expected: string; actual: string; ambiguous?: boolean }[] }
      | null;
    if (response.status === 409 && body?.conflicts?.length) {
      const c = body.conflicts[0];
      throw new Error(
        c.ambiguous
          ? `表中有多行标题都是「${c.expected}」，无法确定该写哪一行 —— 请刷新页面后重试（本次未写入任何数据）。`
          : `Excel 中第 ${c.rowIndex + 1} 行现在是「${c.actual || '(空)'}」，不是「${c.expected}」。` +
            `请刷新页面后重试（本次未写入任何数据）。`,
      );
    }
    throw new Error(body?.error || `HTTP ${response.status}`);
  }
  const data = await response.json();
  if (data.error) throw new Error(data.error);
  return updates.length;
}

/** 将 AnimeEntry 转为 Excel 行数据（colIndex → value 映射，用于追加新行） */
function mapAnimeToRow(entry: AnimeEntry): Record<number, string | number> {
  const row: Record<number, string | number> = {};
  row[EXCEL_COL.TITLE] = entry.title;
  row[EXCEL_COL.SEARCH_ALIAS] = entry.searchAlias || '';
  row[EXCEL_COL.STUDIO] = entry.studio || '';
  row[EXCEL_COL.REVIEW] = entry.review || '';
  row[EXCEL_COL.RELEASE_DATE] = entry.releaseDate || '';
  row[EXCEL_COL.BGM_SCORE] = entry.bangumiScore ? round2(entry.bangumiScore) : '';
  row[EXCEL_COL.TAG] = entry.tags.map((t) => t.name).join('/');
  row[EXCEL_COL.LINK] = entry.link || '';
  // 海报持久化（角色卡继承番剧海报需在重载后保留）；base64 data URL 不写，见 isWritablePosterUrl
  if (isWritablePosterUrl(entry.posterUrl)) row[EXCEL_COL.POSTER_URL] = entry.posterUrl;
  row[EXCEL_COL.EPISODES] = entry.episodes ?? '';
  row[EXCEL_COL.CURRENT_EP] = entry.currentEpisode ?? '';
  // 补全原先漏写的字段：新建条目首次保存走 append，
  // 少写这些会导致"只保存一次就刷新"时丢掉备注/首刷时间/AniList 评分/张数/角色
  row[EXCEL_COL.NOTES] = entry.notes || '';
  row[EXCEL_COL.ANILIST_SCORE] = entry.aniListScore ? round2(entry.aniListScore) : '';
  row[EXCEL_COL.FRAME_COUNT] = entry.frameCount ? round2(entry.frameCount) : '';
  if (entry.watchDate) {
    const serial = dateToExcelSerial(entry.watchDate);
    if (serial > 0) row[EXCEL_COL.WATCH_DATE] = serial;
  }
  [EXCEL_COL.CHAR1_NAME, EXCEL_COL.CHAR2_NAME, EXCEL_COL.CHAR3_NAME, EXCEL_COL.CHAR4_NAME]
    .forEach((col, i) => { if (entry.characters?.[i]) row[col] = entry.characters[i]; });

  // 默认模板的评分写入对应列
  for (const s of entry.scores) {
    const col = DIMENSION_COL_MAP[s.dimensionKey];
    if (col !== undefined) row[col] = round2(s.score);
  }

  // 非默认模板：序列化评分 + 自定义字段到 JSON 列
  if (entry.templateId && entry.templateId !== DEFAULT_TEMPLATE_ID) {
    row[EXCEL_COL.TEMPLATE_JSON] = JSON.stringify({
      scores: entry.scores.map((s) => ({ ...s, score: round2(s.score) })),
      customFields: entry.customFields,
    });
  }
  if (entry.templateId) {
    row[EXCEL_COL.TEMPLATE_ID] = entry.templateId;
  }

  return row;
}

/** 追加新条目到 Excel 末尾，返回分配的行号 */
export async function appendAnimeEntry(entry: AnimeEntry): Promise<number> {
  const row = mapAnimeToRow(entry);
  const response = await fetch(`${API_BASE}/append`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sheetName: MAIN_SHEET, row }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: '请求失败' }));
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  const data = await response.json();
  if (data.error) throw new Error(data.error);
  return data.rowIndex as number;
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
    const body = await response.json().catch(() => null) as
      | { error?: string; conflicts?: { rowIndex: number; expected: string; actual: string; ambiguous?: boolean }[] }
      | null;
    // 409：写前身份校验失败 —— Excel 在外部被改过，按旧行号写会覆盖别的番剧
    if (response.status === 409 && body?.conflicts?.length) {
      const c = body.conflicts[0];
      throw new Error(
        c.ambiguous
          ? `表中有多行标题都是「${c.expected}」，无法确定该写哪一行 —— 请刷新页面后重试（本次未写入任何数据）。`
          : `Excel 中第 ${c.rowIndex + 1} 行现在是「${c.actual || '(空)'}」，不是「${c.expected}」。` +
            `这一行可能被改过标题或删除了 —— 请刷新页面后重试（本次未写入任何数据）。`,
      );
    }
    throw new Error(body?.error || `HTTP ${response.status}`);
  }

  const data = await response.json();
  if (data.error) {
    throw new Error(data.error);
  }
}

/**
 * 只写角色名列（AA/AD/AG/AJ），其余列一律不碰。
 *
 * 为什么不用 updateAnimeEntry 代替：那条路径会把整行按内存值写回，
 * 包括 posterUrl —— 而内存里的 posterUrl 可能来自 IndexedDB 覆盖或本次会话的
 * 自动搜图。为了补一个角色名却顺手改了海报、评价、评分，风险不成比例。
 * 角色名在 Excel 里就是固定的 4 列，这里只写这 4 列，并带上写前身份校验。
 */
export async function saveCharacterNames(entry: AnimeEntry, names: string[]): Promise<void> {
  const rowIndex = entry.excelRowIndex;
  if (rowIndex === undefined) throw new Error('该条目还没有 Excel 行号，无法写入');
  const expectedTitle = entry.excelTitleSnapshot ?? entry.title;
  const charCols = [EXCEL_COL.CHAR1_NAME, EXCEL_COL.CHAR2_NAME, EXCEL_COL.CHAR3_NAME, EXCEL_COL.CHAR4_NAME];
  const updates = charCols.map((colIndex, i) => ({
    sheetName: MAIN_SHEET,
    rowIndex,
    colIndex,
    value: names[i] ?? '',
    expectedTitle,
  }));

  const response = await fetch(`${API_BASE}/write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null) as
      | { error?: string; conflicts?: { rowIndex: number; expected: string; actual: string; ambiguous?: boolean }[] }
      | null;
    if (response.status === 409 && body?.conflicts?.length) {
      const c = body.conflicts[0];
      throw new Error(
        c.ambiguous
          ? `表中有多行标题都是「${c.expected}」，无法确定该写哪一行 —— 请刷新页面后重试（本次未写入任何数据）。`
          : `Excel 中第 ${c.rowIndex + 1} 行现在是「${c.actual || '(空)'}」，不是「${c.expected}」。` +
            `这一行可能被改过标题或删除了 —— 请刷新页面后重试（本次未写入任何数据）。`,
      );
    }
    throw new Error(body?.error || `HTTP ${response.status}`);
  }

  const data = await response.json();
  if (data.error) throw new Error(data.error);
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
/**
 * 海报搜索：按「检索名 → 日文名 → 中文标题」依次尝试 AniList
 *
 * 只用中文译名命中率很低（"白箱"在 AniList 里叫 SHIROBAKO、"超时空辉夜姬"也搜不到），
 * 而项目里的「检索名」列本来就是为搜索准备的，所以优先用它。
 * 返回命中的关键词与条目名，便于界面让人工核对后再决定是否采用。
 */
export interface PosterSearchResult {
  posterUrl: string;
  /** 实际命中的搜索词 */
  matchedKeyword: string;
  /** AniList 返回的条目名（供人工核对） */
  matchedName: string;
}

export async function searchPoster(...keywords: (string | undefined)[]): Promise<PosterSearchResult> {
  const candidates: string[] = [];
  for (const raw of keywords) {
    const k = String(raw || '').trim();
    if (k && !candidates.includes(k)) candidates.push(k);
  }

  for (const kw of candidates) {
    try {
      const resp = await fetch(`/api/anilist/search?keyword=${encodeURIComponent(kw)}`);
      if (!resp.ok) continue;
      const data = await resp.json();
      const item = data?.list?.[0];
      const url = item?.images?.large || '';
      if (url) {
        return { posterUrl: url, matchedKeyword: kw, matchedName: String(item?.name || '') };
      }
    } catch { /* 该关键词失败，试下一个 */ }
  }
  return { posterUrl: '', matchedKeyword: '', matchedName: '' };
}

/**
 * 懒加载海报：对单个番剧搜索 AniList，返回海报 URL（空字符串=没找到）
 * @param title 中文标题（兜底关键词）
 * @param aliases 更精确的关键词（检索名、日文名），按优先级传入
 */
export async function fetchPoster(title: string, aliases: string[] = []): Promise<string> {
  const result = await searchPoster(...aliases, title);
  return result.posterUrl;
}

// 说明：原先这里有一个 getMockAnimeList() 降级数据，已删除。
// 原因：它的条目带 excelRowIndex: 1/2，一旦读取失败（文件被占用/不存在），
// 界面会展示这些假番剧，而用户的一次保存就会按行号覆盖真实文件的前两行。
// 现在读取失败直接抛错，由 App 的错误页提示重试。
