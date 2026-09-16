/**
 * 角色立绘去白底面板。
 *
 * 为什么是「批量处理 + 逐张预览勾选」而不是一键全自动：
 * 全量实测 100 张真实角色立绘，88 张处理干净，12 张不干净 ——
 * 它们并非算法调参能救的（装饰边框把白底封在框里、拼贴图、
 * 背景根本不是白底的实景照）。纯像素算法无法区分「框内白底」
 * 和「角色的白衣服」，所以最终必须由人看预览决定。
 *
 * 数据安全：去底结果另存为 cover-nobg.png，**不覆盖原图、不改 Excel**。
 * 撤销就是删掉那个文件，随时可以来回切。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Button, Progress, Checkbox, Tag, Alert, Tooltip, Empty, Segmented, Space } from 'antd';
import { BgColorsOutlined, UndoOutlined, ThunderboltOutlined } from '@ant-design/icons';
import type { AnimeEntry } from '../../src/types';
import { CHARACTER_TEMPLATE_ID } from '../../src/types';
import { catgirlMessage } from '../../src/theme';
import {
  createCutout,
  saveCutout,
  removeCutout,
  loadCutoutIndex,
  getCachedCutoutIndex,
  cutoutDirFor,
  type CutoutResult,
} from './cutout-service';

interface CharacterCutoutModalProps {
  open: boolean;
  onClose: () => void;
  animeList: AnimeEntry[];
}

type Phase = 'idle' | 'running' | 'saving';
type ItemStatus = 'pending' | 'working' | 'ok' | 'failed' | 'saved';

interface CutoutItem {
  id: string;
  title: string;
  posterUrl: string;
  /** 去底图的存取目录：必须跟海报同目录，否则卡片按 URL 目录名查索引会查不到 */
  dir: string;
}

interface ItemState {
  status: ItemStatus;
  result?: CutoutResult;
  error?: string;
}

type FilterMode = 'all' | 'suspect' | 'applied';

const CharacterCutoutModal: React.FC<CharacterCutoutModalProps> = ({ open, onClose, animeList }) => {
  const [states, setStates] = useState<Record<string, ItemState>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [phase, setPhase] = useState<Phase>('idle');
  const [done, setDone] = useState(0);
  const [filter, setFilter] = useState<FilterMode>('all');
  const [savedNames, setSavedNames] = useState<Set<string>>(() => getCachedCutoutIndex());
  /** 中断标志：关闭面板或点「停止」时置位，处理循环下一轮退出 */
  const cancelRef = useRef(false);

  /** 只处理角色模板且已有海报的条目 —— 去底是给角色卡用的，不该动番剧海报 */
  const items = useMemo<CutoutItem[]>(
    () => animeList
      .filter((a) => a.templateId === CHARACTER_TEMPLATE_ID && !!a.posterUrl)
      .map((a) => {
        const posterUrl = a.posterUrl as string;
        return { id: a.id, title: a.title, posterUrl, dir: cutoutDirFor(posterUrl, a.title) };
      }),
    [animeList],
  );

  useEffect(() => {
    if (!open) return;
    setStates({});
    setSelected(new Set());
    setPhase('idle');
    setDone(0);
    setFilter('all');
    cancelRef.current = false;
    void loadCutoutIndex(true).then(() => setSavedNames(new Set(getCachedCutoutIndex())));
  }, [open]);

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  /** 逐张处理。像素算法是同步的，每张之间让出主线程，否则进度条根本不动 */
  const handleRun = useCallback(async () => {
    if (items.length === 0) { catgirlMessage.warning('没有可处理的角色卡'); return; }
    const targets = items.filter((it) => filter === 'all' || (filter === 'suspect'
      ? (states[it.id]?.result?.hints.length ?? 1) > 0
      : savedNames.has(it.dir)));
    if (targets.length === 0) { catgirlMessage.warning('当前筛选下没有要处理的条目'); return; }

    cancelRef.current = false;
    setPhase('running');
    setDone(0);
    const autoSelect = new Set<string>();

    for (let i = 0; i < targets.length; i++) {
      if (cancelRef.current) break;
      const it = targets[i];
      setStates((prev) => ({ ...prev, [it.id]: { status: 'working' } }));
      try {
        const result = await createCutout(it.posterUrl);
        if (result.hints.length === 0) autoSelect.add(it.id);
        setStates((prev) => ({ ...prev, [it.id]: { status: 'ok', result } }));
      } catch (e) {
        const msg = e instanceof Error ? e.message : '处理失败';
        setStates((prev) => ({ ...prev, [it.id]: { status: 'failed', error: msg } }));
      }
      setDone(i + 1);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    setSelected(autoSelect);
    setPhase('idle');
    const stopped = cancelRef.current;
    cancelRef.current = false;
    catgirlMessage.success(
      `去底完成：自动勾选 ${autoSelect.size} 张干净的${stopped ? '（已提前停止）' : ''}`,
    );
  }, [items, filter, states, savedNames]);

  const handleSave = useCallback(async () => {
    const targets = items.filter((it) => selected.has(it.id) && states[it.id]?.result);
    if (targets.length === 0) { catgirlMessage.warning('还没有勾选任何要应用的角色'); return; }
    setPhase('saving');
    let ok = 0;
    let fail = 0;
    for (const it of targets) {
      try {
        await saveCutout(it.dir, states[it.id]!.result!.dataUrl);
        ok++;
        setStates((prev) => ({ ...prev, [it.id]: { ...prev[it.id], status: 'saved' } }));
      } catch {
        fail++;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await loadCutoutIndex(true);
    setSavedNames(new Set(getCachedCutoutIndex()));
    setPhase('idle');
    catgirlMessage.success(fail === 0 ? `已应用 ${ok} 张去底立绘` : `应用 ${ok} 张，失败 ${fail} 张`);
  }, [items, selected, states]);

  const handleUndo = useCallback(async (item: CutoutItem) => {
    try {
      await removeCutout(item.dir);
      await loadCutoutIndex(true);
      setSavedNames(new Set(getCachedCutoutIndex()));
      setStates((prev) => {
        const next = { ...prev };
        const result = next[item.id]?.result;
        if (result) next[item.id] = { status: 'ok', result };
        else delete next[item.id];
        return next;
      });
      catgirlMessage.success(`已撤销「${item.title}」的去底`);
    } catch (e) {
      catgirlMessage.error(e instanceof Error ? e.message : '撤销失败');
    }
  }, []);

  /** 按筛选显示；未处理过的条目在「需核对 / 已应用」下不显示 */
  const visible = useMemo(() => items.filter((it) => {
    if (filter === 'all') return true;
    const st = states[it.id];
    if (filter === 'suspect') return !!st?.result && st.result.hints.length > 0;
    return savedNames.has(it.dir);
  }), [items, filter, states, savedNames]);

  /**
   * 全选 / 全不选。
   * 自动勾选是「宁可漏不可错」的保守策略，但用户常常只想留几张 ——
   * 没有这两个按钮就只能一张张点掉，实测连开发自己都点不动。
   */
  const selectAllVisible = useCallback(() => {
    setSelected(new Set(visible.filter((it) => states[it.id]?.result).map((it) => it.id)));
  }, [visible, states]);

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  const counts = useMemo(() => {
    let clean = 0;
    let suspect = 0;
    let failed = 0;
    for (const it of items) {
      const st = states[it.id];
      if (!st) continue;
      if (st.status === 'failed') failed++;
      else if (st.result) {
        if (st.result.hints.length === 0) clean++; else suspect++;
      }
    }
    return { clean, suspect, failed };
  }, [items, states]);

  const savedCount = items.filter((it) => savedNames.has(it.dir)).length;
  const running = phase === 'running';
  const busy = phase !== 'idle';

  const footer = [
    <Button key="close" onClick={() => { cancelRef.current = true; onClose(); }}>关闭</Button>,
    running ? (
      <Button key="stop" danger onClick={() => { cancelRef.current = true; }}>停止</Button>
    ) : (
      <Button
        key="run"
        icon={<ThunderboltOutlined />}
        onClick={handleRun}
        disabled={items.length === 0 || busy}
      >
        开始解析（{filter === 'all' ? items.length : visible.length} 张）
      </Button>
    ),
    <Button
      key="save"
      type="primary"
      icon={<BgColorsOutlined />}
      onClick={handleSave}
      disabled={selected.size === 0 || busy}
      loading={phase === 'saving'}
    >
      应用选中的 {selected.size} 张
    </Button>,
  ];

  return (
    <Modal
      open={open}
      onCancel={() => { cancelRef.current = true; onClose(); }}
      width={1080}
      title="角色立绘去白底"
      footer={footer}
      destroyOnClose={false}
      styles={{ body: { maxHeight: '68vh', overflowY: 'auto' } }}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="把角色立绘的白色背景变成透明，角色会直接浮在卡片底色上"
        description="原图不会被修改：去底结果另存为 cover-nobg.png，随时可以撤销。默认只勾选算法认为干净的；标「需核对」的是背景不是一整片白的图（装饰边框、拼贴图、实景照），建议对照原图确认后再决定。"
      />

      {items.length === 0 ? (
        <Empty description="当前没有带海报的角色卡（只处理角色模板的条目）" />
      ) : (
        <>
          <Space wrap style={{ marginBottom: 10 }}>
            <Segmented
              value={filter}
              onChange={(v) => setFilter(v as FilterMode)}
              options={[
                { label: `全部 ${items.length}`, value: 'all' },
                { label: `需核对 ${counts.suspect}`, value: 'suspect' },
                { label: `已应用 ${savedCount}`, value: 'applied' },
              ]}
            />
            <Button size="small" onClick={selectAllVisible} disabled={busy}>全选</Button>
            <Button size="small" onClick={clearSelection} disabled={busy || selected.size === 0}>全不选</Button>
            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
              已解析 {done}/{items.length} · 干净 {counts.clean} · 需核对 {counts.suspect}
              {counts.failed > 0 ? ` · 失败 ${counts.failed}` : ''} · 已勾选 {selected.size}
            </span>
          </Space>

          {running && (
            <Progress
              percent={items.length ? Math.round((done / items.length) * 100) : 0}
              status="active"
              style={{ marginBottom: 10 }}
            />
          )}

          <div className="cutout-grid">
            {visible.map((it) => {
              const st = states[it.id];
              const result = st?.result;
              const displayUrl = result ? result.dataUrl : it.posterUrl;
              const isSaved = savedNames.has(it.dir);
              const suspect = !!result && result.hints.length > 0;
              return (
                <div className="cutout-cell" key={it.id}>
                  <div
                    className={`cutout-thumb${selected.has(it.id) ? ' is-selected' : ''}`}
                    onClick={() => { if (result) toggleSelect(it.id); }}
                    title={result ? '点击勾选 / 取消；悬停看原图' : it.title}
                  >
                    <img src={displayUrl} alt={it.title} loading="lazy" />
                    {/* 悬停时叠上原图，方便一张一张对比边缘 */}
                    {result && <img className="cutout-orig" src={it.posterUrl} alt={`${it.title} 原图`} loading="lazy" />}
                    {result && (
                      <Checkbox
                        className="cutout-check"
                        checked={selected.has(it.id)}
                        // 必须挡住冒泡：外层 .cutout-thumb 也有「点击切换选中」，
                        // 不拦的话一次点击会 toggle 两下、等于没点。
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggleSelect(it.id)}
                      />
                    )}
                    {st?.status === 'working' && <div className="cutout-mask">解析中…</div>}
                  </div>
                  <div className="cutout-name" title={it.title}>{it.title}</div>
                  <div className="cutout-tags">
                    {st?.status === 'working' && <Tag color="processing">处理中</Tag>}
                    {st?.status === 'failed' && (
                      <Tooltip title={st.error}>
                        <Tag color="error">失败</Tag>
                      </Tooltip>
                    )}
                    {result && !suspect && <Tag color="success">干净</Tag>}
                    {result && suspect && (
                      <Tooltip title={result.hints.join('；')}>
                        <Tag color="warning">需核对</Tag>
                      </Tooltip>
                    )}
                    {isSaved && (
                      <Tooltip title="点击撤销，恢复用原图">
                        <Tag
                          color="cyan"
                          style={{ cursor: 'pointer' }}
                          onClick={(e) => { e.stopPropagation(); void handleUndo(it); }}
                        >
                          <UndoOutlined /> 已应用
                        </Tag>
                      </Tooltip>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </Modal>
  );
};

export default CharacterCutoutModal;
