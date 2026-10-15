/**
 * Excel 导出 / 导入（面向人看的表格式）
 *
 * ── 为什么需要这个模块 ──
 *
 * 原来的「导出 Excel」是把内存里的 AnimeEntry 按**内部存储列序**（43 列）平铺成一张表：
 *
 *   1. 番剧、角色卡、自定义模板的记录全混在同一个「番剧列表」里，靠列空不空去猜类型；
 *   2. 非默认模板（角色卡/自定义模板）的分只存在于「模板JSON」列里，
 *      普通评分列是空的 —— 导出来就是一堆看不懂的 JSON 字符串；
 *   3. 不同模板的维度被硬塞进「音/制作/作画/剧情」同一组列，量纲都不一样
 *      （实测「制作」列里既有 4.5 也有 15，15 是游戏模板的分），数字串味；
 *   4. 列名里「列1/人设4/造型2」这种内部占位列直接暴露给用户；
 *   5. 源表里名字为空的行（程序加载时静默丢弃）会原样带出去。
 *
 * 现在的做法：**按记录类型分表，每张表只放自己有效的列，分和自定义字段都拆成真列。**
 * 同时做到「导出 ↑ 导入」闭环 —— `parseTransferWorkbook` 能把导出的文件读回内部 43 列格式，
 * 所以「导入 Excel」既能吃新格式，也继续吃旧格式。
 */
import * as XLSX from 'xlsx';
import type { DimensionScore, ScoreTemplate } from '../../src/types';
import { DEFAULT_TEMPLATE_ID, CHARACTER_TEMPLATE_ID, DEFAULT_DETAIL_LAYOUT } from '../../src/types';
import { EXCEL_COL, DIMENSION_COL_MAP } from './excel-mapping';
import { loadTemplates, saveTemplates } from './template-service';
// ⚠️ round2 必须用 core/math 这份权威实现。这里曾有过一份本地副本
//    （`Math.round(n*100)/100`，缺了抵消表示误差的 nudge），结果 8.325 这种
//    .5 边界值算出来比别处少 0.01 —— 又是一次"同一逻辑多份实现、口径漂移"。
import { round2 } from '../../core/math';

// ── 工作表名 ──

/** 默认模板（番剧）记录表 */
export const SHEET_ANIME = '番剧';
/** 角色卡记录表 */
export const SHEET_CHARACTER = '角色卡';
/** 源文件里名字为空、程序加载时会被丢弃的行 */
export const SHEET_ANOMALY = '异常行';
/** 旧版单表格式的工作表名（导入时仍要认） */
const LEGACY_SHEET = '番剧列表';

/** Excel 工作表名上限 31 字符 */
const SHEET_NAME_MAX = 31;
/** 自定义模板分表的表名前缀 */
const CUSTOM_SHEET_PREFIX = '模板_';
/** 自定义模板的自定义字段列前缀 */
const FIELD_COL_PREFIX = '字段_';
/** 模板里已删掉的旧维度列前缀 */
const STALE_DIM_PREFIX = '已废弃_';

// ── 默认（番剧）模板：维度 key → 导出列名 ──

/**
 * 这里**故意不复用 DIMENSION_COL_MAP 的列名**：那份映射是给内部列号用的，
 * 列名口径也不统一（vibe 在导出里叫「电波」，在别处有别的叫法）。
 * 导出面向人，统一用一套列名，导入按同一份定义回读。
 */
const DEFAULT_DIM_LABELS: Record<string, string> = {
  overall: '总评(观感)',
  audio: '音',
  production: '制作',
  animation: '作画',
  immersion: '沉浸感',
  plot: '剧情',
  character: '人设',
  depth: '深度',
  vibe: '电波',
};

/** 默认模板维度在导出表里的先后顺序 */
const DEFAULT_DIM_ORDER = [
  'overall', 'audio', 'production', 'animation', 'immersion', 'plot', 'character', 'depth', 'vibe',
];

/** 角色卡固定列：维度 key → 列名（与 createCharacterTemplate 的 v7 维度一致） */
const CHARACTER_DIM_LABELS: Record<string, string> = {
  overall: '总评',
  char_appearance: '角色设计',
  char_personality: '性格',
  char_voice: '声优',
  char_moe: '萌点电波',
  char_favor: '好感度',
};

/** 角色卡固定列顺序 */
const CHARACTER_DIM_ORDER = [
  'overall', 'char_appearance', 'char_personality', 'char_voice', 'char_moe', 'char_favor',
];

/** 角色卡自定义字段 key → 列名 */
const CHARACTER_FIELD_LABELS: Record<string, string> = {
  char_source: '所属作品',
  char_cv: '声优(CV)',
  char_birthday: '生日/属性',
  char_profile: '详细人设',
};

/** 角色卡自定义字段列顺序（详细人设排最后：正文上千字，放中间会把表撑得没法看） */
const CHARACTER_FIELD_ORDER = ['char_source', 'char_cv', 'char_birthday', 'char_profile'];

/** 番剧表特有列 */
const ANIME_ONLY_COLS = ['张数', 'tag', 'BGM', 'AniList', '角色1', '角色2', '角色3', '角色4'] as const;

/** 所有表都有的固定列（导入端据此把维度列/字段列区分出来） */
const COMMON_FIXED_COLS = new Set([
  '名字', '检索名', '制作组', '评价', '上映年月', '首刷时间', '备注', '链接',
  '总集数', '当前集', '海报URL', '状态',
]);

// ── 小工具 ──

function str(v: unknown): string {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

/** 取数字：空 → ''；非数字 → ''；0 → ''（内部口径：0 表示「没打分」） */
function num(v: unknown): number | '' {
  if (v === undefined || v === null || v === '') return '';
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return '';
  return n;
}

/** 取「可以为 0」的数字（总集数/当前集这种，0 本身没意义，一并归空） */
function numKeepZero(v: unknown): number | '' {
  if (v === undefined || v === null || v === '') return '';
  const n = Number(v);
  return Number.isFinite(n) ? n : '';
}

/** 日期归一：Excel 序列号 / Date / 字符串 → YYYY-MM-DD */
function toDateText(raw: unknown): string {
  if (raw === undefined || raw === null || raw === '') return '';
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const p = XLSX.SSF.parse_date_code(raw);
    if (!p) return '';
    const p2 = (n: number) => String(n).padStart(2, '0');
    return `${p.y}-${p2(p.m)}-${p2(p.d)}`;
  }
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return raw.toISOString().split('T')[0];
  }
  return String(raw).trim();
}

/** YYYY-MM-DD → Excel 序列号（首刷时间是日期列，写字符串会让公式算不出来） */
function dateToSerial(text: string): number | null {
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(String(text).trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!y || !mo || !d) return null;
  return Math.round((Date.UTC(y, mo - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
}

/** 生成一个不与已用名字冲突、且不超过 31 字符的工作表名 */
function safeSheetName(raw: string, used: Set<string>): string {
  const cleaned = String(raw || '未命名模板').replace(/[\\/?*[\]:]/g, '_').trim() || '未命名模板';
  const base = cleaned.length > SHEET_NAME_MAX ? cleaned.slice(0, SHEET_NAME_MAX) : cleaned;
  let name = base;
  let n = 2;
  while (used.has(name)) {
    const suffix = `(${n})`;
    name = base.slice(0, SHEET_NAME_MAX - suffix.length) + suffix;
    n++;
  }
  used.add(name);
  return name;
}

/** 解析 TEMPLATE_JSON（新格式 {scores,customFields} / 旧格式纯数组），坏的当没有 */
function parseTemplateJson(raw: unknown): {
  scores: Map<string, number>;
  customFields: Record<string, string | number>;
} {
  const scores = new Map<string, number>();
  let customFields: Record<string, string | number> = {};
  const text = str(raw);
  if (!text) return { scores, customFields };
  try {
    const parsed = JSON.parse(text);
    const list: DimensionScore[] = Array.isArray(parsed) ? parsed : (parsed?.scores ?? []);
    for (const s of list) {
      if (s && typeof s.score === 'number' && s.score > 0) scores.set(s.dimensionKey, round2(s.score));
    }
    if (!Array.isArray(parsed) && parsed?.customFields && typeof parsed.customFields === 'object') {
      customFields = parsed.customFields as Record<string, string | number>;
    }
  } catch { /* JSON 坏了就当没有，保底还能从列映射取分 */ }
  return { scores, customFields };
}

/** 源表一行里的默认维度分（列映射口径，与 mapRowToAnime 一致） */
function scoresFromColumns(row: unknown[]): Map<string, number> {
  const scores = new Map<string, number>();
  for (const [key, col] of Object.entries(DIMENSION_COL_MAP)) {
    const v = Number(row[col]);
    if (Number.isFinite(v) && v > 0) scores.set(key, round2(v));
  }
  return scores;
}

/**
 * 自定义字段的列名：`字段_<原key>`。
 *
 * 为什么用 key 而不是模板里的中文标签：列名必须能**唯一反查回原 key**，
 * 否则导入时对不上就静默丢数据。而「标签 → key」这一步在文件里不可逆
 * （模板定义不在导出文件里，用户的模板可能被改过）。字段 key 本身就是
 * 可读短名（char_cv / dim_note），所以直接用 key，前缀只用来跟维度列区分。
 */
function colOfField(key: string): string {
  return FIELD_COL_PREFIX + key;
}

/** 列名 → 原 key（导出端的逆运算） */
function fieldKeyOfCol(col: string): string {
  return col.slice(FIELD_COL_PREFIX.length);
}

/** 把 {列名: 值} 拼成 aoa */
function toAoa(headers: string[], records: Array<Record<string, string | number>>): (string | number)[][] {
  return [headers, ...records.map((rec) => headers.map((h) => rec[h] ?? ''))];
}

// ── 导出 ──

/** 源表一行按模板 ID 判定出的记录类型 */
type RowKind = 'anime' | 'character' | 'custom' | 'blank';

function classifyRow(row: unknown[]): { kind: RowKind; templateId: string } {
  const title = String(row[EXCEL_COL.TITLE] ?? '').trim();
  if (!title) return { kind: 'blank', templateId: '' };
  const templateId = String(row[EXCEL_COL.TEMPLATE_ID] ?? '').trim();
  if (!templateId || templateId === DEFAULT_TEMPLATE_ID) return { kind: 'anime', templateId: DEFAULT_TEMPLATE_ID };
  if (templateId === CHARACTER_TEMPLATE_ID) return { kind: 'character', templateId };
  return { kind: 'custom', templateId };
}

export interface BuildExportOptions {
  /** 源表全部行（含表头，来自 /api/excel/read 的「番剧列表」） */
  rows: unknown[][];
  /** localStorage 里的模板表；缺省时用 loadTemplates()。只用来取模板名与维度标签 */
  templates?: ScoreTemplate[];
  /** 界面上被隐藏/删除的条目 id（anime_diary_watching_deleted） */
  hiddenIds?: Set<string>;
}

interface Bucket {
  /** 1-based Excel 行号，写进「异常行」表方便用户回去清 */
  excelRow: number;
  row: unknown[];
  /** 与 mapRowToAnime 一致的 id，用来查隐藏集合 */
  entryId: string;
}

/** 扫描一批行里出现过、但已知维度集合里没有的 key，生成「已废弃_xxx」列名 */
function collectStaleDims(buckets: Bucket[], known: Set<string>): string[] {
  const stale = new Set<string>();
  for (const b of buckets) {
    for (const key of parseTemplateJson(b.row[EXCEL_COL.TEMPLATE_JSON]).scores.keys()) {
      if (!known.has(key)) stale.add(STALE_DIM_PREFIX + key);
    }
  }
  return [...stale];
}

/**
 * 组装导出工作簿（纯函数，便于单测）。
 *
 *   「番剧」        默认模板记录，分按维度拆成真列
 *   「角色卡」      角色记录，分 + 所属作品/CV/生日/详细人设 都拆成列
 *   「模板_<模板名>」每个自定义模板一张表，维度列名取模板里的中文标签
 *   「异常行」      源文件里名字为空、程序加载时会丢弃的行，附「丢弃原因」
 */
export function buildTransferWorkbook(opts: BuildExportOptions): XLSX.WorkBook {
  const { rows } = opts;
  const templates = opts.templates ?? loadTemplates();
  const hiddenIds = opts.hiddenIds ?? new Set<string>();
  const templateById = new Map(templates.map((t) => [t.id, t]));

  const anime: Bucket[] = [];
  const character: Bucket[] = [];
  const custom = new Map<string, Bucket[]>();
  const anomaly: { excelRow: number; title: string; templateId: string; reason: string }[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const cls = classifyRow(row);
    if (cls.kind === 'blank') {
      // 全空行整个丢掉；「只剩半截数据」的行才值得报出来
      const hasAny = row.some((v) => v !== '' && v !== undefined && v !== null);
      if (hasAny) {
        anomaly.push({
          excelRow: i + 1,
          title: String(row[EXCEL_COL.TITLE] ?? '').trim(),
          templateId: String(row[EXCEL_COL.TEMPLATE_ID] ?? '').trim(),
          reason: '名字列(B)为空，程序加载时会丢弃该行',
        });
      }
      continue;
    }
    const bucket: Bucket = { excelRow: i + 1, row, entryId: `excel-${i}` };
    if (cls.kind === 'anime') anime.push(bucket);
    else if (cls.kind === 'character') character.push(bucket);
    else {
      const list = custom.get(cls.templateId) ?? [];
      list.push(bucket);
      custom.set(cls.templateId, list);
    }
  }

  const wb = XLSX.utils.book_new();
  const used = new Set<string>([SHEET_ANIME, SHEET_CHARACTER, SHEET_ANOMALY, LEGACY_SHEET]);
  const hiddenMark = (b: Bucket) => (hiddenIds.has(b.entryId) ? '已删除(仅界面隐藏)' : '');

  /** 公共元信息列的值 */
  const metaOf = (row: unknown[]): Record<string, string | number> => ({
    检索名: str(row[EXCEL_COL.SEARCH_ALIAS]),
    制作组: str(row[EXCEL_COL.STUDIO]),
    评价: str(row[EXCEL_COL.REVIEW]),
    上映年月: str(row[EXCEL_COL.RELEASE_DATE]),
    首刷时间: toDateText(row[EXCEL_COL.FIRST_WATCH]),
    备注: str(row[EXCEL_COL.NOTES]),
    链接: str(row[EXCEL_COL.LINK]),
    总集数: numKeepZero(row[EXCEL_COL.EPISODES]),
    当前集: numKeepZero(row[EXCEL_COL.CURRENT_EP]),
    海报URL: str(row[EXCEL_COL.POSTER_URL]),
  });

  // ── 1) 番剧表 ──
  {
    const dimCols = DEFAULT_DIM_ORDER.map((k) => DEFAULT_DIM_LABELS[k]);
    const headers = [
      '名字', ...Object.keys(metaOf([])), ...ANIME_ONLY_COLS, ...dimCols, '状态',
    ];
    const records = anime.map((b) => {
      const r = b.row;
      const rec: Record<string, string | number> = { 名字: str(r[EXCEL_COL.TITLE]), ...metaOf(r) };
      rec['张数'] = numKeepZero(r[EXCEL_COL.FRAME_COUNT]);
      rec['tag'] = str(r[EXCEL_COL.TAG]);
      rec['BGM'] = numKeepZero(r[EXCEL_COL.BGM_SCORE]);
      rec['AniList'] = numKeepZero(r[EXCEL_COL.ANILIST_SCORE]);
      ['角色1', '角色2', '角色3', '角色4'].forEach((name, i) => {
        const col = [EXCEL_COL.CHAR1_NAME, EXCEL_COL.CHAR2_NAME, EXCEL_COL.CHAR3_NAME, EXCEL_COL.CHAR4_NAME][i];
        rec[name] = str(r[col]);
      });
      // 默认模板的分在独立列上；模板自身已废弃的维度（如果有）收进「已废弃_」
      const known = new Set(Object.keys(DEFAULT_DIM_LABELS));
      const json = parseTemplateJson(r[EXCEL_COL.TEMPLATE_JSON]);
      for (const [key, value] of scoresFromColumns(r)) {
        rec[DEFAULT_DIM_LABELS[key] ?? STALE_DIM_PREFIX + key] = value;
      }
      for (const [key, value] of json.scores) {
        if (!known.has(key)) rec[STALE_DIM_PREFIX + key] = value;
      }
      rec['状态'] = hiddenMark(b);
      return rec;
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(toAoa(headers, records)), SHEET_ANIME);
  }

  // ── 2) 角色卡表 ──
  {
    const known = new Set(CHARACTER_DIM_ORDER);
    const staleDims = collectStaleDims(character, known);
    const dimCols = CHARACTER_DIM_ORDER.map((k) => CHARACTER_DIM_LABELS[k]);
    // 内置字段按固定顺序在前，其余（模板里没有定义的旧字段）按 key 排在后面
    const extraFieldKeys = new Set<string>();
    for (const b of character) {
      for (const key of Object.keys(parseTemplateJson(b.row[EXCEL_COL.TEMPLATE_JSON]).customFields)) {
        if (!CHARACTER_FIELD_ORDER.includes(key)) extraFieldKeys.add(key);
      }
    }
    const fieldKeys = [...CHARACTER_FIELD_ORDER, ...extraFieldKeys];
    const fieldColOfKey = new Map(fieldKeys.map((k) => [k, colOfField(k)]));
    const profileCol = fieldColOfKey.get('char_profile') as string;
    // 详细人设放最后
    const fieldCols = fieldKeys.map((k) => fieldColOfKey.get(k) as string);
    const headers = [
      '名字', ...Object.keys(metaOf([])), ...dimCols, ...staleDims,
      ...fieldCols.filter((c) => c !== profileCol),
      profileCol, '状态',
    ];
    const records = character.map((b) => {
      const r = b.row;
      const rec: Record<string, string | number> = { 名字: str(r[EXCEL_COL.TITLE]), ...metaOf(r) };
      const json = parseTemplateJson(r[EXCEL_COL.TEMPLATE_JSON]);
      for (const [key, value] of json.scores) {
        rec[CHARACTER_DIM_LABELS[key] ?? STALE_DIM_PREFIX + key] = value;
      }
      for (const [key, value] of Object.entries(json.customFields)) {
        rec[fieldColOfKey.get(key) ?? FIELD_COL_PREFIX + key] = value;
      }
      rec['状态'] = hiddenMark(b);
      return rec;
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(toAoa(headers, records)), SHEET_CHARACTER);
  }

  // ── 3) 每个自定义模板一张表 ──
  for (const [templateId, buckets] of custom) {
    const tpl = templateById.get(templateId);
    const dims = tpl?.dimensions?.length ? [...tpl.dimensions] : [];
    const known = new Set(dims.map((d) => d.key));
    const staleDims = collectStaleDims(buckets, known);
    // 自定义字段：从数据里收集 key（模板可能已经不声明这个字段了），列名走 colOfField
    const fieldKeys = new Set<string>();
    for (const b of buckets) {
      for (const key of Object.keys(parseTemplateJson(b.row[EXCEL_COL.TEMPLATE_JSON]).customFields)) {
        fieldKeys.add(key);
      }
    }
    const fieldCols = [...fieldKeys].map((k) => colOfField(k));
    const keyByFieldCol = new Map([...fieldKeys].map((k) => [colOfField(k), k] as const));
    const labelByKey = new Map(dims.map((d) => [d.key, d.label]));

    const headers = [
      '模板名', '名字', ...Object.keys(metaOf([])), ...dims.map((d) => d.label), ...staleDims,
      ...fieldCols, '状态',
    ];
    const records = buckets.map((b) => {
      const r = b.row;
      const rec: Record<string, string | number> = {
        模板名: tpl?.name ?? templateId,
        名字: str(r[EXCEL_COL.TITLE]),
        ...metaOf(r),
      };
      const json = parseTemplateJson(r[EXCEL_COL.TEMPLATE_JSON]);
      for (const [key, value] of json.scores) {
        rec[labelByKey.get(key) ?? STALE_DIM_PREFIX + key] = value;
      }
      for (const col of fieldCols) {
        const key = keyByFieldCol.get(col);
        if (key && json.customFields[key] !== undefined) rec[col] = json.customFields[key];
      }
      rec['状态'] = hiddenMark(b);
      return rec;
    });
    const sheetName = safeSheetName(CUSTOM_SHEET_PREFIX + (tpl?.name || templateId), used);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(toAoa(headers, records)), sheetName);
  }

  // ── 4) 异常行（程序会丢弃的行，单独列出来让用户能清） ──
  {
    const headers = ['Excel行号', '名字(B列)', '模板ID', '丢弃原因'];
    const aoa: (string | number)[][] = [
      headers,
      ...anomaly.map((a) => [a.excelRow, a.title, a.templateId, a.reason]),
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), SHEET_ANOMALY);
  }

  return wb;
}

// ── D 列「综合(观感)」：按模板权重重建公式 + 刷新缓存值 ──

/**
 * 模板里有独立 Excel 列的维度 → 列字母。
 *
 * 只有这些维度能进 D 列公式（Excel 公式必须引用单元格）。默认模板的 8 个维度都在；
 * 自定义模板的维度（key 形如 `dim_玩法`）只存在于 TEMPLATE_JSON、没有独立列，无法参与。
 * `frameCount` 有列（G）但它不是评分维度（默认模板里 weight=0），会被权重过滤排除。
 */
const DIM_COL_LETTER: Record<string, string> = {
  audio: 'E',
  production: 'F',
  frameCount: 'G',
  animation: 'H',
  immersion: 'K',
  plot: 'L',
  character: 'M',
  depth: 'N',
  vibe: 'O',
};

/** 读某列的数值（公式单元格读缓存值），非正数一律当 0 */
function cellNumber(ws: XLSX.WorkSheet, colIdx: number, rowIndex: number): number {
  const addr = XLSX.utils.encode_cell({ c: colIdx, r: rowIndex });
  const cell = ws[addr] as XLSX.CellObject | undefined;
  if (!cell) return 0;
  const v = typeof cell.v === 'number' ? cell.v : Number(cell.v);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

export interface RebuildOverallResult {
  /** 重建了公式的行数 */
  rows: number;
  /** 缓存值被改动的行数 */
  changed: number;
  /** 参与公式的维度（标签 + 权重 + 列） */
  dims: { label: string; weight: number; col: string }[];
  /** 权重和（写进公式的分母） */
  weightSum: number;
}

/**
 * 按模板权重重建「综合(观感)」（D 列）的公式，并把缓存值刷成同一口径。
 *
 * ── 为什么需要它 ──
 *
 * D 列历史上是**手工写的另一套公式**（实测 `E*0.13+F*0.18+H*0.15+J*0.4+O*0.15`：
 * 只用了 5 个维度、其中「内容」还不在模板里），和应用里按模板算的加权根本不是一回事；
 * 而且 169 条里有 97 条连自己的公式重算都对不上缓存值。结果就是
 * 「同一部番，界面上一个总评、Excel 里另一个」。
 *
 * 统一成：**模板里权重 > 0 且能映射到独立列的维度，按模板权重重算**。
 * 写公式的同时写一份正确的缓存值 —— 应用读的是缓存值（`read` 默认不开 cellFormula），
 * Excel 打开后按公式自己重算，两边同源。
 *
 * ⚠️ 只处理**默认模板**的行（`模板ID` 为空或 `default`）。角色卡/自定义模板的维度
 * 没有独立列，公式无法表达，保持原状。
 */
export function rebuildOverallFormula(
  ws: XLSX.WorkSheet,
  options: { templates?: ScoreTemplate[]; sheetRows?: unknown[][] } = {},
): RebuildOverallResult {
  const templates = options.templates ?? loadTemplates();
  const tpl = templates.find((t) => t.isDefault) ?? templates.find((t) => t.id === DEFAULT_TEMPLATE_ID);
  const dims = (tpl?.dimensions ?? []).filter(
    (d) => d.key !== 'overall' && d.weight > 0 && DIM_COL_LETTER[d.key] !== undefined,
  );
  const result: RebuildOverallResult = {
    rows: 0,
    changed: 0,
    dims: dims.map((d) => ({ label: d.label, weight: d.weight, col: DIM_COL_LETTER[d.key] })),
    weightSum: round2(dims.reduce((a, d) => a + d.weight, 0)),
  };
  if (dims.length === 0) return result;

  const rowCount = options.sheetRows?.length
    ?? (ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']).e.r + 1 : 0);
  const weightSum = dims.reduce((a, d) => a + d.weight, 0);

  for (let r = 1; r < rowCount; r++) {
    const row = options.sheetRows?.[r];
    if (row) {
      const id = String(row[EXCEL_COL.TEMPLATE_ID] ?? '').trim();
      if (id && id !== DEFAULT_TEMPLATE_ID) continue; // 非默认模板不动
    }

    const scoreOf = (key: string): number => {
      const colIdx = DIMENSION_COL_MAP[key];
      if (colIdx === undefined) return 0;
      if (row) {
        const v = Number(row[colIdx]);
        return Number.isFinite(v) && v > 0 ? v : 0;
      }
      return cellNumber(ws, colIdx, r);
    };

    const terms = dims
      .filter((d) => scoreOf(d.key) > 0)
      .map((d) => ({ col: DIM_COL_LETTER[d.key], weight: d.weight, value: scoreOf(d.key) }));
    if (terms.length === 0) continue;

    /**
     * 分母**固定用模板权重和**（不是"只按已打分维度归一化"）。
     * 语义 = 没打分的维度按 0 计入。改 D 列口径这种事宁可可预期：分数补全后
     * 总评只会因为新分数而变，不会因为"归一化基数变了"而整体跳动。
     */
    const formula = `${terms.map((t) => `${t.col}${r + 1}*${t.weight}`).join('+')}/${round2(weightSum)}`;
    const value = round2(terms.reduce((a, t) => a + t.value * t.weight, 0) / weightSum);

    const addr = XLSX.utils.encode_cell({ c: EXCEL_COL.OVERALL, r });
    const existing = ws[addr] as XLSX.CellObject | undefined;
    const prev = existing && typeof existing.v === 'number' ? existing.v : undefined;
    if (existing) {
      existing.f = formula;
      existing.v = value;
      existing.t = 'n';
    } else {
      ws[addr] = { t: 'n', v: value, f: formula } as XLSX.CellObject;
    }
    result.rows++;
    if (prev === undefined || Math.abs(prev - value) > 0.0005) result.changed++;
  }
  return result;
}

// ── 导入：新格式 → 内部 43 列工作簿 ──

/** 内部 43 列表头（对应 EXCEL_COL，与 electron/excel-template.js 保持一致） */
const INTERNAL_HEADERS: string[] = (() => {
  const h: string[] = Array(43).fill('');
  const set = (col: number, name: string) => { h[col] = name; };
  set(EXCEL_COL.SEARCH_ALIAS, '检索名');
  set(EXCEL_COL.TITLE, '名字');
  set(EXCEL_COL.OVERALL, '综合(观感)');
  set(EXCEL_COL.AUDIO, '音');
  set(EXCEL_COL.PRODUCTION, '制作');
  set(EXCEL_COL.FRAME_COUNT, '张数');
  set(EXCEL_COL.ANIMATION, '作画');
  set(EXCEL_COL.STUDIO, '制作组');
  set(EXCEL_COL.CONTENT, '内容');
  set(EXCEL_COL.IMMERSION, '沉浸感');
  set(EXCEL_COL.PLOT, '剧情');
  set(EXCEL_COL.CHARACTER, '人设');
  set(EXCEL_COL.DEPTH, '深度');
  set(EXCEL_COL.VIBE, '电波');
  set(EXCEL_COL.REVIEW, '评价');
  set(EXCEL_COL.RELEASE_DATE, '上映年月');
  set(EXCEL_COL.FIRST_WATCH, '首刷时间');
  set(EXCEL_COL.NOTES, '备注');
  set(EXCEL_COL.COL1, '列1');
  set(EXCEL_COL.DEVIATION, '偏差值');
  set(EXCEL_COL.CRAWLED_BGM, '爬虫BGM');
  set(EXCEL_COL.BGM_SCORE, 'BGM');
  set(EXCEL_COL.SUBSTITUTE, '代餐');
  set(EXCEL_COL.OBJECTIVE_SCORE, '较客观评分');
  set(EXCEL_COL.TAG, 'tag');
  set(EXCEL_COL.CHAR1_NAME, '角色1');
  set(EXCEL_COL.CHAR1_DESIGN, '人设4');
  set(EXCEL_COL.CHAR1_STYLE, '造型');
  set(EXCEL_COL.CHAR2_NAME, '角色2');
  set(EXCEL_COL.CHAR2_DESIGN, '人设2');
  set(EXCEL_COL.CHAR2_STYLE, '造型2');
  set(EXCEL_COL.CHAR3_NAME, '角色3');
  set(EXCEL_COL.CHAR3_DESIGN, '人设3');
  set(EXCEL_COL.CHAR3_STYLE, '造型3');
  set(EXCEL_COL.CHAR4_NAME, '角色4');
  set(EXCEL_COL.ANILIST_SCORE, 'AniList评分');
  set(EXCEL_COL.POSTER_URL, '海报URL');
  set(EXCEL_COL.TEMPLATE_ID, '模板ID');
  set(EXCEL_COL.LINK, '链接');
  set(EXCEL_COL.EPISODES, '总集数');
  set(EXCEL_COL.CURRENT_EP, '当前集');
  set(EXCEL_COL.TEMPLATE_JSON, '模板JSON');
  return h;
})();

export interface ParsedTransfer {
  /** 内部 43 列格式的工作簿，可直接落盘替换数据源 */
  workbook: XLSX.WorkBook;
  /** 识别到的数据行数（不含表头） */
  count: number;
  /** 各来源表的行数明细，用于提示用户 */
  summary: { sheet: string; count: number }[];
  /** 从文件里反推出来的自定义模板（导出文件不含模板定义，只能按列名重建） */
  templates: ScoreTemplate[];
}

function blankRow(): (string | number)[] {
  return Array(43).fill('');
}

/**
 * 把导出格式（或旧格式）的工作簿读回**内部 43 列格式**。
 *
 * 关键点：导入**不能**直接拿上传的文件覆盖数据源 —— 那样丢的正是导出表里没有的东西
 * （公式列「赋分/偏差值」、其余工作表）。旧实现就是把原文件整个写进去，
 * 于是「导入 Excel」导自己刚导出的文件会把数据清空。这里统一重建。
 */
export function parseTransferWorkbook(wb: XLSX.WorkBook, existingTemplates?: ScoreTemplate[]): ParsedTransfer {
  const existing = existingTemplates ?? loadTemplates();
  const summary: { sheet: string; count: number }[] = [];
  const dataRows: (string | number)[][] = [];

  const readSheet = (name: string): unknown[][] =>
    XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' }) as unknown[][];

  /** 把「表头即列义」的表转成内部行；返回写入行数 */
  const consume = (
    sheetName: string,
    mapRow: (rec: Record<string, unknown>) => (string | number)[] | null,
  ): number => {
    const rows = readSheet(sheetName);
    if (rows.length < 2) return 0;
    const header = ((rows[0] as unknown[]) ?? []).map((h) => String(h ?? '').trim());
    let n = 0;
    for (let i = 1; i < rows.length; i++) {
      const raw = rows[i] as unknown[];
      const rec: Record<string, unknown> = {};
      for (let c = 0; c < header.length; c++) {
        if (header[c]) rec[header[c]] = raw[c];
      }
      const mapped = mapRow(rec);
      if (mapped) { dataRows.push(mapped); n++; }
    }
    if (n > 0) summary.push({ sheet: sheetName, count: n });
    return n;
  };

  /** 公共元信息写回内部列 */
  const applyMeta = (row: (string | number)[], rec: Record<string, unknown>): void => {
    row[EXCEL_COL.SEARCH_ALIAS] = str(rec['检索名']);
    row[EXCEL_COL.STUDIO] = str(rec['制作组']);
    row[EXCEL_COL.REVIEW] = str(rec['评价']);
    row[EXCEL_COL.RELEASE_DATE] = str(rec['上映年月']);
    row[EXCEL_COL.NOTES] = str(rec['备注']);
    row[EXCEL_COL.LINK] = str(rec['链接']);
    row[EXCEL_COL.EPISODES] = numKeepZero(rec['总集数']);
    row[EXCEL_COL.CURRENT_EP] = numKeepZero(rec['当前集']);
    row[EXCEL_COL.POSTER_URL] = str(rec['海报URL']);
    const watch = str(rec['首刷时间']);
    row[EXCEL_COL.FIRST_WATCH] = watch ? (dateToSerial(watch) ?? watch) : '';
  };

  /** 「已废弃_xxx」列 → DimensionScore[] */
  const staleScoresFrom = (rec: Record<string, unknown>): DimensionScore[] => {
    const scores: DimensionScore[] = [];
    for (const [label, value] of Object.entries(rec)) {
      if (!label.startsWith(STALE_DIM_PREFIX)) continue;
      const v = num(value);
      if (v !== '') scores.push({ dimensionKey: label.slice(STALE_DIM_PREFIX.length), score: v });
    }
    return scores;
  };

  // ── 1) 番剧表（新名「番剧」/ 旧名「番剧列表」） ──
  const animeSheet = wb.Sheets[SHEET_ANIME] ? SHEET_ANIME : (wb.Sheets[LEGACY_SHEET] ? LEGACY_SHEET : undefined);
  if (animeSheet) {
    consume(animeSheet, (rec) => {
      const title = str(rec['名字']);
      if (!title) return null;
      const row = blankRow();
      row[EXCEL_COL.TITLE] = title;
      applyMeta(row, rec);
      row[EXCEL_COL.TAG] = str(rec['tag']);
      row[EXCEL_COL.BGM_SCORE] = numKeepZero(rec['BGM']);
      row[EXCEL_COL.ANILIST_SCORE] = numKeepZero(rec['AniList']);
      row[EXCEL_COL.FRAME_COUNT] = numKeepZero(rec['张数']);
      ['角色1', '角色2', '角色3', '角色4'].forEach((name, i) => {
        const col = [EXCEL_COL.CHAR1_NAME, EXCEL_COL.CHAR2_NAME, EXCEL_COL.CHAR3_NAME, EXCEL_COL.CHAR4_NAME][i];
        row[col] = str(rec[name]);
      });
      for (const [key, label] of Object.entries(DEFAULT_DIM_LABELS)) {
        const col = DIMENSION_COL_MAP[key];
        if (col === undefined) continue;
        const v = num(rec[label]);
        if (v !== '') row[col] = v;
      }
      const stale = staleScoresFrom(rec);
      if (stale.length) row[EXCEL_COL.TEMPLATE_JSON] = JSON.stringify({ scores: stale });
      row[EXCEL_COL.TEMPLATE_ID] = str(rec['模板ID']) || DEFAULT_TEMPLATE_ID;
      return row;
    });
  }

  // ── 2) 角色卡表 ──
  if (wb.Sheets[SHEET_CHARACTER]) {
    consume(SHEET_CHARACTER, (rec) => {
      const title = str(rec['名字']);
      if (!title) return null;
      const row = blankRow();
      row[EXCEL_COL.TITLE] = title;
      applyMeta(row, rec);
      row[EXCEL_COL.TEMPLATE_ID] = CHARACTER_TEMPLATE_ID;
      const scores: DimensionScore[] = [];
      for (const [key, label] of Object.entries(CHARACTER_DIM_LABELS)) {
        const v = num(rec[label]);
        if (v !== '') scores.push({ dimensionKey: key, score: v });
      }
      scores.push(...staleScoresFrom(rec));
      // 「字段_<原key>」→ 原 key（导出端的逆运算）
      const customFields: Record<string, string | number> = {};
      for (const [label, value] of Object.entries(rec)) {
        if (!label.startsWith(FIELD_COL_PREFIX)) continue;
        const v = str(value);
        if (v) customFields[fieldKeyOfCol(label)] = v;
      }
      if (scores.length || Object.keys(customFields).length) {
        row[EXCEL_COL.TEMPLATE_JSON] = JSON.stringify({
          scores,
          ...(Object.keys(customFields).length ? { customFields } : {}),
        });
      }
      return row;
    });
  }

  // ── 3) 自定义模板表（表名以「模板_」开头） ──
  const templatesOut: ScoreTemplate[] = [];
  const knownByName = new Map(existing.filter((t) => !t.isDefault).map((t) => [t.name, t]));
  for (const sheetName of wb.SheetNames) {
    if (!sheetName.startsWith(CUSTOM_SHEET_PREFIX)) continue;
    const rows = readSheet(sheetName);
    if (rows.length < 2) continue;
    const header = ((rows[0] as unknown[]) ?? []).map((h) => String(h ?? '').trim());
    const dimLabels = header.filter(
      (h) => h && !COMMON_FIXED_COLS.has(h)
        && !ANIME_ONLY_COLS.includes(h as typeof ANIME_ONLY_COLS[number])
        && h !== '模板名' && h !== 'BGM' && h !== 'AniList'
        && !h.startsWith(STALE_DIM_PREFIX) && !h.startsWith(FIELD_COL_PREFIX),
    );
    const sheetLabel = sheetName.slice(CUSTOM_SHEET_PREFIX.length);
    // 文件里每行都带「模板名」，优先用它；旧文件没有该列时退回表名
    const firstRow = rows[1] as unknown[];
    const nameIdx = header.indexOf('模板名');
    const templateName = (nameIdx >= 0 ? str(firstRow?.[nameIdx]) : '') || sheetLabel;

    const reused = knownByName.get(templateName) ?? templatesOut.find((t) => t.name === templateName);
    const templateId = reused?.id ?? `template-import-${templatesOut.length + 1}-${Date.now()}`;
    const keyByLabel = new Map<string, string>();
    if (reused) for (const d of reused.dimensions) keyByLabel.set(d.label, d.key);

    /**
     * 自定义字段列的列名 → 原 key：剥掉「字段_」前缀即可。
     * 兜底：万一列名没带前缀（旧文件/手工改过），只要命中本地模板声明的字段 key 也认。
     */
    const declaredFieldKeys = new Set(reused?.fieldConfig?.customFields?.map((f) => f.key) ?? []);
    const fieldKeyByCol = new Map<string, string>();
    for (const col of header) {
      if (!col || COMMON_FIXED_COLS.has(col)) continue;
      if (ANIME_ONLY_COLS.includes(col as typeof ANIME_ONLY_COLS[number])) continue;
      if (col === '模板名' || col === 'BGM' || col === 'AniList') continue;
      if (col.startsWith(STALE_DIM_PREFIX)) continue;
      if (dimLabels.includes(col)) continue;
      if (col.startsWith(FIELD_COL_PREFIX)) fieldKeyByCol.set(col, fieldKeyOfCol(col));
      else if (declaredFieldKeys.has(col)) fieldKeyByCol.set(col, col);
    }
    // 只有真的出现在数据里的列才处理：模板声明的字段可能没被导出成列
    const fieldCols = [...fieldKeyByCol.keys()].filter((c) => {
      const idx = header.indexOf(c);
      return idx >= 0 && rows.slice(1).some((r) => str((r as unknown[])[idx]) !== '');
    });

    const written = consume(sheetName, (rec) => {
      const title = str(rec['名字']);
      if (!title) return null;
      const row = blankRow();
      row[EXCEL_COL.TITLE] = title;
      applyMeta(row, rec);
      row[EXCEL_COL.TAG] = str(rec['tag']);
      row[EXCEL_COL.BGM_SCORE] = numKeepZero(rec['BGM']);
      row[EXCEL_COL.ANILIST_SCORE] = numKeepZero(rec['AniList']);
      row[EXCEL_COL.TEMPLATE_ID] = templateId;
      const scores: DimensionScore[] = [];
      for (const label of dimLabels) {
        const v = num(rec[label]);
        if (v !== '') scores.push({ dimensionKey: keyByLabel.get(label) ?? label, score: v });
      }
      scores.push(...staleScoresFrom(rec));
      const customFields: Record<string, string | number> = {};
      for (const [col, key] of fieldKeyByCol) {
        const v = str(rec[col]);
        if (v) customFields[key] = v;
      }
      if (scores.length || Object.keys(customFields).length) {
        row[EXCEL_COL.TEMPLATE_JSON] = JSON.stringify({
          scores,
          ...(Object.keys(customFields).length ? { customFields } : {}),
        });
      }
      return row;
    });

    if (written > 0 && !reused) {
      templatesOut.push(makeImportedTemplate(templateId, templateName, dimLabels, [...fieldKeyByCol.values()]));
    }
  }

  const wbOut = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wbOut,
    XLSX.utils.aoa_to_sheet([INTERNAL_HEADERS, ...dataRows]),
    LEGACY_SHEET,
  );
  return { workbook: wbOut, count: dataRows.length, summary, templates: templatesOut };
}

/** 按导出表的维度列名反推一个模板定义（字段 key 由调用方按同一套规则还原好） */
function makeImportedTemplate(
  id: string,
  name: string,
  dimLabels: string[],
  fieldKeys: string[],
): ScoreTemplate {
  const today = new Date().toISOString().split('T')[0];
  const weighted = dimLabels.filter((l) => l !== '总评' && l !== 'overall');
  return {
    id,
    name,
    applicableGenre: 'custom',
    dimensions: dimLabels.map((label) => ({
      key: label,
      label,
      description: '',
      // 「总评」不计权重，与内置模板口径一致
      weight: label === '总评' ? 0 : 1 / Math.max(1, weighted.length),
    })),
    isDefault: false,
    fieldConfig: {
      showAnilistScore: false,
      showBangumiId: false,
      showReleaseDate: false,
      showFrameCount: false,
      showStudio: false,
      showCharacters: false,
      showEpisodes: false,
      customFields: [...new Set(fieldKeys)].map((key) => ({
        key,
        label: key,
        type: 'text' as const,
      })),
    },
    categoryLabels: {},
    layoutConfig: { ...DEFAULT_DETAIL_LAYOUT },
    createdAt: today,
    updatedAt: today,
  };
}

// ── 对外入口 ──

/** 导出文件名：番评分_导出_YYYY-MM-DD.xlsx */
export function exportFileName(now = new Date()): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `番评分_导出_${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}.xlsx`;
}

/** 把反推出来的模板并入 localStorage（同名模板不动，避免覆盖用户改过的维度） */
export function mergeImportedTemplates(incoming: ScoreTemplate[]): number {
  if (!incoming.length) return 0;
  const existing = loadTemplates();
  const names = new Set(existing.map((t) => t.name));
  const added = incoming.filter((t) => !names.has(t.name));
  if (added.length) saveTemplates([...existing, ...added]);
  return added.length;
}
