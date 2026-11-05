/**
 * 批量打标签
 *
 * 三步：选范围 → 并发生成（可取消）→ 逐部勾选后写回 Excel。
 *
 * 为什么不做成"一键全自动"：标签是用户自己的分类体系，模型建议里总会有
 * 你不想要的（比如把「治愈」贴到一部致郁番上）。所以中间必须有预览这一步，
 * 而且默认**全选但可逐条取消** —— 64 部 × 5 个标签，一个个点太痛苦。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Button, Segmented, Progress, Checkbox, Tag as AntTag, Alert, Empty, Input } from 'antd';
import { catgirlMessage } from '../theme';
import { getAIPermission } from '../../features/ai-analysis';
import { canAIPropose, AI_PERMISSION_INFO } from '../../core/ai-permission';
import { planBatchTagTargets, runBatchTag, buildTaggedEntry, summarizeBatchTag } from '../../features/ai-analysis/batch-tag';
import type { BatchTagItem, BatchTagScope } from '../../features/ai-analysis/batch-tag';
import { updateAnimeEntries } from '../../features/anime-data/excel-service';
import type { AnimeEntry } from '../types';

interface BatchTagModalProps {
  open: boolean;
  onClose: () => void;
  animeList: AnimeEntry[];
  /** 当前模板：批量只处理这一类对象（番剧 / 角色卡分开打标签） */
  templateId?: string | null;
  /** 写回成功后让外层刷新列表 */
  onApplied: () => void;
}

type Phase = 'idle' | 'running' | 'preview';

const BatchTagModal: React.FC<BatchTagModalProps> = ({ open, onClose, animeList, templateId, onApplied }) => {
  const [scope, setScope] = useState<BatchTagScope>('untagged');
  const [phase, setPhase] = useState<Phase>('idle');
  const [items, setItems] = useState<BatchTagItem[]>([]);
  /** 每部被勾选的标签名 */
  const [accepted, setAccepted] = useState<Record<string, string[]>>({});
  const [applying, setApplying] = useState(false);
  const [filter, setFilter] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const permission = getAIPermission();
  const permInfo = AI_PERMISSION_INFO[permission];
  const allowed = canAIPropose(permission);

  /**
   * 只处理当前模板下的条目。
   * 番剧和角色卡是两种对象，混在一起打标签会让标签池互相污染
   * （实测两边标签交集只有 119 / 724）。
   */
  const scoped = useMemo(() => {
    if (!templateId) return animeList;
    return animeList.filter((a) => (templateId === 'default'
      ? !a.templateId || a.templateId === 'default'
      : a.templateId === templateId));
  }, [animeList, templateId]);

  const targets = useMemo(() => planBatchTagTargets(scoped, scope), [scoped, scope]);
  const untaggedCount = useMemo(
    () => planBatchTagTargets(scoped, 'untagged').length,
    [scoped],
  );
  const writableCount = useMemo(
    () => planBatchTagTargets(scoped, 'all').length,
    [scoped],
  );

  // 关掉时把状态清干净，下次打开是全新一轮
  useEffect(() => {
    if (open) return;
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase('idle');
    setItems([]);
    setAccepted({});
    setApplying(false);
    setFilter('');
  }, [open]);

  const start = useCallback(async () => {
    if (!allowed) {
      catgirlMessage.warning(`当前是「${permInfo.label}」权限，不能应用标签。去 AI 设置里改成「提议后确认」`);
      return;
    }
    if (targets.length === 0) {
      catgirlMessage.info('这个范围里没有可处理的条目');
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;

    const planned: BatchTagItem[] = targets.map((a) => ({
      animeId: a.id,
      title: a.title,
      existingTags: a.tags.map((t) => t.name),
      suggested: [],
      status: 'pending' as const,
    }));
    setItems(planned);
    setAccepted({});
    setPhase('running');

    const result = await runBatchTag({
      targets,
      signal: controller.signal,
      // 词库按模板分组统计（传整库，让它自己按 templateId 分开，不串味）
      library: animeList,
      onItemChange: (item) => {
        setItems((prev) => prev.map((it) => (it.animeId === item.animeId ? item : it)));
      },
    });

    abortRef.current = null;
    setItems(result);
    setPhase('preview');
    // 默认全选：这是"批量"的意义所在，逐条取消比逐条勾选现实
    const next: Record<string, string[]> = {};
    for (const it of result) {
      if (it.suggested.length > 0) next[it.animeId] = it.suggested.map((s) => s.name);
    }
    setAccepted(next);

    const aborted = controller.signal.aborted;
    const s = summarizeBatchTag(result);
    if (aborted) catgirlMessage.info(`已停止，保留了已完成的 ${s.done} 部`);
    else if (s.failed > 0) catgirlMessage.warning(`生成完成，${s.failed} 部失败（可重试）`);
  }, [allowed, permInfo.label, targets]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const toggleTag = useCallback((animeId: string, name: string, checked: boolean) => {
    setAccepted((prev) => {
      const current = prev[animeId] || [];
      const next = checked ? [...current, name] : current.filter((n) => n !== name);
      return { ...prev, [animeId]: next };
    });
  }, []);

  const apply = useCallback(async () => {
    const byId = new Map(animeList.map((a) => [a.id, a]));
    const jobs: { entry: AnimeEntry; names: string[] }[] = [];
    for (const it of items) {
      const names = accepted[it.animeId] || [];
      if (names.length === 0) continue;
      const entry = byId.get(it.animeId);
      if (!entry) continue;
      jobs.push({ entry, names });
    }
    if (jobs.length === 0) {
      catgirlMessage.info('没有勾选任何标签');
      return;
    }

    setApplying(true);
    try {
      // 一次请求写完：服务端会「读整表 → 改行 → 写整表」，逐条发会把 10 份快照的
      // 滚动窗口挤满，批处理**开始前**的状态就回退不了了；一次写也只留一条操作日志。
      const chosen = jobs
        .map((job) => buildTaggedEntry(job.entry, job.names))
        // 没有任何实际新增的条目不用发，省一次无谓的整表写
        .filter((entry, i) => entry !== jobs[i].entry);
      if (chosen.length === 0) {
        catgirlMessage.info('勾选的标签都已经存在了');
        setApplying(false);
        return;
      }
      const written = await updateAnimeEntries(chosen);
      const tagTotal = jobs.reduce((n, j) => n + j.names.length, 0);
      catgirlMessage.success(`已给 ${written} 部番剧补上 ${tagTotal} 个标签（一次写入，可整批回退）`);
      onApplied();
      onClose();
    } catch (e) {
      catgirlMessage.error(`写入失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setApplying(false);
    }
  }, [accepted, animeList, items, onApplied, onClose]);

  const summary = summarizeBatchTag(items);
  const selectedCount = Object.values(accepted).filter((v) => v.length > 0).length;
  const selectedTagTotal = Object.values(accepted).reduce((n, v) => n + v.length, 0);

  const shown = useMemo(() => {
    const kw = filter.trim().toLowerCase();
    if (!kw) return items;
    return items.filter((it) => it.title.toLowerCase().includes(kw));
  }, [filter, items]);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={760}
      title="🏷 批量打标签"
      destroyOnClose
    >
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.8, marginBottom: 12 }}>
        模型会逐部给出建议标签，生成完再让你逐条勾选。数字和现有标签都来自本地，模型只负责建议。
      </div>

      {!allowed && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={`当前权限是「${permInfo.label}」`}
          description="这一档下 AI 不能提出数据改动。去 AI 设置改成「提议后确认」就能用了。"
        />
      )}

      {/* ── 第一步：选范围 ── */}
      {phase === 'idle' && (
        <>
          <Segmented
            block
            value={scope}
            onChange={(v) => setScope(v as BatchTagScope)}
            options={[
              { label: `只补没标签的（${untaggedCount} 部）`, value: 'untagged' },
              { label: `全部可写条目（${writableCount} 部）`, value: 'all' },
            ]}
            style={{ marginBottom: 12 }}
          />
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.8, marginBottom: 12 }}>
            每部一次模型调用，并发 4 路。{targets.length} 部大约需要{' '}
            {Math.max(1, Math.round((targets.length * 12) / 4 / 60))} 分钟。
            中途可以停，已生成的会保留。
          </div>
          <Button type="primary" block onClick={() => void start()} disabled={!allowed || targets.length === 0}>
            开始生成（{targets.length} 部）
          </Button>
        </>
      )}

      {/* ── 第二步：生成中 ── */}
      {phase === 'running' && (
        <>
          <Progress
            percent={summary.total ? Math.round(((summary.done + summary.failed) / summary.total) * 100) : 0}
            status="active"
            size="small"
          />
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '8px 0 12px' }}>
            已完成 {summary.done} / {summary.total}
            {summary.failed > 0 ? `，失败 ${summary.failed}` : ''}
          </div>
          <Button danger block onClick={stop}>停止（保留已完成的）</Button>
        </>
      )}

      {/* ── 第三步：预览并应用 ── */}
      {phase === 'preview' && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              {summary.withNewTags} 部有新标签，共 {summary.newTagCount} 个建议
              {summary.failed > 0 ? ` · ${summary.failed} 部失败` : ''}
            </span>
            <div style={{ flex: 1 }} />
            <Input
              size="small"
              allowClear
              placeholder="筛选番名"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              style={{ width: 160 }}
            />
          </div>

          <div style={{
            maxHeight: 380, overflowY: 'auto', border: '1px solid var(--border-primary)',
            borderRadius: 6, padding: 8,
          }}>
            {shown.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的条目" />}
            {shown.map((it) => (
              <div key={it.animeId} style={{
                padding: '6px 4px', borderBottom: '1px solid var(--border-primary)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-primary)' }}>
                  <span>{it.status === 'done' ? '✅' : it.status === 'failed' ? '⚠️' : '⏳'}</span>
                  <span style={{ fontWeight: 600 }}>{it.title}</span>
                  {it.suggested.length === 0 && it.status === 'done' && (
                    <span style={{ color: 'var(--text-secondary)' }}>（没有新标签）</span>
                  )}
                  {it.status === 'failed' && (
                    <span style={{ color: 'var(--brand-primary)' }}>（{it.error}）</span>
                  )}
                </div>
                {it.suggested.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                    {it.suggested.map((s) => {
                      const checked = (accepted[it.animeId] || []).includes(s.name);
                      return (
                        <AntTag
                          key={s.name}
                          title={s.reason}
                          color={checked ? 'blue' : undefined}
                          style={{ cursor: 'pointer', opacity: checked ? 1 : 0.45, marginInlineEnd: 0 }}
                          onClick={() => toggleTag(it.animeId, s.name, !checked)}
                        >
                          {checked ? '✓ ' : ''}{s.name}
                        </AntTag>
                      );
                    })}
                  </div>
                )}
                {it.existingTags.length > 0 && (
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 3 }}>
                    已有：{it.existingTags.join('、')}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              已选 {selectedCount} 部 / {selectedTagTotal} 个标签
            </span>
            <div style={{ flex: 1 }} />
            <Button onClick={() => setPhase('idle')} disabled={applying}>重来</Button>
            <Button type="primary" loading={applying} onClick={() => void apply()} disabled={selectedCount === 0}>
              应用到 Excel
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
};

export default BatchTagModal;
