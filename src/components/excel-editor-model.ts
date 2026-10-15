/**
 * 表格视图的数据层 —— 列定义、读值、把编辑应用到条目上。
 *
 * 单独成模块的原因：这块逻辑（哪些列可写、值怎么转换）是**能用单测锁住的**，
 * 而组件本身（antd Table 渲染）不适合单测。组件只管画，规则都在这里。
 *
 * ── 可写列的边界 ──
 *
 * 列分成两类，依据是项目里的 `EDITABLE_COLS` 白名单（excel-service 只写这些列）：
 *
 *   editable: true   写回走 updateAnimeEntry → mapAnimeToUpdates，受白名单保护
 *   editable: false  只读展示。包括：
 *                     - 公式列（赋分 C / 内容 J / 偏差值 U / 较客观评分 Y）：
 *                       写进去会被 Excel 重算覆盖，看着像"改了没生效"
 *                     - 爬虫BGM(V)
 *                     - 「列1」(T) 和「代餐」(X)：用户自己的列，代码注释明确「绝不写入」
 *                     - 总评(D)：权重 0 的计算列，由其余维度加权得出
 */
import type { AnimeEntry, AnimeCategory } from '../types';
import { CATEGORY_CONFIG, DEFAULT_TEMPLATE_ID } from '../types';
import { EXCEL_COL, DIMENSION_COL_MAP } from '../../features/anime-data/excel-mapping';
import { fmt2, round2 } from '../../core/math';

/** 一列的静态定义 */
export interface TableColumnDef {
  /** 唯一 id（也是编辑键 / Excel 列号或字段名） */
  id: string;
  /** 表头显示名 */
  label: string;
  /** 列宽（px） */
  width: number;
  /** 能不能编辑 */
  editable: boolean;
  /** 值类型，决定用哪种输入控件 */
  kind: 'text' | 'number' | 'score' | 'tags' | 'longtext' | 'readonly';
  /** 只读列的原因（显示在表头 tooltip 里，用户才知道为什么点不动） */
  readonlyReason?: string;
  /** 数值列的取值范围 */
  min?: number;
  max?: number;
  step?: number;
}

/** 只读原因文案 */
const R_FORMULA = 'Excel 公式列：写进去会被公式重算覆盖，所以只读';
const R_USER = '你自己的列，程序只读、绝不写入';
const R_CRAWL = '爬虫写入的列，改这里没意义';
const R_COMPUTED = '由其余维度加权计算得出，不能直接改';

/** 默认模板的评分维度（顺序 = 表格里的显示顺序） */
const SCORE_DIMS: Array<{ key: string; label: string }> = [
  { key: 'audio', label: '音' },
  { key: 'production', label: '制作' },
  { key: 'animation', label: '作画' },
  { key: 'immersion', label: '沉浸感' },
  { key: 'plot', label: '剧情' },
  { key: 'character', label: '人设' },
  { key: 'depth', label: '深度' },
  { key: 'vibe', label: '电波' },
];

/** 可编辑列 + 只读列，按表格显示顺序 */
export const TABLE_COLUMNS: TableColumnDef[] = [
  { id: 'rowNumber', label: '行', width: 56, editable: false, kind: 'readonly', readonlyReason: 'Excel 行号，程序用来定位写回' },
  { id: 'title', label: '名字', width: 200, editable: true, kind: 'text' },
  { id: 'searchAlias', label: '检索名', width: 180, editable: true, kind: 'text' },
  { id: 'category', label: '状态', width: 72, editable: false, kind: 'readonly', readonlyReason: '分类不存 Excel，改它请用卡片上的分类按钮' },
  { id: 'studio', label: '制作组', width: 120, editable: true, kind: 'text' },
  { id: 'releaseDate', label: '上映年月', width: 96, editable: true, kind: 'text' },
  { id: 'watchDate', label: '首刷时间', width: 108, editable: true, kind: 'text' },
  { id: 'frameCount', label: '张数', width: 72, editable: true, kind: 'number', min: 0, step: 0.1 },
  ...SCORE_DIMS.map((d) => ({
    id: d.key, label: d.label, width: 68, editable: true, kind: 'score' as const, min: 0, max: 15, step: 0.1,
  })),
  { id: 'overall', label: '总评', width: 68, editable: false, kind: 'readonly', readonlyReason: R_COMPUTED },
  { id: 'assignedScore', label: '赋分', width: 72, editable: false, kind: 'readonly', readonlyReason: R_FORMULA },
  { id: 'content', label: '内容', width: 72, editable: false, kind: 'readonly', readonlyReason: R_FORMULA },
  { id: 'deviation', label: '偏差值', width: 72, editable: false, kind: 'readonly', readonlyReason: R_FORMULA },
  { id: 'objectiveScore', label: '较客观评分', width: 96, editable: false, kind: 'readonly', readonlyReason: R_FORMULA },
  { id: 'crawledBgm', label: '爬虫BGM', width: 84, editable: false, kind: 'readonly', readonlyReason: R_CRAWL },
  { id: 'col1', label: '列1', width: 72, editable: false, kind: 'readonly', readonlyReason: R_USER },
  { id: 'substitute', label: '代餐', width: 96, editable: false, kind: 'readonly', readonlyReason: R_USER },
  { id: 'bangumiScore', label: 'BGM', width: 72, editable: true, kind: 'score', min: 0, max: 10, step: 0.1 },
  { id: 'aniListScore', label: 'AniList', width: 80, editable: true, kind: 'score', min: 0, max: 10, step: 0.1 },
  { id: 'episodes', label: '总集数', width: 72, editable: true, kind: 'number', min: 0, step: 1 },
  { id: 'currentEpisode', label: '当前集', width: 72, editable: true, kind: 'number', min: 0, step: 1 },
  { id: 'tag', label: 'tag', width: 180, editable: true, kind: 'tags' },
  { id: 'review', label: '评价', width: 260, editable: true, kind: 'longtext' },
  { id: 'notes', label: '备注', width: 180, editable: true, kind: 'longtext' },
  { id: 'link', label: '链接', width: 200, editable: true, kind: 'text' },
];

/** 行号列（只读，不属于条目字段）的 id */
export const ROW_NUMBER_COL = 'rowNumber';
/** 分类列（只读，展示派生值）的 id */
export const CATEGORY_COL = 'category';

/** 只读列读值用的 Excel 列号（这些字段不存在于 AnimeEntry，只能从原始行取） */
const READONLY_COL_MAP: Record<string, number> = {
  overall: EXCEL_COL.OVERALL,
  assignedScore: EXCEL_COL.ASSIGNED_SCORE,
  content: EXCEL_COL.CONTENT,
  deviation: EXCEL_COL.DEVIATION,
  objectiveScore: EXCEL_COL.OBJECTIVE_SCORE,
  crawledBgm: EXCEL_COL.CRAWLED_BGM,
  col1: EXCEL_COL.COL1,
  substitute: EXCEL_COL.SUBSTITUTE,
};

/** 表格行：一个条目 + 它对应的原始行 + 本地未保存的编辑 */
export interface EditorRow {
  /** 条目 id（excel-N） */
  id: string;
  entry: AnimeEntry;
  /** 原始 Excel 行（下标 = excelRowIndex），可能为 undefined（内存条目） */
  raw?: unknown[];
  /** 本地已改但还没写回 Excel 的字段 */
  edits: Record<string, string | number | undefined>;
}

/**
 * 列的值类型是不是「数字」。
 *
 * 注意 kind 为 readonly 的列本身不带语义（公式列也是数字），所以调用方
 * 判断数字列要用这个函数，而不是看 kind === 'readonly'。
 */
export function isNumericCol(col: TableColumnDef): boolean {
  // 「行」是唯一装数字的只读列（Excel 行号），其余只读列按下面的规则判定
  if (col.id === ROW_NUMBER_COL) return true;
  if (col.kind === 'number' || col.kind === 'score') return true;
  // 只读且不是状态 → 数字（赋分/内容/偏差值/较客观评分/爬虫BGM/总评）
  return col.kind === 'readonly' && col.id !== CATEGORY_COL;
}

/**
 * 显示值：优先本地编辑，其次条目 / 原始行。
 *
 * 三种列的取值来源不同，顺序不能混：
 *   1. 公式列（赋分/内容/偏差值/较客观评分/爬虫BGM）—— **只存在于原始行**，
 *      AnimeEntry 里根本没有这些字段，必须直接读原始行
 *   2. 用户自有列（列1/代餐）—— 同上，只有原始行有
 *   3. 其余列 —— 条目里有就在条目里（可能含未保存的编辑），没有才回退原始行
 *
 * 数字列一律收敛到**最多两位小数**（round2 后转字符串，所以 9.6 不会变 9.60）。
 * 原始 Excel 里的公式列带浮点噪声（10.265625000000009），不收敛的话表格里全是尾数。
 */
export function displayValue(row: EditorRow, col: TableColumnDef): string {
  const numeric = isNumericCol(col);
  const cast = (v: unknown): string => {
    if (v === undefined || v === null) return '';
    if (numeric) {
      const n = typeof v === 'number' ? v : Number(v);
      // ⚠️ 转不成数字时（例如「内容」列在这一行是 `=IF(...)` 公式串）原样显示。
      //    直接交给 fmt2 会返回空串，等于让公式单元格凭空消失。
      if (Number.isFinite(n)) return fmt2(n);
      return String(v);
    }
    return String(v);
  };
  // 本地暂存的编辑优先（公式列不会有编辑，因为它们不可编辑）
  if (Object.prototype.hasOwnProperty.call(row.edits, col.id)) return cast(row.edits[col.id]);

  const fromRaw = (): string => {
    const colIdx = READONLY_COL_MAP[col.id];
    if (colIdx === undefined || !row.raw) return '';
    const v = row.raw[colIdx];
    if (v === undefined || v === null || v === '') return '';
    const text = cast(v);
    // 公式列可能解析成写死的公式串，展示时截断，避免撑爆单元格
    return text.length > 24 ? text.slice(0, 24) + '…' : text;
  };

  // 公式列 / 用户自有列：条目里没有对应字段，只能读原始行
  if (READONLY_COL_MAP[col.id] !== undefined) return fromRaw();

  const fromEntry = entryValue(row.entry, col.id);
  if (fromEntry !== undefined && fromEntry !== null && fromEntry !== '') return cast(fromEntry);
  return fromRaw();
}

/** 从条目取某列的显示值（只处理条目里真的有的字段） */
function entryValue(entry: AnimeEntry, colId: string): string | number | undefined {
  switch (colId) {
    case 'title': return entry.title;
    case 'searchAlias': return entry.searchAlias;
    case 'studio': return entry.studio;
    case 'releaseDate': return entry.releaseDate;
    case 'watchDate': return entry.watchDate || '';
    case 'frameCount': return entry.frameCount;
    case 'bangumiScore': return entry.bangumiScore;
    case 'aniListScore': return entry.aniListScore;
    case 'episodes': return entry.episodes;
    case 'currentEpisode': return entry.currentEpisode;
    case 'tag': return entry.tags.map((t) => t.name).join('/');
    case 'review': return entry.review;
    case 'notes': return entry.notes;
    case 'link': return entry.link;
    case ROW_NUMBER_COL: return entry.excelRowIndex !== undefined ? entry.excelRowIndex + 1 : '';
    case CATEGORY_COL: return CATEGORY_CONFIG[entry.category as AnimeCategory]?.label ?? entry.category;
    default: break;
  }
  if (DIMENSION_COL_MAP[colId] !== undefined) {
    return entry.scores.find((s) => s.dimensionKey === colId)?.score;
  }
  return undefined;
}

/** 输入框里的字符串 → 该列该存的值（数值列返回 number | undefined） */
export function parseInput(col: TableColumnDef, raw: string): string | number | undefined {
  const text = String(raw ?? '').trim();
  if (text === '') return col.kind === 'text' || col.kind === 'longtext' || col.kind === 'tags' || col.kind === 'readonly'
    ? ''
    : undefined;
  if (col.kind === 'number' || col.kind === 'score') {
    const n = Number(text);
    if (!Number.isFinite(n)) return undefined;
    // 手输入也收敛到两位：否则用户填 3.14159 就写进 Excel 了，与"全部两位"的口径不一致
    return round2(n);
  }
  return text;
}

/**
 * 把某一行的本地编辑合并进条目，返回新条目。
 *
 * 注意 excelTitleSnapshot 不动：它保存的是**加载时**的标题，写回校验要靠它，
 * 由 handleSaveAnime 在保存成功后负责刷新。
 */
export function applyEdits(entry: AnimeEntry, edits: Record<string, string | number | undefined>): AnimeEntry {
  const next: AnimeEntry = { ...entry, scores: entry.scores.map((s) => ({ ...s })), tags: [...entry.tags] };
  for (const [colId, value] of Object.entries(edits)) {
    switch (colId) {
      case 'title': next.title = String(value ?? ''); break;
      case 'searchAlias': next.searchAlias = value === undefined ? undefined : String(value); break;
      case 'studio': next.studio = value === undefined ? undefined : String(value); break;
      case 'releaseDate': next.releaseDate = value === undefined ? undefined : String(value); break;
      case 'watchDate': next.watchDate = value === undefined ? undefined : String(value); break;
      case 'review': next.review = value === undefined ? undefined : String(value); break;
      case 'notes': next.notes = value === undefined ? undefined : String(value); break;
      case 'link': next.link = value === undefined ? undefined : String(value); break;
      case 'frameCount': next.frameCount = typeof value === 'number' ? value : undefined; break;
      case 'bangumiScore': next.bangumiScore = typeof value === 'number' ? value : undefined; break;
      case 'aniListScore': next.aniListScore = typeof value === 'number' ? value : undefined; break;
      case 'episodes': next.episodes = typeof value === 'number' ? value : undefined; break;
      case 'currentEpisode': next.currentEpisode = typeof value === 'number' ? value : undefined; break;
      case 'tag': {
        const names = String(value ?? '').split('/').map((n) => n.trim()).filter(Boolean);
        next.tags = names.map((name) => ({ name, highlighted: false }));
        break;
      }
      default: {
        // 评分维度
        const dim = SCORE_DIMS.find((d) => d.key === colId);
        if (!dim) break;
        const score = typeof value === 'number' ? value : undefined;
        next.scores = next.scores.filter((s) => s.dimensionKey !== colId);
        if (score !== undefined && score > 0) next.scores.push({ dimensionKey: colId, score });
        break;
      }
    }
  }
  return next;
}

/** 一行有没有未保存的编辑 */
export function isDirty(row: EditorRow): boolean {
  return Object.keys(row.edits).length > 0;
}

/** 排序方向 */
export type SortOrder = 'ascend' | 'descend';

/**
 * 取某列的可排比值。
 * 数字列返回 number；文本列返回归一化字符串（去首尾空白 + 转小写，
 * 这样「Angel Beats!」和「angel beats!」不会因为大小写被分成两组）。
 */
function sortableValue(row: EditorRow, col: TableColumnDef): number | string {
  const text = displayValue(row, col).trim();
  if (isNumericCol(col)) {
    // ⚠️ 必须先判空串：Number('') === 0，不判的话"没填的"会被当成 0 排到最前面
    if (text === '') return NaN;
    const n = Number(text);
    return Number.isFinite(n) ? n : NaN;
  }
  // 空占位符「—」不参与排序，按空处理
  return text === '—' ? '' : text.toLowerCase();
}

/** 值是空的吗（数字 NaN 算空；字符串 '' 算空） */
function isBlank(v: number | string): boolean {
  return typeof v === 'number' ? !Number.isFinite(v) : v === '';
}

/**
 * 按某列排序（返回新数组，不改原数组）。
 *
 * 约定：**空值永远排在最后**，升序降序都一样 —— 表格里把「没填的」混在最大/最小
 * 那一端会让人以为它是有意义的极值。
 *
 * 文本用 localeCompare('zh')，中日文和英文混排时按本地规则，比 charCode 靠谱。
 */
export function sortEditorRows(rows: EditorRow[], colId: string, order: SortOrder): EditorRow[] {
  const col = TABLE_COLUMNS.find((c) => c.id === colId);
  if (!col) return rows;
  const dir = order === 'descend' ? -1 : 1;
  // 带上原下标做稳定排序的兜底（等值行的相对顺序不变）
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const av = sortableValue(a.row, col);
      const bv = sortableValue(b.row, col);
      const aBlank = isBlank(av);
      const bBlank = isBlank(bv);
      if (aBlank && bBlank) return a.index - b.index;
      if (aBlank) return 1;
      if (bBlank) return -1;
      let cmp: number;
      if (typeof av === 'number' && typeof bv === 'number') {
        cmp = av - bv;
      } else {
        cmp = String(av).localeCompare(String(bv), 'zh');
      }
      if (cmp !== 0) return cmp * dir;
      return a.index - b.index;
    })
    .map((x) => x.row);
}

/** 把原始行 + 条目列表拼成表格行（只保留默认模板的条目，其余类型不在这张表里） */
export function buildRows(entries: AnimeEntry[], rawRows: unknown[][] | undefined): EditorRow[] {
  return entries
    .filter((e) => !e.templateId || e.templateId === DEFAULT_TEMPLATE_ID)
    .map((entry) => ({
      id: entry.id,
      entry,
      raw: entry.excelRowIndex !== undefined ? rawRows?.[entry.excelRowIndex] : undefined,
      edits: {},
    }));
}
