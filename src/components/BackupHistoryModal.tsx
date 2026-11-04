/**
 * 存档与回退
 *
 * 解决一个具体的焦虑：「我知道改动前有备份，但我不知道是哪一份、也不知道怎么退回去」。
 * 这里把 backups/ 的多代快照和写操作日志摆在一起：
 *   - 操作记录：每次写 Excel 干了什么、谁干的（手动 / AI / 系统）、改之前是哪份快照
 *   - 存档快照：按时间排，可以一键恢复到任意一份
 *
 * 两个安全设计：
 *   1. 恢复前服务端会先把当前状态也存成快照 —— 恢复错了还能再退回来
 *   2. 恢复要过 Popconfirm，且明确提示「会覆盖当前数据源」
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Modal, Button, Tag, Empty, Spin, Popconfirm, Tabs, Tooltip } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { catgirlMessage } from '../theme';
import { hasPreImportSnapshot, rollbackLastImport } from '../../features/anime-data/storage-service';
import {
  fetchSnapshots,
  restoreSnapshot,
  fetchOperations,
  opIcon,
  sourceLabel,
  formatOpTime,
  formatBytes,
} from '../../features/anime-data/backup-history';
import type { SnapshotInfo, OperationEntry } from '../../features/anime-data/backup-history';

interface BackupHistoryModalProps {
  open: boolean;
  onClose: () => void;
  /** 恢复成功后通知外部重新加载数据（内存里的列表已经过期了） */
  onRestored?: () => void;
}

const BackupHistoryModal: React.FC<BackupHistoryModalProps> = ({ open, onClose, onRestored }) => {
  const [snapshots, setSnapshots] = useState<SnapshotInfo[]>([]);
  const [operations, setOperations] = useState<OperationEntry[]>([]);
  const [keep, setKeep] = useState(10);
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [tab, setTab] = useState('ops');
  const [preImport, setPreImport] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [snap, ops] = await Promise.all([fetchSnapshots(), fetchOperations(200)]);
      setSnapshots(snap.snapshots || []);
      setKeep(snap.keep || 10);
      setOperations(ops);
    } catch (e) {
      catgirlMessage.error('读取存档失败：' + (e instanceof Error ? e.message : '未知错误'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void loadAll();
  }, [open, loadAll]);

  // 「导入用户数据」覆盖过本地设置时，快照还留着 —— 这里给出回滚入口
  useEffect(() => {
    if (open) setPreImport(hasPreImportSnapshot());
  }, [open]);

  const handleRollbackImport = useCallback(() => {
    try {
      const { restored, removed, skipped } = rollbackLastImport();
      setPreImport(false);
      catgirlMessage.success(
        `已回滚导入前的本地设置：恢复 ${restored} 项`
        + (removed ? `，移除 ${removed} 项` : '')
        + (skipped ? `，跳过 ${skipped} 项` : '')
        + '。刷新页面后生效',
      );
    } catch (e) {
      catgirlMessage.error('回滚失败：' + (e instanceof Error ? e.message : '未知错误'));
    }
  }, []);

  const handleRestore = useCallback(async (name: string) => {
    setRestoring(name);
    try {
      const result = await restoreSnapshot(name);
      catgirlMessage.success(
        result.revertTo
          ? '已恢复。恢复前的状态也存了一份，退错了可以再退回来'
          : '已恢复',
      );
      onRestored?.();
      await loadAll();
    } catch (e) {
      catgirlMessage.error('恢复失败：' + (e instanceof Error ? e.message : '未知错误'));
    } finally {
      setRestoring(null);
    }
  }, [loadAll, onRestored]);

  const timeOfSnapshot = useCallback((name: string) => {
    const hit = snapshots.find((s) => s.name === name);
    if (!hit) return null;
    return hit.at ? formatOpTime(hit.at) : name;
  }, [snapshots]);

  /** 每行右侧的恢复按钮：快照不存在（已被清理）时禁用 */
  const renderRestoreButton = (name: string, label = '恢复', size: 'small' | 'middle' = 'small') => {
    const exists = snapshots.some((s) => s.name === name);
    if (!exists) {
      return (
        <Tooltip title="该快照已被清理（最多保留最近若干份），无法恢复">
          <Button size={size} disabled>不可恢复</Button>
        </Tooltip>
      );
    }
    return (
      <Popconfirm
        title="恢复到这份快照？"
        description="当前数据源会被覆盖。恢复前会自动把现在的状态也存一份，所以退错了还能再退回来。"
        okText="恢复"
        cancelText="取消"
        onConfirm={() => void handleRestore(name)}
      >
        <Button size={size} loading={restoring === name} type="primary" ghost>
          {label}
        </Button>
      </Popconfirm>
    );
  };

  const opsView = loading && operations.length === 0 ? (
    <div style={{ padding: 40, textAlign: 'center' }}><Spin /></div>
  ) : operations.length === 0 ? (
    <Empty
      description="还没有记录到写操作。改动数据后这里会自动出现记录。"
      image={Empty.PRESENTED_IMAGE_SIMPLE}
    />
  ) : (
    <div className="backup-op-list">
      {operations.map((op, i) => {
        const src = sourceLabel(op.source);
        return (
          <div
            key={`${op.at}-${i}`}
            className="backup-op-row"
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              padding: '8px 4px',
              borderBottom: '1px solid var(--border-primary)',
            }}
          >
            <span style={{ fontSize: 15, lineHeight: '20px' }}>{opIcon(op.op)}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, color: 'var(--text-primary)', wordBreak: 'break-word' }}>
                {op.summary}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                {formatOpTime(op.at)}
                <Tag
                  bordered={false}
                  style={{ marginLeft: 8, fontSize: 10, lineHeight: '16px', color: src.color }}
                >
                  {src.text}
                </Tag>
                {op.snapshot && (
                  <span style={{ marginLeft: 4 }}>
                    · 改前快照 {timeOfSnapshot(op.snapshot) || '（已清理）'}
                  </span>
                )}
              </div>
            </div>
            {op.snapshot && (
              <div style={{ flexShrink: 0 }}>
                {renderRestoreButton(op.snapshot, '退回到之前')}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  const snapView = loading && snapshots.length === 0 ? (
    <div style={{ padding: 40, textAlign: 'center' }}><Spin /></div>
  ) : snapshots.length === 0 ? (
    <Empty
      description="还没有任何快照。下一次写入 Excel 时会自动留存一份。"
      image={Empty.PRESENTED_IMAGE_SIMPLE}
    />
  ) : (
    <div>
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', padding: '4px 2px 8px' }}>
        每次写入 Excel 前自动留存，内容相同的不会重复存；最多保留最近 {keep} 份。
      </div>
      {snapshots.map((snap) => (
        <div
          key={snap.name}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '8px 4px',
            borderBottom: '1px solid var(--border-primary)',
          }}
        >
          <span style={{ fontSize: 15 }}>{snap.isCurrent ? '📍' : '🗂'}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, color: 'var(--text-primary)' }}>
              {snap.at ? formatOpTime(snap.at) : snap.name}
              {snap.isCurrent && (
                <Tag bordered={false} color="green" style={{ marginLeft: 8, fontSize: 10 }}>
                  当前数据
                </Tag>
              )}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
              {formatBytes(snap.size)} · {snap.hash}
            </div>
          </div>
          <div style={{ flexShrink: 0 }}>
            {snap.isCurrent ? (
              <Tooltip title="这份内容和当前数据一致，恢复它没有意义">
                <Button size="small" disabled>已是当前</Button>
              </Tooltip>
            ) : (
              renderRestoreButton(snap.name)
            )}
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={720}
      title="存档与回退"
      styles={{ body: { maxHeight: '70vh', overflowY: 'auto' } }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <Button size="small" icon={<ReloadOutlined />} onClick={() => void loadAll()} loading={loading}>
          刷新
        </Button>
        <span style={{ fontSize: 11, color: 'var(--text-secondary)', flex: 1 }}>
          数值改动都走 Excel 写盘，每次写前会自动留一份快照。
        </span>
      </div>

      {preImport && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '8px 10px',
            marginBottom: 8,
            borderRadius: 6,
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-primary)',
          }}
        >
          <span style={{ fontSize: 14 }}>📦</span>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)', flex: 1 }}>
            检测到一次「导入用户数据」留下的快照，可以把导入前的本地设置（主题、模板、雷达图等）退回来。
          </span>
          <Popconfirm
            title="回滚上次导入的本地设置？"
            description="只回滚本地设置；Excel 与图片请用「存档快照」回退。"
            okText="回滚"
            cancelText="取消"
            onConfirm={handleRollbackImport}
          >
            <Button size="small" ghost type="primary">回滚上次导入</Button>
          </Popconfirm>
        </div>
      )}

      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: 'ops',
            label: `操作记录${operations.length ? `（${operations.length}）` : ''}`,
            children: opsView,
          },
          {
            key: 'snaps',
            label: `存档快照${snapshots.length ? `（${snapshots.length}）` : ''}`,
            children: snapView,
          },
        ]}
      />
    </Modal>
  );
};

export default BackupHistoryModal;
