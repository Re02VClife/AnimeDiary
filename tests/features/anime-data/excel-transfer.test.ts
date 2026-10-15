/**
 * 导出 / 导入（excel-transfer）单元测试
 *
 * 重点在**分表**和**闭环**两件事上：
 *   - 导出必须按记录类型分表，各表列名是人话（不再是「人设4/造型2/模板JSON」）
 *   - 分数与自定义字段必须从 JSON 里拆成真列
 *   - 名字为空、程序会丢弃的行必须单独进「异常行」，不能混进正表
 *   - 导出的文件再导入回来，内部数据必须一条不少（这是「整理成表」不能破坏的底线）
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as XLSX from 'xlsx';
import {
  buildTransferWorkbook,
  parseTransferWorkbook,
  exportFileName,
  rebuildOverallFormula,
  SHEET_ANIME,
  SHEET_CHARACTER,
  SHEET_ANOMALY,
} from '../../../features/anime-data/excel-transfer';
import { EXCEL_COL } from '../../../features/anime-data/excel-mapping';
import { createCharacterTemplate, DEFAULT_DETAIL_LAYOUT } from '../../../src/types';
import type { ScoreTemplate } from '../../../src/types';

// ── 造内部行的小工具 ──

function blank(): (string | number)[] {
  return Array(43).fill('');
}

function animeRow(over: Record<number, string | number> = {}): (string | number)[] {
  const row = blank();
  row[EXCEL_COL.TITLE] = '番剧A';
  row[EXCEL_COL.SEARCH_ALIAS] = 'anime_a';
  row[EXCEL_COL.AUDIO] = 9.8;
  row[EXCEL_COL.PRODUCTION] = 9.2;
  row[EXCEL_COL.PLOT] = 8.4;
  row[EXCEL_COL.OVERALL] = 9.07;
  row[EXCEL_COL.REVIEW] = '好看';
  row[EXCEL_COL.STUDIO] = 'A-1Pictures';
  row[EXCEL_COL.TAG] = '刀/音乐';
  row[EXCEL_COL.BGM_SCORE] = 7.6;
  row[EXCEL_COL.POSTER_URL] = 'cover.jpg';
  row[EXCEL_COL.CHAR1_NAME] = '蕾娜';
  row[EXCEL_COL.FIRST_WATCH] = 46221; // Excel 序列号
  for (const [col, v] of Object.entries(over)) row[Number(col)] = v;
  return row;
}

function characterRow(over: Record<string, unknown> = {}): (string | number)[] {
  const row = blank();
  row[EXCEL_COL.TITLE] = '蕾娜';
  row[EXCEL_COL.POSTER_URL] = 'char.jpg';
  row[EXCEL_COL.LINK] = 'https://bgm.tv/character/57715';
  row[EXCEL_COL.TEMPLATE_ID] = 'character';
  row[EXCEL_COL.TEMPLATE_JSON] = JSON.stringify({
    scores: [
      { dimensionKey: 'char_appearance', score: 8 },
      { dimensionKey: 'char_personality', score: 7.5 },
      { dimensionKey: 'char_voice', score: 7.3 },
      { dimensionKey: 'char_moe', score: 5.5 },
      // v6 已删掉的维度：必须原样保住，不能因为「已废弃」就丢
      { dimensionKey: 'char_role', score: 5.2 },
    ],
    customFields: { char_source: '86 不存在的战区', char_cv: '長谷川育美', char_profile: '长文人设' },
  });
  for (const [k, v] of Object.entries(over)) {
    row[EXCEL_COL[k as keyof typeof EXCEL_COL] as number] = v as string | number;
  }
  return row;
}

function customRow(templateId: string): (string | number)[] {
  const row = blank();
  row[EXCEL_COL.TITLE] = '卡拉彼丘';
  row[EXCEL_COL.TEMPLATE_ID] = templateId;
  row[EXCEL_COL.POSTER_URL] = 'game.jpg';
  // 注意：模板分只在 JSON 里，普通评分列为空（就是原来导出来看不懂的那种行）
  row[EXCEL_COL.TEMPLATE_JSON] = JSON.stringify({
    scores: [
      { dimensionKey: 'dim_玩法', score: 8.7 },
      { dimensionKey: 'dim_美术', score: 7.6 },
      { dimensionKey: 'dim_玩法压力', score: 2.4 },
    ],
    customFields: { dim_note: '赛季制' },
  });
  return row;
}

const GAME_TEMPLATE: ScoreTemplate = {
  id: 'template-game',
  name: '手游评分',
  applicableGenre: 'custom',
  dimensions: [
    { key: 'dim_玩法', label: '玩法', description: '', weight: 0.5 },
    { key: 'dim_美术', label: '美术', description: '', weight: 0.5 },
  ],
  isDefault: false,
  fieldConfig: {
    showAnilistScore: false, showBangumiId: false, showReleaseDate: false,
    showFrameCount: false, showStudio: false, showCharacters: false, showEpisodes: false,
    customFields: [{ key: 'dim_note', label: '备注字段', type: 'text' }],
  },
  categoryLabels: {},
  layoutConfig: { ...DEFAULT_DETAIL_LAYOUT },
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
};

/** 取某张表的 aoa */
function sheetAoa(wb: XLSX.WorkBook, name: string): unknown[][] {
  return XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' }) as unknown[][];
}

function headerOf(wb: XLSX.WorkBook, name: string): string[] {
  return (sheetAoa(wb, name)[0] as unknown[]).map((h) => String(h ?? ''));
}

/** 按表头把 aoa 转成对象数组，方便断言 */
function rowObj(wb: XLSX.WorkBook, name: string, rowIdx: number): Record<string, unknown> {
  const aoa = sheetAoa(wb, name);
  const header = (aoa[0] as unknown[]).map((h) => String(h ?? ''));
  const rec: Record<string, unknown> = {};
  header.forEach((h, i) => { if (h) rec[h] = (aoa[rowIdx] as unknown[])[i]; });
  return rec;
}

const TEMPLATES = [GAME_TEMPLATE, createCharacterTemplate()];

describe('buildTransferWorkbook — 按类型分表', () => {
  it('番剧/角色卡/自定义模板分到各自的表，表名是「番剧/角色卡/模板_<名字>」', () => {
    const wb = buildTransferWorkbook({
      rows: [['表头'], animeRow(), characterRow(), customRow('template-game')],
      templates: TEMPLATES,
    });
    expect(wb.SheetNames).toContain(SHEET_ANIME);
    expect(wb.SheetNames).toContain(SHEET_CHARACTER);
    expect(wb.SheetNames).toContain('模板_手游评分');
    // 三类记录不再混在同一张表里
    expect(sheetAoa(wb, SHEET_ANIME)).toHaveLength(2);
    expect(sheetAoa(wb, SHEET_CHARACTER)).toHaveLength(2);
    expect(sheetAoa(wb, '模板_手游评分')).toHaveLength(2);
  });

  it('番剧表用中文列名，且不再出现「人设4/造型2/列1/模板JSON」这类内部列', () => {
    const wb = buildTransferWorkbook({ rows: [['表头'], animeRow()], templates: TEMPLATES });
    const header = headerOf(wb, SHEET_ANIME);
    expect(header).toEqual(expect.arrayContaining(['名字', '检索名', '音', '制作', '剧情', '总评(观感)', '制作组']));
    for (const bad of ['人设4', '造型2', '列1', '模板JSON', '赋分', '偏差值']) {
      expect(header).not.toContain(bad);
    }
  });

  it('番剧的分数写成真列，首刷时间转成 YYYY-MM-DD', () => {
    const wb = buildTransferWorkbook({ rows: [['表头'], animeRow()], templates: TEMPLATES });
    const rec = rowObj(wb, SHEET_ANIME, 1);
    expect(rec['音']).toBe(9.8);
    expect(rec['总评(观感)']).toBe(9.07);
    expect(rec['名字']).toBe('番剧A');
    expect(String(rec['首刷时间'])).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(rec['角色1']).toBe('蕾娜');
  });

  it('角色卡的分与自定义字段从 JSON 拆成真列', () => {
    const wb = buildTransferWorkbook({ rows: [['表头'], characterRow()], templates: TEMPLATES });
    const header = headerOf(wb, SHEET_CHARACTER);
    expect(header).toEqual(expect.arrayContaining([
      '角色设计', '性格', '声优', '萌点电波', '好感度',
      '字段_char_source', '字段_char_cv', '字段_char_profile',
    ]));
    const rec = rowObj(wb, SHEET_CHARACTER, 1);
    expect(rec['角色设计']).toBe(8);
    expect(rec['性格']).toBe(7.5);
    expect(rec['字段_char_source']).toBe('86 不存在的战区');
    expect(rec['字段_char_profile']).toBe('长文人设');
    // 模板里已删掉的旧维度 → 带前缀单独成列，数据不丢
    expect(rec['已废弃_char_role']).toBe(5.2);
  });

  it('自定义模板用模板里的中文维度标签做列名，量纲不再串到番剧列', () => {
    const wb = buildTransferWorkbook({ rows: [['表头'], customRow('template-game')], templates: TEMPLATES });
    const header = headerOf(wb, '模板_手游评分');
    expect(header).toEqual(expect.arrayContaining(['玩法', '美术', '模板名', '字段_dim_note']));
    const rec = rowObj(wb, '模板_手游评分', 1);
    expect(rec['玩法']).toBe(8.7);
    expect(rec['美术']).toBe(7.6);
    expect(rec['字段_dim_note']).toBe('赛季制');
    expect(rec['模板名']).toBe('手游评分');
  });

  it('名字为空但还剩半截数据的行进「异常行」并写明原因，全空行直接丢掉', () => {
    const orphan = blank();
    orphan[EXCEL_COL.ANILIST_SCORE] = 8.3; // 只剩一个 AniList 分
    const wb = buildTransferWorkbook({
      rows: [['表头'], animeRow(), orphan, blank(), blank()],
      templates: TEMPLATES,
    });
    expect(sheetAoa(wb, SHEET_ANIME)).toHaveLength(2);   // 只剩真番剧
    const anomaly = sheetAoa(wb, SHEET_ANOMALY);
    expect(anomaly).toHaveLength(2);                     // 表头 + 1 条
    expect(String(anomaly[1][0])).toBe('3');             // Excel 行号
    expect(String(anomaly[1][3])).toContain('名字列(B)为空');
  });

  it('界面上已隐藏/删除、但行还在源文件里的条目，在「状态」列标出来', () => {
    const wb = buildTransferWorkbook({
      rows: [['表头'], animeRow(), animeRow({ [EXCEL_COL.TITLE]: '番剧B' })],
      templates: TEMPLATES,
      // 第二行（下标 2）→ id 就是 excel-2
      hiddenIds: new Set(['excel-2']),
    });
    expect(rowObj(wb, SHEET_ANIME, 1)['状态']).toBe('');
    expect(rowObj(wb, SHEET_ANIME, 2)['状态']).toBe('已删除(仅界面隐藏)');
  });

  it('没有记录时也产出四张规范表（空表而非缺表）', () => {
    const wb = buildTransferWorkbook({ rows: [['表头']], templates: TEMPLATES });
    expect(wb.SheetNames).toEqual([SHEET_ANIME, SHEET_CHARACTER, SHEET_ANOMALY]);
  });
});

describe('parseTransferWorkbook — 导出文件能导回来', () => {
  it('新格式回读：内部 43 列表头正确，行数对得上', () => {
    const wb = buildTransferWorkbook({
      rows: [['表头'], animeRow(), characterRow(), customRow('template-game')],
      templates: TEMPLATES,
    });
    const parsed = parseTransferWorkbook(wb, TEMPLATES);
    expect(parsed.count).toBe(3);
    const rows = sheetAoa(parsed.workbook, '番剧列表');
    expect(rows).toHaveLength(4);
    expect(rows[0][EXCEL_COL.TITLE]).toBe('名字');
    expect(rows[0][EXCEL_COL.TEMPLATE_JSON]).toBe('模板JSON');
    expect(parsed.summary.map((s) => s.sheet)).toEqual(
      expect.arrayContaining([SHEET_ANIME, SHEET_CHARACTER, '模板_手游评分']),
    );
  });

  it('番剧的分、tag、海报、角色名写回内部列；首刷时间回到序列号', () => {
    const parsed = parseTransferWorkbook(
      buildTransferWorkbook({ rows: [['表头'], animeRow()], templates: TEMPLATES }),
      TEMPLATES,
    );
    const row = sheetAoa(parsed.workbook, '番剧列表')[1] as unknown[];
    expect(row[EXCEL_COL.TITLE]).toBe('番剧A');
    expect(row[EXCEL_COL.AUDIO]).toBe(9.8);
    expect(row[EXCEL_COL.PLOT]).toBe(8.4);
    expect(row[EXCEL_COL.TAG]).toBe('刀/音乐');
    expect(row[EXCEL_COL.POSTER_URL]).toBe('cover.jpg');
    expect(row[EXCEL_COL.CHAR1_NAME]).toBe('蕾娜');
    expect(typeof row[EXCEL_COL.FIRST_WATCH]).toBe('number');
  });

  it('角色卡的分与自定义字段回到 TEMPLATE_JSON，旧维度也保住', () => {
    const parsed = parseTransferWorkbook(
      buildTransferWorkbook({ rows: [['表头'], characterRow()], templates: TEMPLATES }),
      TEMPLATES,
    );
    const row = sheetAoa(parsed.workbook, '番剧列表')[1] as unknown[];
    expect(row[EXCEL_COL.TEMPLATE_ID]).toBe('character');
    const json = JSON.parse(String(row[EXCEL_COL.TEMPLATE_JSON]));
    const keys = json.scores.map((s: { dimensionKey: string }) => s.dimensionKey);
    expect(keys).toContain('char_appearance');
    expect(keys).toContain('char_role'); // 旧维度不能在往返中丢
    expect(json.customFields.char_cv).toBe('長谷川育美');
  });

  it('自定义模板：已有同名模板时复用它的 ID，维度 key 对得上', () => {
    const parsed = parseTransferWorkbook(
      buildTransferWorkbook({ rows: [['表头'], customRow('template-game')], templates: TEMPLATES }),
      TEMPLATES,
    );
    const row = sheetAoa(parsed.workbook, '番剧列表')[1] as unknown[];
    expect(row[EXCEL_COL.TEMPLATE_ID]).toBe('template-game');
    const json = JSON.parse(String(row[EXCEL_COL.TEMPLATE_JSON]));
    const byKey = Object.fromEntries(
      json.scores.map((s: { dimensionKey: string; score: number }) => [s.dimensionKey, s.score]),
    );
    expect(byKey['dim_玩法']).toBe(8.7);
    expect(byKey['dim_美术']).toBe(7.6);
    expect(json.customFields.dim_note).toBe('赛季制');
    // 已存在的模板不该被重复创建
    expect(parsed.templates).toHaveLength(0);
  });

  it('遇到没见过的模板：按维度列名反推模板定义，并保留自定义字段列', () => {
    const wb = buildTransferWorkbook({ rows: [['表头'], customRow('template-game')], templates: TEMPLATES });
    const parsed = parseTransferWorkbook(wb, [createCharacterTemplate()]); // 本地没有这个模板
    expect(parsed.templates).toHaveLength(1);
    const tpl = parsed.templates[0];
    expect(tpl.name).toBe('手游评分');
    expect(tpl.dimensions.map((d) => d.label)).toEqual(expect.arrayContaining(['玩法', '美术']));
    // 字段列名是「字段_<原key>」，反查回来必须还是原 key，否则数据对不上
    expect(tpl.fieldConfig.customFields.map((f) => f.key)).toContain('dim_note');
    // 反推出的模板 ID 必须真的写进了数据行，否则这些条目会没有模板
    const row = sheetAoa(parsed.workbook, '番剧列表')[1] as unknown[];
    expect(row[EXCEL_COL.TEMPLATE_ID]).toBe(tpl.id);
  });

  it('旧格式（单表「番剧列表」）仍然能导入', () => {
    const legacy = XLSX.utils.aoa_to_sheet([
      ['检索名', '名字', '音', '制作'],
      ['anime_a', '番剧A', 9.8, 9.2],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, legacy, '番剧列表');
    const parsed = parseTransferWorkbook(wb, TEMPLATES);
    expect(parsed.count).toBe(1);
    const row = sheetAoa(parsed.workbook, '番剧列表')[1] as unknown[];
    expect(row[EXCEL_COL.TITLE]).toBe('番剧A');
    expect(row[EXCEL_COL.AUDIO]).toBe(9.8);
  });

  it('往返一次不改数据：内部行 → 导出 → 导入 → 内部行，关键字段一致', () => {
    const original = animeRow();
    const before = sheetAoa(
      { SheetNames: ['x'], Sheets: { x: XLSX.utils.aoa_to_sheet([['h'], original]) } } as unknown as XLSX.WorkBook,
      'x',
    )[1] as unknown[];
    const parsed = parseTransferWorkbook(
      buildTransferWorkbook({ rows: [['表头'], original], templates: TEMPLATES }),
      TEMPLATES,
    );
    const after = sheetAoa(parsed.workbook, '番剧列表')[1] as unknown[];
    for (const col of [
      EXCEL_COL.TITLE, EXCEL_COL.SEARCH_ALIAS, EXCEL_COL.AUDIO, EXCEL_COL.PRODUCTION,
      EXCEL_COL.PLOT, EXCEL_COL.OVERALL, EXCEL_COL.REVIEW, EXCEL_COL.STUDIO,
      EXCEL_COL.TAG, EXCEL_COL.BGM_SCORE, EXCEL_COL.POSTER_URL, EXCEL_COL.CHAR1_NAME,
      EXCEL_COL.FIRST_WATCH,
    ]) {
      expect(after[col], `列 ${col} 往返后不一致`).toEqual(before[col]);
    }
  });
});

describe('exportFileName', () => {
  it('文件名带日期', () => {
    expect(exportFileName(new Date(2026, 9, 6))).toBe('番评分_导出_2026-10-06.xlsx');
  });
});

describe('rebuildOverallFormula — D 列按模板权重重建', () => {
  /** 用户「维度管理」里那套权重（与代码 DEFAULT_DIMENSIONS 不同，正是分歧来源） */
  const USER_WEIGHTS: ScoreTemplate = {
    id: 'default',
    name: '番剧评分',
    applicableGenre: 'anime',
    isDefault: true,
    dimensions: [
      { key: 'overall', label: '总评', description: '', weight: 0 },
      { key: 'audio', label: '音声', description: '', weight: 0.10 },
      { key: 'production', label: '制作', description: '', weight: 0.10 },
      { key: 'animation', label: '作画', description: '', weight: 0.10 },
      { key: 'immersion', label: '沉浸', description: '', weight: 0.12 },
      { key: 'plot', label: '剧情', description: '', weight: 0.15 },
      { key: 'character', label: '人设', description: '', weight: 0.15 },
      { key: 'depth', label: '深度', description: '', weight: 0.15 },
      { key: 'vibe', label: '电波', description: '', weight: 0.13 },
    ],
    fieldConfig: {
      showAnilistScore: false, showBangumiId: false, showReleaseDate: false,
      showFrameCount: false, showStudio: false, showCharacters: false, showEpisodes: false,
      customFields: [],
    },
    categoryLabels: {},
    layoutConfig: { ...DEFAULT_DETAIL_LAYOUT },
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };

  const cellOf = (ws: XLSX.WorkSheet, rowIdx0: number): XLSX.CellObject | undefined =>
    ws[XLSX.utils.encode_cell({ c: EXCEL_COL.OVERALL, r: rowIdx0 })] as XLSX.CellObject | undefined;

  it('公式只包含模板里权重>0 的维度，分母是权重和', () => {
    // 8 个维度都给分，才能验证公式覆盖全部模板维度
    const row = blank();
    row[EXCEL_COL.TITLE] = '八维全打分';
    row[EXCEL_COL.AUDIO] = 9.1;
    row[EXCEL_COL.PRODUCTION] = 9.6;
    row[EXCEL_COL.ANIMATION] = 9.4;
    row[EXCEL_COL.IMMERSION] = 9.5;
    row[EXCEL_COL.PLOT] = 8.2;
    row[EXCEL_COL.CHARACTER] = 9.9;
    row[EXCEL_COL.DEPTH] = 7.9;
    row[EXCEL_COL.VIBE] = 9.89;
    const ws = XLSX.utils.aoa_to_sheet([['表头'], row]);
    const res = rebuildOverallFormula(ws, { templates: [USER_WEIGHTS], sheetRows: [['表头'], row] });
    expect(res.dims.map((d) => d.label)).toEqual(['音声', '制作', '作画', '沉浸', '剧情', '人设', '深度', '电波']);
    expect(res.weightSum).toBe(1);
    const cell = cellOf(ws, 1);
    expect(cell?.f).toContain('E2*0.1');
    expect(cell?.f).toContain('O2*0.13');
    // 旧公式用的 J（内容「内容」列）不在模板维度里，必须消失
    expect(cell?.f).not.toContain('J2');
    expect(cell?.f).toMatch(/\/1$/);
  });

  it('按模板权重算出的值与手工加权一致', () => {
    // 轻音少女 剧场版 的真实分
    const row = blank();
    row[EXCEL_COL.TITLE] = '测试番';
    row[EXCEL_COL.AUDIO] = 9.1;
    row[EXCEL_COL.PRODUCTION] = 9.6;
    row[EXCEL_COL.ANIMATION] = 9.4;
    row[EXCEL_COL.IMMERSION] = 9.5;
    row[EXCEL_COL.PLOT] = 8.2;
    row[EXCEL_COL.CHARACTER] = 9.9;
    row[EXCEL_COL.DEPTH] = 7.9;
    row[EXCEL_COL.VIBE] = 9.89;
    const ws = XLSX.utils.aoa_to_sheet([['表头'], row]);
    rebuildOverallFormula(ws, { templates: [USER_WEIGHTS], sheetRows: [['表头'], row] });
    // 9.1*.1+9.6*.1+9.4*.1+9.5*.12+8.2*.15+9.9*.15+7.9*.15+9.89*.13 = 9.1357
    expect(cellOf(ws, 1)?.v).toBeCloseTo(9.14, 5);
  });

  it('没打分的维度按 0 计入（分母仍用模板权重和），不因归一化基数变化而整体跳动', () => {
    const row = blank();
    row[EXCEL_COL.TITLE] = '只打了两个维度';
    row[EXCEL_COL.AUDIO] = 10;
    row[EXCEL_COL.PRODUCTION] = 10;
    const ws = XLSX.utils.aoa_to_sheet([['表头'], row]);
    rebuildOverallFormula(ws, { templates: [USER_WEIGHTS], sheetRows: [['表头'], row] });
    // (10*0.1 + 10*0.1) / 1 = 2，而不是 (10*0.1+10*0.1)/0.2 = 10
    expect(cellOf(ws, 1)?.v).toBeCloseTo(2, 5);
  });

  it('非默认模板的行不动（角色卡/自定义模板的维度没有独立列）', () => {
    const charRow = blank();
    charRow[EXCEL_COL.TITLE] = '某角色';
    charRow[EXCEL_COL.TEMPLATE_ID] = 'character';
    const ws = XLSX.utils.aoa_to_sheet([['表头'], animeRow(), charRow]);
    const res = rebuildOverallFormula(ws, {
      templates: [USER_WEIGHTS],
      sheetRows: [['表头'], animeRow(), charRow],
    });
    expect(res.rows).toBe(1);                     // 只重建了番剧那一行
    expect(cellOf(ws, 2)?.f).toBeUndefined();     // 角色行没写公式
  });

  it('原本没有 D 单元格的行会新建，并且带公式和缓存值', () => {
    const row = animeRow();
    const ws = XLSX.utils.aoa_to_sheet([['表头'], row]);
    delete ws[XLSX.utils.encode_cell({ c: EXCEL_COL.OVERALL, r: 1 })];
    expect(cellOf(ws, 1)).toBeUndefined();
    rebuildOverallFormula(ws, { templates: [USER_WEIGHTS], sheetRows: [['表头'], row] });
    expect(cellOf(ws, 1)?.t).toBe('n');
    expect(cellOf(ws, 1)?.f).toBeTruthy();
    expect(typeof cellOf(ws, 1)?.v).toBe('number');
  });

  it('一个维度都没打分时跳过（不写 0 分公式）', () => {
    const empty = blank();
    empty[EXCEL_COL.TITLE] = '全空';
    const ws = XLSX.utils.aoa_to_sheet([['表头'], empty]);
    delete ws[XLSX.utils.encode_cell({ c: EXCEL_COL.OVERALL, r: 1 })];
    const res = rebuildOverallFormula(ws, { templates: [USER_WEIGHTS], sheetRows: [['表头'], empty] });
    expect(res.rows).toBe(0);
    expect(cellOf(ws, 1)?.f).toBeUndefined();
  });

  it('模板权重全为 0 时不写公式（没有可用的加权口径）', () => {
    const zeroTpl: ScoreTemplate = {
      ...USER_WEIGHTS,
      dimensions: USER_WEIGHTS.dimensions.map((d) => ({ ...d, weight: 0 })),
    };
    const row = animeRow();
    const ws = XLSX.utils.aoa_to_sheet([['表头'], row]);
    delete ws[XLSX.utils.encode_cell({ c: EXCEL_COL.OVERALL, r: 1 })];
    const res = rebuildOverallFormula(ws, { templates: [zeroTpl], sheetRows: [['表头'], row] });
    expect(res.dims).toHaveLength(0);
    expect(res.rows).toBe(0);
    expect(cellOf(ws, 1)?.f).toBeUndefined();
  });

  it('缓存值被刷成新口径时会统计 changed', () => {
    const row = animeRow();
    const ws = XLSX.utils.aoa_to_sheet([['表头'], row]);
    // 先造一个显然过时的缓存值
    ws[XLSX.utils.encode_cell({ c: EXCEL_COL.OVERALL, r: 1 })] = { t: 'n', v: 99 } as XLSX.CellObject;
    const res = rebuildOverallFormula(ws, { templates: [USER_WEIGHTS], sheetRows: [['表头'], row] });
    expect(res.changed).toBe(1);
    expect(cellOf(ws, 1)?.v).not.toBe(99);
  });
});
