/**
 * ExcelEditor —— 应用内直接查看 / 编辑列表原始数据。
 *
 * 为什么需要它：原来侧栏的「查看 Excel」只是调系统程序打开文件
 * （`/api/excel/open` → `start 番评分.xlsx`），应用内看不到、也改不了列表本身。
 *
 * 设计取舍（都是刻意的）：
 *
 *   1. **只列出默认模板的记录**（番剧）。角色卡 / 自定义模板的维度完全不同，
 *      混进同一张表就是之前导出那个「数字串味」的老问题；
 *   2. **公式列与用户自有列只读**，表头 tooltip 写明原因，不让人白改一场；
 *   3. **改动先暂存在内存，点「保存修改」才写 Excel**。不做逐格自动保存 ——
 *      那会按每次失焦发一轮 HTTP，而且改名会让后续行的写前校验（expectedTitle）
 *      全部对不上，逐格写会把半成品状态留在文件里；
 *   4. 写回走 `handleSaveAnime(entry, keepModal=true)`，即项目既有的
 *      `updateAnimeEntry` 路径，白名单 + 写前校验 + 原子写 + 快照全部复用。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Table, Input, InputNumber, Tooltip, Button, Space, Alert, Tag, Spin } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { SaveOutlined, UndoOutlined, ReloadOutlined, LockOutlined } from '@ant-design/icons';
import { useAnimeContext } from '../../context/AnimeContext';
import { readRawRows } from '../../features/anime-data/excel-service';
import { catgirlMessage } from '../theme';
import {
  TABLE_COLUMNS, ROW_NUMBER_COL, CATEGORY_COL,
  displayValue, parseInput, applyEdits, buildRows, sortEditorRows, isNumericCol,
  type TableColumnDef, type EditorRow, type SortOrder,
} from './excel-editor-model';

interface ExcelEditorProps {
  open: boolean;
  onClose: () => void;
}

/** 单元格编辑态 */
interface EditingCell {
  rowId: string;
  colId: string;
}

const ExcelEditor: React.FC<ExcelEditorProps> = ({ open, onClose }) => {
  const { state, handleSaveAnime, refreshAnimeList } = useAnimeContext();

  const [rawRows, setRawRows] = useState<unknown[][] | undefined>(undefined);
  const [loadingRaw, setLoadingRaw] = useState(false);
  /** 未保存的编辑：rowId → { 列 id: 值 } */
  const [edits, setEdits] = useState<Record<string, Record<string, string | number | undefined>>>({});
  const [editing, setEditing] = useState<EditingCell | null>(null);
  const [saving, setSaving] = useState(false);
  const [keyword, setKeyword] = useState('');
  /** 当前排序（跨全表；null = 保持 Excel 原始行序） */
  const [sortState, setSortState] = useState<{ columnId: string; order: SortOrder } | null>(null);
  /** 受控分页：排序/筛选后要回到第 1 页，否则会停在一个不存在的页码上 */
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  /** 每个输入框当前正在输入的原文本（受控会给 185 行带来明显卡顿，所以只在编辑态挂受控值） */
  const [draft, setDraft] = useState('');
  const draftRef = useRef('');

  const loadRaw = useCallback(async () => {
    setLoadingRaw(true);
    try {
      setRawRows(await readRawRows());
    } catch (e) {
      catgirlMessage.error('读取数据源失败：' + (e instanceof Error ? e.message : '未知错误'));
      setRawRows(undefined);
    } finally {
      setLoadingRaw(false);
    }
  }, []);

  // 打开时拉原始行（公式列只在原始行里），并清掉上一次遗留的编辑
  useEffect(() => {
    if (!open) return;
    setEdits({});
    setEditing(null);
    setKeyword('');
    setSortState(null);
    setPage(1);
    void loadRaw();
  }, [open, loadRaw]);

  const rows = useMemo<EditorRow[]>(() => {
    const base = buildRows(state.animeList, rawRows);
    return base.map((r) => ({ ...r, edits: edits[r.id] ?? {} }));
  }, [state.animeList, rawRows, edits]);

  const filteredRows = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return rows;
    return rows.filter((r) => {
      const title = r.entry.title.toLowerCase();
      const alias = (r.entry.searchAlias ?? '').toLowerCase();
      return title.includes(kw) || alias.includes(kw);
    });
  }, [rows, keyword]);

  /**
   * 排序后的数据源。
   *
   * 排序在这里做（而不是把 sorter 交给 antd Table）的原因：**要跨全表排，不是只排当前页**。
   * 每页 100 条，只对当前页排出来的"最大"很容易被误解成全局最大值。
   */
  const sortedRows = useMemo(
    () => (sortState ? sortEditorRows(filteredRows, sortState.columnId, sortState.order) : filteredRows),
    [filteredRows, sortState],
  );

  const dirtyRows = useMemo(() => rows.filter((r) => Object.keys(r.edits).length > 0), [rows]);
  const dirtyCount = dirtyRows.length;

  /** 暂存一次编辑（同值不记） */
  const stage = useCallback((row: EditorRow, col: TableColumnDef, text: string) => {
    const value = parseInput(col, text);
    const before = displayValue({ ...row, edits: {} }, col);
    const sameAsOriginal = String(before ?? '') === String(value ?? '');
    setEdits((prev) => {
      const forRow = { ...(prev[row.id] ?? {}) };
      if (sameAsOriginal) delete forRow[col.id];
      else forRow[col.id] = value;
      const next = { ...prev };
      if (Object.keys(forRow).length === 0) delete next[row.id];
      else next[row.id] = forRow;
      return next;
    });
  }, []);

  /** 保存全部改动 */
  const handleSaveAll = useCallback(async () => {
    if (dirtyRows.length === 0) return;
    setSaving(true);
    let ok = 0;
    const failed: string[] = [];
    // 串行写：并发写同一个 xlsx 会互相抢文件（服务端是原子写+快照，串行最稳）
    for (const row of dirtyRows) {
      try {
        const updated = applyEdits(row.entry, row.edits);
        if (!updated.title.trim()) throw new Error('名字不能为空');
        // keepModal=true：否则每保存一格都会把本弹窗关掉
        await handleSaveAnime(updated, true);
        ok++;
      } catch (e) {
        failed.push(`「${row.entry.title}」${e instanceof Error ? e.message : '保存失败'}`);
      }
    }
    setSaving(false);
    if (failed.length === 0) {
      setEdits({});
      catgirlMessage.success(`已写回 Excel：${ok} 条`);
      await loadRaw(); // 公式列（赋分/偏差值）会随新分重算，重新取一遍
    } else {
      catgirlMessage.error(`${failed.length} 条保存失败：${failed.slice(0, 2).join('；')}`);
      // 成功的那些已经落盘，失败的重载后会以文件为准，避免界面显示未落盘的值
      await refreshAnimeList();
      await loadRaw();
      setEdits({});
    }
  }, [dirtyRows, handleSaveAnime, loadRaw, refreshAnimeList]);

  const handleDiscard = useCallback(() => {
    setEdits({});
    setEditing(null);
  }, []);

  const handleClose = useCallback(() => {
    if (dirtyCount > 0 && !window.confirm(`还有 ${dirtyCount} 条改动没有写回 Excel，确定放弃？`)) return;
    setEditing(null);
    setEdits({});
    onClose();
  }, [dirtyCount, onClose]);

  const columns = useMemo<ColumnsType<EditorRow>>(() => TABLE_COLUMNS.map((col) => {
    const numeric = isNumericCol(col);
    const header = (
      <span>
        {col.label}
        {!col.editable && col.readonlyReason
          ? <Tooltip title={col.readonlyReason}><LockOutlined style={{ marginLeft: 4, opacity: 0.45, fontSize: 10 }} /></Tooltip>
          : null}
      </span>
    );
    return {
      key: col.id,
      title: header,
      width: col.width,
      fixed: col.id === ROW_NUMBER_COL ? 'left' : (col.id === 'title' ? 'left' : undefined),
      // 数值列按大小排、其余按首字母排；排序由外面的 sortEditorRows 跨全表执行
      sorter: true,
      sortOrder: sortState?.columnId === col.id ? sortState.order : null,
      showSorterTooltip: { title: numeric ? '按数值排序（跨全部数据，不只是本页）' : '按首字母排序（跨全部数据，不只是本页）' },
      render: (_: unknown, row: EditorRow) => {
        const text = displayValue(row, col);
        const dirty = Object.prototype.hasOwnProperty.call(row.edits, col.id);

        // 只读列：纯文本，不做任何交互
        if (!col.editable || col.kind === 'readonly') {
          const isCategory = col.id === CATEGORY_COL;
          return (
            <span style={{
              color: isCategory ? 'var(--brand-primary)' : 'var(--text-secondary)',
              fontSize: 12, whiteSpace: 'nowrap',
            }}>
              {text || '—'}
            </span>
          );
        }

        const isEditing = editing?.rowId === row.id && editing?.colId === col.id;

        if (!isEditing) {
          return (
            <div
              onClick={() => { setEditing({ rowId: row.id, colId: col.id }); setDraft(text); draftRef.current = text; }}
              title={text}
              style={{
                minHeight: 24, cursor: 'text', borderRadius: 3, padding: '1px 5px',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                background: dirty ? 'color-mix(in srgb, var(--brand-primary) 16%, transparent)' : 'transparent',
                border: dirty ? '1px solid color-mix(in srgb, var(--brand-primary) 45%, transparent)' : '1px solid transparent',
              }}
            >
              {text || <span style={{ opacity: 0.35 }}>—</span>}
            </div>
          );
        }

        const commit = () => {
          stage(row, col, draftRef.current);
          setEditing(null);
        };

        const onKeyDown = (e: React.KeyboardEvent) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          if (e.key === 'Escape') { e.preventDefault(); setEditing(null); }
        };

        const valueProps = {
          size: 'small' as const,
          autoFocus: true,
          value: draft as string | number,
          onKeyDown,
          onBlur: commit,
        };

        if (col.kind === 'number' || col.kind === 'score') {
          return (
            <InputNumber
              {...valueProps}
              min={col.min}
              max={col.max}
              step={col.step}
              style={{ width: '100%' }}
              onChange={(v) => { const s = v === null || v === undefined ? '' : String(v); setDraft(s); draftRef.current = s; }}
            />
          );
        }
        return (
          <Input
            {...valueProps}
            onChange={(e) => { setDraft(e.target.value); draftRef.current = e.target.value; }}
          />
        );
      },
    };
  }), [editing, draft, stage, sortState]);

  const editableCount = TABLE_COLUMNS.filter((c) => c.editable).length;
  const readonlyCount = TABLE_COLUMNS.length - editableCount;

  return (
    <Modal
      title="📋 列表数据（应用内查看 / 编辑）"
      open={open}
      onCancel={handleClose}
      width="96vw"
      style={{ top: 16, maxWidth: 1700 }}
      footer={null}
      destroyOnHidden
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 10 }}
        message={`共 ${rows.length} 条番剧（角色卡与自定义模板不在这张表里）· ${editableCount} 列可改、${readonlyCount} 列只读`}
        description={
          <span style={{ fontSize: 12 }}>
            改动先在本地暂存（改过的格子有底色），点「保存修改」才写回 Excel。
            带 <LockOutlined style={{ fontSize: 10 }} /> 的列是公式列或你自己的列（赋分/内容/偏差值/较客观评分/列1/代餐/爬虫BGM），
            程序不写这些列，悬停表头可看原因。
          </span>
        }
      />

      <Space style={{ marginBottom: 10 }} wrap>
        <Input.Search
          allowClear
          placeholder="按名字 / 检索名筛选"
          style={{ width: 240 }}
          value={keyword}
          onChange={(e) => { setKeyword(e.target.value); setPage(1); }}
        />
        <Button
          type="primary"
          icon={<SaveOutlined />}
          disabled={dirtyCount === 0 || saving}
          loading={saving}
          onClick={handleSaveAll}
        >
          保存修改{dirtyCount > 0 ? ` (${dirtyCount})` : ''}
        </Button>
        <Button icon={<UndoOutlined />} disabled={dirtyCount === 0 || saving} onClick={handleDiscard}>
          撤销改动
        </Button>
        <Button icon={<ReloadOutlined />} disabled={saving} onClick={() => { setEdits({}); void loadRaw(); }}>
          重新读取
        </Button>
        <Button
          disabled={!sortState}
          onClick={() => { setSortState(null); setPage(1); }}
        >
          恢复原始顺序
        </Button>
        {dirtyCount > 0 && <Tag color="warning">{dirtyCount} 条未保存</Tag>}
        {sortState && (
          <Tag color="processing">
            已按「{TABLE_COLUMNS.find((c) => c.id === sortState.columnId)?.label}」
            {sortState.order === 'ascend' ? '升序' : '降序'} · 全部 {sortedRows.length} 条
          </Tag>
        )}
      </Space>

      <Spin spinning={loadingRaw}>
        <Table<EditorRow>
          size="small"
          rowKey="id"
          columns={columns}
          dataSource={sortedRows}
          pagination={{
            current: page,
            pageSize,
            showSizeChanger: true,
            pageSizeOptions: ['50', '100', '200'],
            showTotal: (t) => `共 ${t} 条`,
          }}
          onChange={(pag, _filters, sorter) => {
            const s = Array.isArray(sorter) ? sorter[0] : sorter;
            // 点第三下时 antd 给的是 undefined（取消排序）→ 回到 Excel 原始行序
            if (!s || !s.order || !s.columnKey) setSortState(null);
            else setSortState({ columnId: String(s.columnKey), order: s.order as SortOrder });
            // 页码由 antd 一起给过来；换页/换每页条数时保留排序
            setPage(pag.current ?? 1);
            setPageSize(pag.pageSize ?? 100);
          }}
          scroll={{ x: 'max-content', y: 'calc(100vh - 360px)' }}
          bordered
        />
      </Spin>
    </Modal>
  );
};

export default ExcelEditor;
