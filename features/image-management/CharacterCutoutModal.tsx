/**
 * 角色立绘去白底面板。
 *
 * 两条引擎，同一套流程（解析 → 逐张预览 → 勾选 → 应用），结果文件也完全一样：
 *
 *   白底洪泛  Canvas 本地算，0.1s/张。只对「背景就是一整片白」的立绘有效 ——
 *             实测 100 张里 88 张干净，12 张因为装饰边框 / 拼贴图 / 实景背景而失效。
 *   AI 抠图    服务端 isnet-anime 推理，约 0.5s/张。实景背景、拼贴图、装饰边框
 *             都能处理，且靠语义识别保住角色身上的白色（白大褂、白帽子、白袜）。
 *
 * 为什么必须保留人工环节：即便 AI 也偶有争议样本（例如「蕾娜」用的其实是一张
 * 番剧封面而不是立绘），所以一律先出预览、由人决定要不要应用。
 *
 * 数据安全：两条路都只写派生的 cover-nobg.png，**不覆盖原图、不改 Excel**；
 * AI 更是先落 cover-nobg.preview.png，确认后才改名转正，随时可撤销。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Button, Progress, Checkbox, Tag, Alert, Tooltip, Empty, Segmented, Space } from 'antd';
import { BgColorsOutlined, UndoOutlined, ThunderboltOutlined, ExperimentOutlined } from '@ant-design/icons';
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
  applyCutout,
  loadAiStatus,
  aiCutout,
  applyAiCutout,
  describeAiQuality,
  type CutoutResult,
  type AiCutoutResult,
  type AiCutoutStatus,
  type CutoutEngine,
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
  /** 送进 AI 的源文件名（从海报 URL 解析，缺省 cover.jpg） */
  sourceFile: string;
}

interface ItemState {
  status: ItemStatus;
  /** 洪泛结果（内存里的 PNG dataURL） */
  result?: CutoutResult;
  /** AI 结果（服务端暂存文件的预览 URL） */
  aiResult?: AiCutoutResult;
  error?: string;
}

type FilterMode = 'all' | 'suspect' | 'applied';

const CharacterCutoutModal: React.FC<CharacterCutoutModalProps> = ({ open, onClose, animeList }) => {
  const [states, setStates] = useState<Record<string, ItemState>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [phase, setPhase] = useState<Phase>('idle');
  const [done, setDone] = useState(0);
  const [filter, setFilter] = useState<FilterMode>('all');
  const [engine, setEngine] = useState<CutoutEngine>('ai');
  const [aiStatus, setAiStatus] = useState<AiCutoutStatus | null>(null);
  const [savedNames, setSavedNames] = useState<Set<string>>(() => getCachedCutoutIndex());
  /** 中断标志：关闭面板或点「停止」时置位，处理循环下一轮退出 */
  const cancelRef = useRef(false);

  /** 只处理角色模板且已有海报的条目 —— 去底是给角色卡用的，不该动番剧海报 */
  const items = useMemo<CutoutItem[]>(
    () => animeList
      .filter((a) => a.templateId === CHARACTER_TEMPLATE_ID && !!a.posterUrl)
      .map((a) => {
        const posterUrl = a.posterUrl as string;
        const fileMatch = posterUrl.match(/[?&]file=([^&]+)/);
        return {
          id: a.id,
          title: a.title,
          posterUrl,
          dir: cutoutDirFor(posterUrl, a.title),
          sourceFile: fileMatch ? decodeURIComponent(fileMatch[1]) : 'cover.jpg',
        };
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
    void loadAiStatus().then((s) => {
      setAiStatus(s);
      // AI 不可用时自动退回洪泛，别让用户点了才发现
      if (!s || !s.ready) setEngine('flood');
    });
  }, [open]);

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  /** 逐张处理。洪泛是同步像素运算、AI 是本地 HTTP，每张之间都让出主线程让进度条能动 */
  const handleRun = useCallback(async () => {
    if (items.length === 0) { catgirlMessage.warning('没有可处理的角色卡'); return; }
    const targets = items.filter((it) => filter === 'all' || (filter === 'suspect'
      ? (states[it.id]?.result?.hints.length ?? 1) > 0
      : savedNames.has(it.dir)));
    if (targets.length === 0) { catgirlMessage.warning('当前筛选下没有要处理的条目'); return; }
    if (engine === 'ai' && !aiStatus?.ready) {
      catgirlMessage.warning('AI 运行时未就绪，已切回白底洪泛');
      setEngine('flood');
      return;
    }

    cancelRef.current = false;
    setPhase('running');
    setDone(0);
    const autoSelect = new Set<string>();

    for (let i = 0; i < targets.length; i++) {
      if (cancelRef.current) break;
      const it = targets[i];
      setStates((prev) => ({ ...prev, [it.id]: { status: 'working' } }));
      try {
        if (engine === 'ai') {
          const ai = await aiCutout(it.dir, it.sourceFile);
          if (describeAiQuality(ai).length === 0) autoSelect.add(it.id);
          setStates((prev) => ({ ...prev, [it.id]: { status: 'ok', aiResult: ai } }));
        } else {
          const result = await createCutout(it.posterUrl);
          if (result.hints.length === 0) autoSelect.add(it.id);
          setStates((prev) => ({ ...prev, [it.id]: { status: 'ok', result } }));
        }
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
      `${engine === 'ai' ? 'AI 抠图' : '去底'}完成：自动勾选 ${autoSelect.size} 张干净的${stopped ? '（已提前停止）' : ''}`,
    );
  }, [items, filter, states, savedNames, engine, aiStatus]);

  const handleSave = useCallback(async () => {
    const targets = items.filter((it) => selected.has(it.id) && (states[it.id]?.aiResult || states[it.id]?.result));
    if (targets.length === 0) { catgirlMessage.warning('还没有勾选任何要应用的角色'); return; }
    setPhase('saving');
    let ok = 0;
    let fail = 0;
    for (const it of targets) {
      try {
        const st = states[it.id]!;
        if (st.aiResult) {
          // AI 结果已经在磁盘上，转正只是改名
          await applyAiCutout(it.dir, 'apply');
        } else if (st.result) {
          await saveCutout(it.dir, st.result.dataUrl);
        } else {
          continue;
        }
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
        if (next[item.id]) next[item.id] = { ...next[item.id], status: 'ok' };
        return next;
      });
      catgirlMessage.success(`已撤销「${item.title}」的去底`);
    } catch (e) {
      catgirlMessage.error(e instanceof Error ? e.message : '撤销失败');
    }
  }, []);

  /** 丢弃没转正的 AI 暂存结果 */
  const handleDiscard = useCallback(async (item: CutoutItem) => {
    try {
      await applyAiCutout(item.dir, 'discard');
      setStates((prev) => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
      catgirlMessage.success(`已丢弃「${item.title}」的 AI 结果`);
    } catch (e) {
      catgirlMessage.error(e instanceof Error ? e.message : '丢弃失败');
    }
  }, []);

  /** 按筛选显示；未处理过的条目在「需核对 / 已应用」下不显示 */
  const visible = useMemo(() => items.filter((it) => {
    if (filter === 'all') return true;
    const st = states[it.id];
    if (filter === 'suspect') {
      const hints = st?.aiResult ? describeAiQuality(st.aiResult) : (st?.result?.hints ?? []);
      return hints.length > 0;
    }
    return savedNames.has(it.dir);
  }), [items, filter, states, savedNames]);

  /**
   * 全选 / 全不选。
   * 自动勾选是「宁可漏不可错」的保守策略，但用户常常只想留几张 ——
   * 没有这两个按钮就只能一张张点掉，实测连开发自己都点不动。
   */
  const selectAllVisible = useCallback(() => {
    setSelected(new Set(visible.filter((it) => states[it.id]?.result || states[it.id]?.aiResult).map((it) => it.id)));
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
      else {
        const hints = st.aiResult ? describeAiQuality(st.aiResult) : (st.result?.hints ?? null);
        if (hints === null) continue;
        if (hints.length === 0) clean++; else suspect++;
      }
    }
    return { clean, suspect, failed };
  }, [items, states]);

  const savedCount = items.filter((it) => savedNames.has(it.dir)).length;
  const running = phase === 'running';
  const busy = phase !== 'idle';
  const aiReady = !!aiStatus?.ready;
  const currentLabel = engine === 'ai' ? 'AI 抠图' : '去底';

  const footer = [
    <Button key="close" onClick={() => { cancelRef.current = true; onClose(); }}>关闭</Button>,
    running ? (
      <Button key="stop" danger onClick={() => { cancelRef.current = true; }}>停止</Button>
    ) : (
      <Button
        key="run"
        icon={engine === 'ai' ? <ExperimentOutlined /> : <ThunderboltOutlined />}
        onClick={handleRun}
        disabled={items.length === 0 || busy || (engine === 'ai' && !aiReady)}
      >
        开始{currentLabel}（{filter === 'all' ? items.length : visible.length} 张）
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
        message="把角色立绘的背景变成透明，角色会直接浮在卡片底色上"
        description="原图不会被修改：结果另存为 cover-nobg.png，随时可以撤销。AI 抠图会先出预览、确认后才转正。默认只勾选算法认为干净的；标「需核对」的建议对照原图（鼠标悬停缩略图可看原图）后再决定。"
      />

      {items.length === 0 ? (
        <Empty description="当前没有带海报的角色卡（只处理角色模板的条目）" />
      ) : (
        <>
          <Space wrap style={{ marginBottom: 10 }}>
            <Segmented
              value={engine}
              onChange={(v) => setEngine(v as CutoutEngine)}
              disabled={busy}
              options={[
                { label: 'AI 抠图（推荐）', value: 'ai', disabled: !aiReady },
                { label: '快速（白底洪泛）', value: 'flood' },
              ]}
            />
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
          </Space>

          {!aiReady && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 10 }}
              message="AI 抠图不可用，已使用白底洪泛"
              description={
                aiStatus?.error
                  ? `原因：${aiStatus.error}`
                  : `缺少抠图模型或运行时（模型：${aiStatus ? aiStatus.modelPath : '未知'}）`
              }
            />
          )}

          {running && (
            <Progress
              percent={items.length ? Math.round((done / items.length) * 100) : 0}
              status="active"
              style={{ marginBottom: 10 }}
            />
          )}

          <Space wrap style={{ marginBottom: 10 }}>
            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
              已解析 {done}/{items.length} · 干净 {counts.clean} · 需核对 {counts.suspect}
              {counts.failed > 0 ? ` · 失败 ${counts.failed}` : ''} · 已勾选 {selected.size}
              {aiReady && aiStatus ? ` · 模型 ${aiStatus.modelMB}MB` : ''}
            </span>
          </Space>

          <div className="cutout-grid">
            {visible.map((it) => {
              const st = states[it.id];
              const aiRes = st?.aiResult;
              const floodRes = st?.result;
              const hints = aiRes ? describeAiQuality(aiRes) : (floodRes?.hints ?? []);
              const hasResult = !!aiRes || !!floodRes;
              const isSaved = savedNames.has(it.dir);
              /**
               * 已应用的卡片要显示**去底后的图**，不是原图。
               * 以前这里直接退回 it.posterUrl，于是「已应用 174 张」的标签下面
               * 全是没有去底的原图，看起来像根本没生效（同一个面板里还会跟
               * 少数海报列直接存了 cover-nobg.png 的卡片表现不一致）。
               * applyCutout 自己会判断目录在不在索引里，没去底的仍返回原图。
               */
              const displayUrl = aiRes ? aiRes.url
                : floodRes ? floodRes.dataUrl
                  : applyCutout(it.posterUrl, savedNames);
              const suspect = hasResult && hints.length > 0;
              return (
                <div className="cutout-cell" key={it.id}>
                  <div
                    className={`cutout-thumb${selected.has(it.id) ? ' is-selected' : ''}`}
                    onClick={() => { if (hasResult) toggleSelect(it.id); }}
                    title={hasResult ? '点击勾选 / 取消；悬停看原图' : it.title}
                  >
                    <img src={displayUrl} alt={it.title} loading="lazy" />
                    {/* 悬停时叠上原图，方便一张一张对比边缘 */}
                    {hasResult && <img className="cutout-orig" src={it.posterUrl} alt={`${it.title} 原图`} loading="lazy" />}
                    {hasResult && (
                      <Checkbox
                        className="cutout-check"
                        checked={selected.has(it.id)}
                        // 必须挡住冒泡：外层 .cutout-thumb 也有「点击切换选中」，
                        // 不拦的话一次点击会 toggle 两下、等于没点。
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggleSelect(it.id)}
                      />
                    )}
                    {st?.status === 'working' && <div className="cutout-mask">{engine === 'ai' ? 'AI 处理中…' : '解析中…'}</div>}
                  </div>
                  <div className="cutout-name" title={it.title}>{it.title}</div>
                  <div className="cutout-tags">
                    {st?.status === 'working' && <Tag color="processing">处理中</Tag>}
                    {st?.status === 'failed' && (
                      <Tooltip title={st.error}>
                        <Tag color="error">失败</Tag>
                      </Tooltip>
                    )}
                    {hasResult && !suspect && <Tag color="success">{aiRes ? 'AI · 干净' : '干净'}</Tag>}
                    {hasResult && suspect && (
                      <Tooltip title={hints.join('；')}>
                        <Tag color="warning">需核对</Tag>
                      </Tooltip>
                    )}
                    {hasResult && !isSaved && aiRes && (
                      <Tooltip title="丢弃这份 AI 预览">
                        <Tag
                          color="default"
                          style={{ cursor: 'pointer' }}
                          onClick={(e) => { e.stopPropagation(); void handleDiscard(it); }}
                        >
                          未应用
                        </Tag>
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
