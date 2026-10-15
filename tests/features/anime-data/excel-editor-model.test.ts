/**
 * 表格视图数据层（excel-editor-model）单元测试。
 *
 * 这个功能最怕的两件事，都用测试锁住：
 *   1. 把公式列 / 用户自有列说成可编辑 —— 用户改了白改，还会被 Excel 重算覆盖
 *   2. 编辑结果没能落到真正可写的列上 —— 界面显示改了，文件没动
 */
import { describe, it, expect } from 'vitest';
import {
  TABLE_COLUMNS,
  ROW_NUMBER_COL,
  CATEGORY_COL,
  displayValue,
  parseInput,
  applyEdits,
  isDirty,
  buildRows,
  sortEditorRows,
  isNumericCol,
  type EditorRow,
  type TableColumnDef,
} from '../../../src/components/excel-editor-model';
import { EXCEL_COL, EDITABLE_COLS, DIMENSION_COL_MAP } from '../../../features/anime-data/excel-mapping';
import type { AnimeEntry } from '../../../src/types';

const byId = (id: string): TableColumnDef => {
  const c = TABLE_COLUMNS.find((x) => x.id === id);
  if (!c) throw new Error(`没有列 ${id}`);
  return c;
};

function entry(over: Partial<AnimeEntry> = {}): AnimeEntry {
  return {
    id: 'excel-1',
    excelRowIndex: 1,
    excelTitleSnapshot: '番剧A',
    title: '番剧A',
    searchAlias: 'anime_a',
    posterUrl: 'cover.jpg',
    category: 'watched',
    tags: [{ name: '刀', highlighted: false }, { name: '音乐', highlighted: false }],
    scores: [{ dimensionKey: 'audio', score: 9.8 }, { dimensionKey: 'plot', score: 8.4 }],
    studio: 'A-1Pictures',
    review: '好看',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    ...over,
  };
}

describe('列定义', () => {
  it('公式列与用户自有列一律只读，并给出原因', () => {
    for (const id of ['assignedScore', 'content', 'deviation', 'objectiveScore', 'crawledBgm', 'col1', 'substitute', 'overall']) {
      const col = byId(id);
      expect(col.editable, `${id} 不该可编辑`).toBe(false);
      expect(col.readonlyReason, `${id} 缺少只读原因`).toBeTruthy();
    }
  });

  it('可编辑的列全部落在写回白名单覆盖的范围内', () => {
    // 有条目字段名的列（走 mapAnimeToUpdates 的非列号字段）
    const entryOnly = new Set([
      'title', 'searchAlias', 'studio', 'releaseDate', 'watchDate',
      'bangumiScore', 'aniListScore', 'episodes', 'currentEpisode', 'tag', 'review', 'notes', 'link',
    ]);
    for (const col of TABLE_COLUMNS.filter((c) => c.editable)) {
      if (entryOnly.has(col.id)) continue;
      const colIdx = DIMENSION_COL_MAP[col.id] ?? (col.id === 'frameCount' ? EXCEL_COL.FRAME_COUNT : undefined);
      expect(colIdx, `列 ${col.id} 找不到对应 Excel 列`).toBeDefined();
      expect(EDITABLE_COLS, `列 ${col.id}(=Excel ${colIdx}) 不在写回白名单里`).toContain(colIdx as number);
    }
  });

  it('只读的公式列不会被误算成可编辑', () => {
    const readonlyIds = TABLE_COLUMNS.filter((c) => !c.editable).map((c) => c.id);
    for (const forbidden of ['assignedScore', 'content', 'deviation', 'objectiveScore', 'crawledBgm', 'col1', 'substitute']) {
      expect(readonlyIds).toContain(forbidden);
      const idx = EXCEL_COL[{
        assignedScore: 'ASSIGNED_SCORE', content: 'CONTENT', deviation: 'DEVIATION',
        objectiveScore: 'OBJECTIVE_SCORE', crawledBgm: 'CRAWLED_BGM', col1: 'COL1', substitute: 'SUBSTITUTE',
      }[forbidden] as keyof typeof EXCEL_COL] as number;
      expect(EDITABLE_COLS).not.toContain(idx);
    }
  });

  it('每个维度分都可以编辑', () => {
    for (const id of ['audio', 'production', 'animation', 'immersion', 'plot', 'character', 'depth', 'vibe']) {
      expect(byId(id).editable).toBe(true);
    }
  });
});

describe('displayValue', () => {
  const col = byId('title');

  it('优先显示本地编辑', () => {
    const row: EditorRow = { id: 'excel-1', entry: entry(), edits: { title: '改过的名字' } };
    expect(displayValue(row, col)).toBe('改过的名字');
  });

  it('没有编辑时显示条目值', () => {
    const row: EditorRow = { id: 'excel-1', entry: entry(), edits: {} };
    expect(displayValue(row, col)).toBe('番剧A');
  });

  it('公式列从原始行取，超长时截断（防止写死的公式串撑爆单元格）', () => {
    const raw: unknown[] = Array(43).fill('');
    raw[EXCEL_COL.DEVIATION] = 1.2345;
    raw[EXCEL_COL.CONTENT] = '=IF(某某某某某某某某某某某很长很长很长很长很长很长很长很长很长,"a","b")';
    const row: EditorRow = { id: 'excel-1', entry: entry(), edits: {}, raw };
    // 数字列收敛到两位（1.2345 → 1.23）
    expect(displayValue(row, byId('deviation'))).toBe('1.23');
    const content = displayValue(row, byId('content'));
    expect(content.endsWith('…')).toBe(true);
    expect(content.length).toBeLessThanOrEqual(25);
  });

  it('行号列显示 Excel 行号（1-based），分类显示中文标签', () => {
    const row: EditorRow = { id: 'excel-1', entry: entry({ excelRowIndex: 41 }), edits: {} };
    expect(displayValue(row, byId(ROW_NUMBER_COL))).toBe('42');
    expect(displayValue(row, byId(CATEGORY_COL))).toBe('看过');
    const watching: EditorRow = { id: 'excel-1', entry: entry({ category: 'watching' }), edits: {} };
    expect(displayValue(watching, byId(CATEGORY_COL))).toBe('在看');
  });

  it('tag 列把标签合成斜杠串', () => {
    const row: EditorRow = { id: 'excel-1', entry: entry(), edits: {} };
    expect(displayValue(row, byId('tag'))).toBe('刀/音乐');
  });
});

describe('parseInput', () => {
  it('评分列空值 → undefined（表示清掉这个分）', () => {
    expect(parseInput(byId('audio'), '')).toBeUndefined();
    expect(parseInput(byId('audio'), '  ')).toBeUndefined();
  });

  it('文本列空值 → 空串（表示清空字段）', () => {
    expect(parseInput(byId('title'), '')).toBe('');
    expect(parseInput(byId('link'), '')).toBe('');
  });

  it('数值列解析成数字，非法输入不炸', () => {
    expect(parseInput(byId('audio'), '9.8')).toBe(9.8);
    expect(parseInput(byId('episodes'), '12')).toBe(12);
    expect(parseInput(byId('audio'), 'abc')).toBeUndefined();
  });
});

describe('applyEdits', () => {
  it('改标题 / 备注 / 链接', () => {
    const out = applyEdits(entry(), { title: '新名字', notes: '备注', link: 'https://x' });
    expect(out.title).toBe('新名字');
    expect(out.notes).toBe('备注');
    expect(out.link).toBe('https://x');
  });

  it('改评分：已有维度被覆盖，新维度被加进来', () => {
    const out = applyEdits(entry(), { audio: 9.1, depth: 7.7 });
    expect(out.scores.find((s) => s.dimensionKey === 'audio')?.score).toBe(9.1);
    expect(out.scores.find((s) => s.dimensionKey === 'depth')?.score).toBe(7.7);
    // 没碰的维度保持原样
    expect(out.scores.find((s) => s.dimensionKey === 'plot')?.score).toBe(8.4);
  });

  it('清空一个维度分 → 该维度被移除，而不是留下 0', () => {
    const out = applyEdits(entry(), { audio: undefined });
    expect(out.scores.find((s) => s.dimensionKey === 'audio')).toBeUndefined();
    expect(out.scores.find((s) => s.dimensionKey === 'plot')).toBeDefined();
  });

  it('tag 串按斜杠拆回标签（与 Excel 的存法一致）', () => {
    const out = applyEdits(entry(), { tag: '纯爱/ 恋爱 /治愈' });
    expect(out.tags.map((t) => t.name)).toEqual(['纯爱', '恋爱', '治愈']);
  });

  it('不动 excelTitleSnapshot —— 写前校验要靠它', () => {
    const out = applyEdits(entry(), { title: '新名字' });
    expect(out.excelTitleSnapshot).toBe('番剧A');
  });

  it('不改原对象（纯函数）', () => {
    const before = entry();
    const snapshot = JSON.stringify(before);
    applyEdits(before, { title: 'X', audio: 1 });
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe('buildRows', () => {
  it('只收默认模板的条目：角色卡与自定义模板不进这张表', () => {
    const rows = buildRows(
      [
        entry({ id: 'excel-1', templateId: undefined }),
        entry({ id: 'excel-2', templateId: 'default' }),
        entry({ id: 'excel-3', templateId: 'character' }),
        entry({ id: 'excel-4', templateId: 'template-game' }),
      ],
      undefined,
    );
    expect(rows.map((r) => r.id)).toEqual(['excel-1', 'excel-2']);
  });

  it('按 excelRowIndex 挂上对应的原始行（公式列靠它显示）', () => {
    const raw: unknown[][] = [['表头'], Array(43).fill('')];
    (raw[1] as unknown[])[EXCEL_COL.DEVIATION] = 2.5;
    const rows = buildRows([entry({ excelRowIndex: 1 })], raw);
    expect(rows[0].raw?.[EXCEL_COL.DEVIATION]).toBe(2.5);
  });

  it('新条目没有 excelRowIndex 时不挂 raw，也不报错', () => {
    const rows = buildRows([entry({ excelRowIndex: undefined })], [['表头']]);
    expect(rows).toHaveLength(1);
    expect(rows[0].raw).toBeUndefined();
    expect(displayValue(rows[0], byId('deviation'))).toBe('');
  });

  it('初始没有未保存编辑', () => {
    const rows = buildRows([entry()], undefined);
    expect(isDirty(rows[0])).toBe(false);
  });
});

describe('两位小数显示（全表口径）', () => {
  /** 造一行带原始公式列数据的行 */
  function rowWithRaw(setter: (raw: unknown[]) => void): EditorRow {
    const raw: unknown[] = Array(43).fill('');
    setter(raw);
    return { id: 'excel-1', entry: entry(), edits: {}, raw };
  }

  it('公式列的浮点噪声被抹掉：10.265625000000009 → 10.27', () => {
    const row = rowWithRaw((raw) => {
      raw[EXCEL_COL.ASSIGNED_SCORE] = 10.265625000000009;
      raw[EXCEL_COL.DEVIATION] = 3.590000000000046;
      raw[EXCEL_COL.OBJECTIVE_SCORE] = 7.500000000000001;
    });
    expect(displayValue(row, byId('assignedScore'))).toBe('10.27');
    expect(displayValue(row, byId('deviation'))).toBe('3.59');
    expect(displayValue(row, byId('objectiveScore'))).toBe('7.5');
  });

  it('不补零：9.6 显示 9.6、10 显示 10', () => {
    const raw: unknown[] = Array(43).fill('');
    raw[EXCEL_COL.OVERALL] = 9.6;
    raw[EXCEL_COL.CONTENT] = 10;
    raw[EXCEL_COL.CRAWLED_BGM] = 0;
    const row: EditorRow = { id: 'excel-1', entry: entry(), edits: {}, raw };
    expect(displayValue(row, byId('overall'))).toBe('9.6');
    expect(displayValue(row, byId('content'))).toBe('10');
    // 0 是合法值，不能变成空
    expect(displayValue(row, byId('crawledBgm'))).toBe('0');
  });

  it('条目里的分也收敛（内存里若有噪声同样显示两位）', () => {
    const row: EditorRow = {
      id: 'excel-1',
      entry: entry({ scores: [{ dimensionKey: 'audio', score: 9.72000000000004 }] }),
      edits: {},
    };
    expect(displayValue(row, byId('audio'))).toBe('9.72');
  });

  it('本地编辑的数字同样按两位显示', () => {
    const row: EditorRow = { id: 'excel-1', entry: entry(), edits: { audio: 9.876 } };
    // parseInput 已把它收敛过，这里再断言显示层也不会露出第三位
    expect(displayValue(row, byId('audio'))).toBe('9.88');
  });

  it('张数这类非评分数字也走同一口径', () => {
    const row: EditorRow = { id: 'excel-1', entry: entry({ frameCount: 4.567 }), edits: {} };
    expect(displayValue(row, byId('frameCount'))).toBe('4.57');
  });
});

describe('sortEditorRows（数值 / 首字母，跨全表）', () => {
  function rowsOf(values: Array<{ id: string; title: string; audio?: number; alias?: string }>): EditorRow[] {
    return values.map((v) => ({
      id: v.id,
      entry: entry({
        id: v.id,
        title: v.title,
        searchAlias: v.alias,
        scores: v.audio !== undefined ? [{ dimensionKey: 'audio', score: v.audio }] : [],
      }),
      edits: {},
    }));
  }

  const sample = rowsOf([
    { id: 'a', title: 'Banana', audio: 7.5 },
    { id: 'b', title: 'apple', audio: 9.1 },
    { id: 'c', title: 'Cherry', audio: 8.2 },
  ]);

  it('数值列升序 / 降序', () => {
    expect(sortEditorRows(sample, 'audio', 'ascend').map((r) => r.id)).toEqual(['a', 'c', 'b']);
    expect(sortEditorRows(sample, 'audio', 'descend').map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('文本列按首字母排序，且忽略大小写', () => {
    // apple / Banana / Cherry —— 不能因为大小写把 B 排到 a 前面
    expect(sortEditorRows(sample, 'title', 'ascend').map((r) => r.entry.title)).toEqual(['apple', 'Banana', 'Cherry']);
    expect(sortEditorRows(sample, 'title', 'descend').map((r) => r.entry.title)).toEqual(['Cherry', 'Banana', 'apple']);
  });

  it('空值永远排在最后（升序降序都一样）', () => {
    const withEmpty = rowsOf([
      { id: 'a', title: 'A', audio: 7.5 },
      { id: 'x', title: 'X' }, // 无分
      { id: 'b', title: 'B', audio: 9.1 },
    ]);
    expect(sortEditorRows(withEmpty, 'audio', 'ascend').map((r) => r.id)).toEqual(['a', 'b', 'x']);
    expect(sortEditorRows(withEmpty, 'audio', 'descend').map((r) => r.id)).toEqual(['b', 'a', 'x']);
  });

  it('等值时保持原始顺序（稳定排序）', () => {
    const same = rowsOf([
      { id: 'a', title: 'A', audio: 8 },
      { id: 'b', title: 'B', audio: 8 },
      { id: 'c', title: 'C', audio: 8 },
    ]);
    expect(sortEditorRows(same, 'audio', 'ascend').map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(sortEditorRows(same, 'audio', 'descend').map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('公式列（只读但数字）也按数值排，不是按字符串', () => {
    const raw = (v: number): EditorRow => {
      const cols: unknown[] = Array(43).fill('');
      cols[EXCEL_COL.DEVIATION] = v;
      return { id: `r${v}`, entry: entry(), edits: {}, raw: cols };
    };
    // 字符串排序会把 10 排在 9 前面；数值排序不会
    const rows = [raw(10), raw(9), raw(2)];
    expect(sortEditorRows(rows, 'deviation', 'ascend').map((r) => r.id)).toEqual(['r2', 'r9', 'r10']);
  });

  it('按行号排（行号列是 1-based 的数字）', () => {
    const rows: EditorRow[] = [
      { id: 'x', entry: entry({ excelRowIndex: 10 }), edits: {} },
      { id: 'y', entry: entry({ excelRowIndex: 2 }), edits: {} },
    ];
    expect(sortEditorRows(rows, 'rowNumber', 'ascend').map((r) => r.id)).toEqual(['y', 'x']);
  });

  it('不认识的列 id 原样返回，不改原数组', () => {
    const copy = [...sample];
    expect(sortEditorRows(sample, '不存在的列', 'ascend')).toEqual(sample);
    expect(sample).toEqual(copy);
  });
});
