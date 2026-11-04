/**
 * server/operations-log — 数据写操作日志（{DATA_DIR}/operations.jsonl）
 *
 * 为什么要有它：
 *   backups/ 里的多代快照只有「时间戳 + 内容 hash」两个信息，事后根本看不出
 *   哪一份对应哪次改动 —— 想回退只能凭时间猜。这里把每次写 Excel 记成一条
 *   结构化记录，并带上「写前快照的文件名」，于是「退回到某次操作之前」就从
 *   『去文件夹里翻』变成『在列表里点一下』。
 *
 * 三条约束：
 *   1. 追加写（一行一条），不重写整个文件 —— 记日志不能成为慢操作；
 *   2. append 永不抛错 —— 日志写失败不该让用户的保存一起失败
 *      （与 snapshotExcel 的处理一致：宁可少记一件事，不能挡住写数据）；
 *   3. 读的时候容忍坏行 —— 进程中途被杀会留下半行 JSON，
 *      一行坏掉只跳过那一行，不能整个日志都读不出来。
 */

import fs from 'fs';
import path from 'path';

/** 谁触发的写操作。AI 写操作必须能从这里和手动操作区分开 */
export type OperationSource = 'user' | 'ai' | 'system';

export interface OperationEntry {
  /** ISO 时间（服务端生成，不信任客户端时钟） */
  at: string;
  /** 机器可读类型，如 'excel.write' / 'backup.restore' */
  op: string;
  source: OperationSource;
  /** 一句人话，列表里直接显示 */
  summary: string;
  /** 写前快照文件名（不含目录）；「退回到这次之前」靠它 */
  snapshot?: string;
  /** 结构化细节：涉及作品、行号、字段等，供将来做细粒度 diff */
  detail?: unknown;
}

export interface OperationLog {
  append(entry: Omit<OperationEntry, 'at'> & { at?: string }): void;
  /** 最新的在前 */
  read(limit?: number): OperationEntry[];
  /** 日志文件绝对路径，便于错误提示里告诉用户去哪找 */
  readonly path: string;
}

/** 超过这个大小就轮转，只留一代历史。2MB ≈ 上万条，够用且不会无限长 */
const MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_LIMIT = 100;

export function createOperationLog(dataDir: string): OperationLog {
  const filePath = path.join(dataDir, 'operations.jsonl');
  const rotatedPath = path.join(dataDir, 'operations.1.jsonl');

  function rotateIfNeeded(): void {
    try {
      if (!fs.existsSync(filePath)) return;
      if (fs.statSync(filePath).size <= MAX_BYTES) return;
      // 覆盖上一代：留一份「上一次轮转的」已经足够追问题
      if (fs.existsSync(rotatedPath)) fs.unlinkSync(rotatedPath);
      fs.renameSync(filePath, rotatedPath);
    } catch { /* 轮转失败不该影响写入，下一次写再说 */ }
  }

  return {
    get path() {
      return filePath;
    },

    append(entry) {
      try {
        rotateIfNeeded();
        const line: OperationEntry = {
          // 调用方传了 at 就用它的（导入这种批量操作需要标记原始时间），否则取现在
          at: entry.at || new Date().toISOString(),
          op: entry.op,
          source: entry.source,
          summary: entry.summary,
          ...(entry.snapshot ? { snapshot: entry.snapshot } : {}),
          ...(entry.detail === undefined ? {} : { detail: entry.detail }),
        };
        fs.appendFileSync(filePath, JSON.stringify(line) + '\n', 'utf-8');
      } catch (e) {
        // 故意吞掉：日志是辅助手段，不能因为它让保存失败
        console.warn('[operations] 写日志失败:', e instanceof Error ? e.message : e);
      }
    },

    read(limit = DEFAULT_LIMIT) {
      try {
        if (!fs.existsSync(filePath)) return [];
        const text = fs.readFileSync(filePath, 'utf-8');
        const out: OperationEntry[] = [];
        for (const raw of text.split('\n')) {
          const line = raw.trim();
          if (!line) continue;
          try {
            const parsed = JSON.parse(line) as OperationEntry;
            // 形状校验：缺关键字段的行直接丢，避免前端拿到半截对象
            if (parsed && typeof parsed.at === 'string' && typeof parsed.op === 'string') {
              out.push(parsed);
            }
          } catch { /* 半行 JSON：跳过 */ }
        }
        // 最新在前，前端列表直接顺序渲染
        return out.slice(-Math.max(1, limit)).reverse();
      } catch {
        return [];
      }
    },
  };
}
