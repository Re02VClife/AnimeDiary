/**
 * 合并重复角色卡
 *
 * 同一角色在多部作品（同系列续作/客串）里出现时，早期会各建一张卡
 * （实测 101 张卡里有 10 组同名，其中山田杏奈有三张）。这个面板把重复组合并成一张。
 *
 * 安全性：
 *   - 每一组都让你选「保留哪张」，并**先给出合并后的预览**（哪个字段来自哪张）
 *   - 评分/评价/备注这些你自己的内容，冲突时会标出来，默认以保留卡为准
 *   - **不物理删行**：被合并掉的卡走应用既有的软删除（localStorage 黑名单），
 *     行号不错位、海报覆盖与其它行不受影响，而且可以撤销
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, Button, Space, Typography, Tag, Radio, Table, Checkbox, Alert, Empty, Tooltip, Segmented } from 'antd';
import { MergeCellsOutlined, UndoOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { AnimeEntry, DimensionScore } from '../../src/types';
import { CHARACTER_TEMPLATE_ID } from '../../src/types';
import { saveCharacterCardData } from '../anime-data/excel-service';
import { addToWatchingDeleted, removeFromWatchingDeleted, loadDimReviews, saveDimReviews } from '../anime-data/storage-service';
import { getTemplate } from '../anime-data/template-service';
import { catgirlMessage } from '../../src/theme';
import {
  buildDuplicateGroups, computeMergedCard, removedCards, cardRichness,
} from './merge-duplicates';
import type { MergePlan } from './merge-duplicates';

const { Text } = Typography;

interface CharacterMergeModalProps {
  open: boolean;
  onClose: () => void;
  animeList: AnimeEntry[];
  /** 合并完成后静默刷新（不要用会触发整屏 loading 的 fetchData） */
  onApplied: () => void;
}

const rowLabel = (c: AnimeEntry) => (c.excelRowIndex !== undefined ? `行${c.excelRowIndex + 1}` : '—');

const CharacterMergeModal: React.FC<CharacterMergeModalProps> = ({ open, onClose, animeList, onApplied }) => {
  const [plans, setPlans] = useState<MergePlan[]>([]);
  const [busy, setBusy] = useState(false);
  /** 已合并记录（用于撤销） */
  const [lastMerged, setLastMerged] = useState<{ keptTitle: string; removedIds: string[] }[] | null>(null);

  const isCharacterCard = useCallback(
    (a: AnimeEntry) => a.templateId === CHARACTER_TEMPLATE_ID,
    [],
  );

  const rebuild = useCallback(() => {
    setPlans(buildDuplicateGroups(animeList, isCharacterCard));
    setLastMerged(null);
  }, [animeList, isCharacterCard]);

  useEffect(() => {
    if (open) rebuild();
  }, [open, rebuild]);

  const patchPlan = (key: string, patch: Partial<MergePlan>) => {
    setPlans((prev) => prev.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  };

  const selectedPlans = useMemo(() => plans.filter((p) => p.selected), [plans]);
  const totalRemoved = useMemo(
    () => selectedPlans.reduce((n, p) => n + p.cards.length - 1, 0),
    [selectedPlans],
  );

  /** 合并选中的组 */
  const handleMerge = async () => {
    const targets = selectedPlans;
    if (targets.length === 0) { catgirlMessage.warning('先勾选要合并的重复组'); return; }
    setBusy(true);
    const mergedLog: { keptTitle: string; removedIds: string[] }[] = [];
    let okCount = 0, failCount = 0;

    // 维度专项评价按 entry.id 存在 localStorage，被移除卡片的要迁到保留卡
    const dimReviewMap = loadDimReviews();
    let dimReviewMoved = 0;

    for (const plan of targets) {
      const kept = plan.cards.find((c) => c.id === plan.keptId) || plan.cards[0];
      const removed = removedCards(plan);
      try {
        const merged = computeMergedCard(plan);
        // 1) 先把合并结果写进保留卡（窄写入：只写资料/评分/海报/链接/评价/备注/观看时间）
        const needWrite = merged.scores.length > 0
          || Object.values(merged.customFields).some((v) => v)
          || !!merged.posterUrl || !!merged.link || !!merged.review || !!merged.notes || !!merged.watchDate;
        if (needWrite) {
          // 保留卡原本没有的值才需要写；评分取并集后若为空则保持原样
          const scores: DimensionScore[] = merged.scores.length > 0 ? merged.scores : (kept.scores || []);
          await saveCharacterCardData({ ...kept, scores }, {
            customFields: merged.customFields,
            posterUrl: kept.posterUrl ? undefined : merged.posterUrl || undefined,
            link: kept.link ? undefined : merged.link || undefined,
            review: kept.review ? undefined : merged.review || undefined,
            notes: kept.notes ? undefined : merged.notes || undefined,
            watchDate: kept.watchDate ? undefined : merged.watchDate || undefined,
          });
        }

        // 2) 迁移维度专项评价（保留卡已有的同维度不覆盖）
        for (const r of removed) {
          const from = dimReviewMap[r.id];
          if (!from || from.length === 0) continue;
          const to = dimReviewMap[kept.id] || [];
          for (const review of from) {
            if (to.some((x) => x.dimensionKey === review.dimensionKey)) continue;
            to.push(review);
            dimReviewMoved++;
          }
          dimReviewMap[kept.id] = to;
          delete dimReviewMap[r.id];
        }

        // 3) 软删除多余的卡（不动 Excel 行）
        for (const r of removed) addToWatchingDeleted(r.id);

        mergedLog.push({ keptTitle: kept.title, removedIds: removed.map((r) => r.id) });
        okCount++;
      } catch (e) {
        failCount++;
        console.error('[合并角色卡] 失败：', plan.title, e);
      }
    }

    saveDimReviews(dimReviewMap);

    setBusy(false);
    setLastMerged(mergedLog);
    catgirlMessage.success(
      `已合并 ${okCount} 组、移除 ${mergedLog.reduce((n, m) => n + m.removedIds.length, 0)} 张重复卡`
      + (dimReviewMoved > 0 ? `，迁移 ${dimReviewMoved} 条维度专项评价` : '')
      + (failCount > 0 ? `；${failCount} 组失败（详见控制台）` : '')
      + '。可点「撤销本次合并」恢复。',
    );
    onApplied();
    rebuild();
    // 保留撤销记录（rebuild 会清空，这里放回去）
    setLastMerged(mergedLog);
  };

  /** 撤销：把软删除的卡片恢复 */
  const handleUndo = () => {
    if (!lastMerged || lastMerged.length === 0) return;
    let n = 0;
    for (const m of lastMerged) for (const id of m.removedIds) { removeFromWatchingDeleted(id); n++; }
    setLastMerged(null);
    catgirlMessage.success(`已恢复 ${n} 张卡片（合并写入的资料未回退，评分等仍以保留卡为准）`);
    onApplied();
    rebuild();
  };

  /** 合并后保留卡的评分维度是否与模板匹配（历史卡可能带已废弃的维度） */
  const templateDims = useMemo(() => {
    try { return new Set(getTemplate(CHARACTER_TEMPLATE_ID).dimensions.map((d) => d.key)); } catch { return new Set<string>(); }
  }, []);

  const columns: ColumnsType<MergePlan> = useMemo(() => [
    {
      title: '角色 / 重复组',
      width: 190,
      render: (_: unknown, plan: MergePlan) => (
        <Space direction="vertical" size={2}>
          <Text strong style={{ fontSize: 12 }}>{plan.title}</Text>
          <Tag color={plan.cards.length > 2 ? 'red' : 'orange'} style={{ fontSize: 10 }}>
            {plan.cards.length} 张重复
          </Tag>
        </Space>
      ),
    },
    {
      title: '保留哪一张',
      width: 330,
      render: (_: unknown, plan: MergePlan) => {
        const merged = computeMergedCard(plan);
        return (
          <Space direction="vertical" size={2} style={{ width: '100%' }}>
            <Radio.Group
              size="small"
              value={plan.keptId}
              onChange={(e) => patchPlan(plan.key, { keptId: e.target.value })}
            >
              <Space direction="vertical" size={2}>
                {plan.cards.map((c) => {
                  const cf = c.customFields || {};
                  const scoreCount = (c.scores || []).filter((s) => Number(s.score) > 0).length;
                  return (
                    <Radio key={c.id} value={c.id} style={{ fontSize: 11 }}>
                      <Text style={{ fontSize: 11 }}>{rowLabel(c)}</Text>
                      <Text type="secondary" style={{ fontSize: 10, marginLeft: 6 }}>
                        {scoreCount > 0 ? `评分${scoreCount}项 ` : '无评分 '}
                        {String(cf.char_profile || '').length > 0 ? `人设${String(cf.char_profile).length}字 ` : ''}
                        {c.posterUrl ? '有海报 ' : ''}
                        {c.link ? '有链接' : ''}
                      </Text>
                      {c.id === plan.keptId && cardRichness(c) >= Math.max(...plan.cards.map(cardRichness))
                        ? <Tag color="green" style={{ fontSize: 9, marginLeft: 4 }}>推荐</Tag> : null}
                    </Radio>
                  );
                })}
              </Space>
            </Radio.Group>
            <Space size={6}>
              <Text type="secondary" style={{ fontSize: 10 }}>详细人设</Text>
              <Segmented
                size="small"
                value={plan.profileMode}
                onChange={(v) => patchPlan(plan.key, { profileMode: v as 'longer' | 'kept' })}
                options={[{ value: 'longer', label: '取最长' }, { value: 'kept', label: '只认保留卡' }]}
              />
            </Space>
            {merged.scoreConflicts.length > 0 && (
              <Text type="warning" style={{ fontSize: 10 }}>
                评分冲突：{merged.scoreConflicts.join('、')}（默认取保留卡的值）
              </Text>
            )}
          </Space>
        );
      },
    },
    {
      title: '合并后的结果（预览）',
      render: (_: unknown, plan: MergePlan) => {
        const merged = computeMergedCard(plan);
        const removed = removedCards(plan);
        const staleDims = merged.scores.filter((s) => !templateDims.has(s.dimensionKey)).map((s) => s.dimensionKey);
        return (
          <Space direction="vertical" size={2} style={{ width: '100%' }}>
            <Text style={{ fontSize: 11 }}>
              所属作品：<Text code style={{ fontSize: 11 }}>{merged.customFields.char_source || '(空)'}</Text>
            </Text>
            <Space size={8} wrap>
              <Text style={{ fontSize: 11 }}>评分 {merged.scores.length} 项</Text>
              <Text style={{ fontSize: 11 }}>声优 {merged.customFields.char_cv || '—'}</Text>
              <Text style={{ fontSize: 11 }}>人设 {merged.customFields.char_profile.length} 字</Text>
              {merged.watchDate ? <Text style={{ fontSize: 11 }}>观看时间 {merged.watchDate}</Text> : null}
            </Space>
            {staleDims.length > 0 && (
              <Text type="secondary" style={{ fontSize: 10 }}>
                含已废弃维度：{staleDims.join('、')}（模板里已删除，保留原值不影响显示）
              </Text>
            )}
            <Text type="danger" style={{ fontSize: 10 }}>
              将移除：{removed.map((r) => rowLabel(r)).join('、')}（软删除，可撤销）
            </Text>
          </Space>
        );
      },
    },
  ], [patchPlan, templateDims]);

  return (
    <Modal
      open={open}
      onCancel={() => { if (!busy) onClose(); }}
      width={1080}
      className="media-complete-modal"
      title="合并重复角色卡"
      footer={null}
      destroyOnClose={false}
      maskClosable={!busy}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="同名角色卡会被合并成一张：资料取并集、评分取各维度有值的、你自己的评价/备注只在保留卡没有时才搬过来。"
        description="被合并掉的卡走「软删除」（不删 Excel 行）—— 行号不错位，海报覆盖和其它行都不受影响，随时可以撤销。"
      />

      <Space style={{ marginBottom: 12 }} wrap>
        <Button
          type="primary"
          icon={<MergeCellsOutlined />}
          loading={busy}
          disabled={totalRemoved === 0}
          onClick={() => void handleMerge()}
        >
          合并选中的 {selectedPlans.length} 组（移除 {totalRemoved} 张）
        </Button>
        <Button
          disabled={busy || plans.length === 0}
          onClick={() => setPlans((prev) => prev.map((p) => ({ ...p, selected: true })))}
        >
          全选
        </Button>
        <Button
          disabled={busy || plans.length === 0}
          onClick={() => setPlans((prev) => prev.map((p) => ({ ...p, selected: false })))}
        >
          全不选
        </Button>
        <Button icon={<UndoOutlined />} disabled={busy || !lastMerged} onClick={handleUndo}>
          撤销本次合并
        </Button>
        <Text type="secondary" style={{ fontSize: 11 }}>
          共 {plans.length} 组重复、涉及 {plans.reduce((n, p) => n + p.cards.length, 0)} 张卡
        </Text>
      </Space>

      <Table<MergePlan>
        rowKey={(p) => p.key}
        size="small"
        columns={columns}
        dataSource={plans}
        pagination={{ pageSize: 10, size: 'small', showSizeChanger: false }}
        rowSelection={{
          selectedRowKeys: plans.filter((p) => p.selected).map((p) => p.key),
          onChange: (keys) => setPlans((prev) => prev.map((p) => ({ ...p, selected: keys.includes(p.key) }))),
          getCheckboxProps: () => ({ disabled: busy }),
        }}
        locale={{ emptyText: <Empty description="没有重复的角色卡" /> }}
        scroll={{ y: 460 }}
      />
    </Modal>
  );
};

export default CharacterMergeModal;
