/**
 * features/anime-data/backup-history — 存档历史与回退（浏览器侧）
 *
 * 背景：服务端一直在写 backups/ 多代快照，但没有任何入口能把它们列出来或恢复回去，
 * 于是"有备份"只存在于代码里。这里补上三件事：
 *   1. 列出快照（时间 / 大小 / 是否等于当前数据）
 *   2. 恢复到指定快照（恢复前服务端会先把当前状态也拍一张，所以恢复本身可回退）
 *   3. 读最近的写操作日志，每条带「写前快照」，可以退回到某次操作之前
 *
 * 与 storage-service 的 exportAllUserData / importUserData 的区别：
 *   那两个是「整包搬家」（换机用），这里是「原地回到某个时间点」（改坏了用）。
 */

export interface SnapshotInfo {
  name: string;
  /** UTC ISO；解析不出来为 null（手工拷进 backups/ 的文件） */
  at: string | null;
  size: number;
  hash: string;
  /** 与当前 Excel 内容一致 —— 恢复它等于什么都没做 */
  isCurrent: boolean;
}

export type OperationSource = 'user' | 'ai' | 'system';

export interface OperationEntry {
  at: string;
  op: string;
  source: OperationSource;
  summary: string;
  /** 写前快照文件名；有它就能「退回到这次操作之前」 */
  snapshot?: string;
  detail?: unknown;
}

async function readError(resp: Response, fallback: string): Promise<Error> {
  const err = await resp.json().catch(() => null);
  return new Error((err && (err.error || err.message)) || fallback);
}

/** 列出多代快照（新的在前） */
export async function fetchSnapshots(): Promise<{ snapshots: SnapshotInfo[]; keep: number; dir: string }> {
  const resp = await fetch('/api/backup/snapshots');
  if (!resp.ok) throw await readError(resp, `读取快照失败 HTTP ${resp.status}`);
  return resp.json();
}

/** 恢复到指定快照 */
export async function restoreSnapshot(name: string): Promise<{ restoredFrom: string; revertTo: string | null }> {
  const resp = await fetch('/api/backup/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!resp.ok) throw await readError(resp, `恢复失败 HTTP ${resp.status}`);
  const data = await resp.json();
  if (!data?.success) throw new Error(data?.error || '恢复失败');
  return data;
}

/** 最近的写操作（新的在前） */
export async function fetchOperations(limit = 100): Promise<OperationEntry[]> {
  const resp = await fetch(`/api/operations?limit=${limit}`);
  if (!resp.ok) throw await readError(resp, `读取操作日志失败 HTTP ${resp.status}`);
  const data = await resp.json();
  return Array.isArray(data?.entries) ? data.entries : [];
}

/** 操作类型 → 图标，列表里一眼看出发生了什么 */
export function opIcon(op: string): string {
  switch (op) {
    case 'excel.write': return '✏️';
    case 'excel.append': return '➕';
    case 'excel.delete-row': return '🗑';
    case 'excel.replace': return '📥';
    case 'excel.fix-posters': return '🖼';
    case 'backup.import': return '📦';
    case 'backup.restore': return '⏪';
    default: return '•';
  }
}

/** 来源标签：AI 写操作必须一眼可辨（三档权限要靠它审计） */
export function sourceLabel(source: OperationSource): { text: string; color: string } {
  switch (source) {
    case 'ai': return { text: 'AI', color: 'var(--brand-primary)' };
    case 'system': return { text: '系统', color: 'var(--text-secondary)' };
    default: return { text: '手动', color: 'var(--text-secondary)' };
  }
}

/** 把 ISO 时间格式化成「今天 14:03」这种好读的样子 */
export function formatOpTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (sameDay) return `今天 ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${time}`;
  return `${d.toLocaleDateString('zh-CN')} ${time}`;
}

/** 字节数 → 好读的大小 */
export function formatBytes(bytes: number): string {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
