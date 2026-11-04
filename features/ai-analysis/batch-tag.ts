/**
 * features/ai-analysis/batch-tag — 批量打标签的生成与合并
 *
 * 为什么单独一个模块，而不是让对话里的 auto-tag 循环调用：
 *
 *   1. **轮数**：对话循环有 maxRounds 止损（默认 4 轮），一次只能覆盖几部；
 *      189 部要几十轮。
 *   2. **成本**：auto-tag 是「一部一次模型调用」，189 次 ≈ 40 分钟、189 次请求。
 *      批量任务应该由用户显式发起、能看进度、能中途取消，而不是藏在对话里慢慢磨。
 *   3. **写回**：对话里的 auto-tag 是只读的（effect: 'read'），只出建议；
 *      而要真正落地到 Excel，需要走 updateAnimeEntry —— 那是本模块和 UI 的事。
 *
 * 设计上的两个判断：
 *
 *   - **按 entry 处理，不按标题**。`auto-tag` 在对话里要先 resolveEntry(标题)，
 *     匹配不上就报「找不到这部番」；这里直接拿 AnimeEntry 对象，没有这个不确定性。
 *   - **只处理能写回的条目**（`excelRowIndex !== undefined`）。非默认模板的条目
 *     不走 Excel 行，updateAnimeEntry 定位不到，处理了也白处理。
 */

import type { AnimeEntry, AnimeTag } from '../../src/types';
import { autoTag } from './auto-tag';
import type { AIRun } from './ai-runtime';

/** 并发数。太高会被网关限流，太低 64 部要等到天荒地老 */
export const BATCH_TAG_CONCURRENCY = 4;

export type BatchTagScope = 'untagged' | 'all';

export type BatchTagStatus = 'pending' | 'running' | 'done' | 'failed';

export interface BatchTagItem {
  animeId: string;
  title: string;
  /** 已有标签名（用来判断"建议里哪些是新的"） */
  existingTags: string[];
  /** 模型建议、且**不存在于现有标签**里的那些 */
  suggested: { name: string; reason: string }[];
  status: BatchTagStatus;
  error?: string;
}

/** 挑出这一轮要处理的条目 */
export function planBatchTagTargets(list: AnimeEntry[], scope: BatchTagScope): AnimeEntry[] {
  // 没有 excelRowIndex 的写不回 Excel（非默认模板），batch 里处理它没有意义
  const writable = list.filter((a) => a.excelRowIndex !== undefined);
  if (scope === 'untagged') return writable.filter((a) => a.tags.length === 0);
  return writable;
}

/**
 * 去掉「已经存在」和「自己重复」的建议。
 * 模型经常把已有标签再建议一遍，不过滤的话界面上会显示一堆假的新增。
 */
export function diffSuggested(
  existingTags: string[],
  suggested: { name: string; reason: string }[],
): { name: string; reason: string }[] {
  const seen = new Set(existingTags);
  const out: { name: string; reason: string }[] = [];
  for (const s of suggested) {
    const name = (s?.name || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, reason: (s.reason || '').trim() });
  }
  return out;
}

/** 合并后的条目（纯函数，便于测试） */
export function buildTaggedEntry(entry: AnimeEntry, names: string[]): AnimeEntry {
  const existing = new Set(entry.tags.map((t) => t.name));
  const added: AnimeTag[] = names
    .map((n) => n.trim())
    .filter((n) => n && !existing.has(n))
    .map((name) => ({ name, highlighted: true }));
  if (added.length === 0) return entry;
  return { ...entry, tags: [...entry.tags, ...added] };
}

/**
 * 从整库统计出「已有标签库」，喂给模型让它优先复用。
 * 按使用次数倒序取前 N 个：长尾只出现一次的标签对复用没有帮助，还会把 prompt 撑长。
 */
export function buildTagVocabulary(list: AnimeEntry[], limit = 120): string[] {
  const counts = new Map<string, number>();
  for (const a of list) {
    for (const t of a.tags) {
      const key = (t.name || '').trim();
      if (key) counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
    .slice(0, limit)
    .map(([name]) => name);
}

export interface RunBatchTagOptions {
  targets: AnimeEntry[];
  concurrency?: number;
  signal?: AbortSignal;
  run?: AIRun;
  /** 已有标签库；不传则从 targets + 其它条目里现算一个 */
  vocabulary?: string[];
  /** 每部开始 / 结束时回调，UI 靠它实时更新 */
  onItemChange?: (item: BatchTagItem) => void;
}

/**
 * 逐部生成建议（有限并发）。
 *
 * 取消语义：点「停止」后不再开始新的条目，**已经跑完的结果保留** ——
 * 中途丢掉会让用户白等几分钟。
 */
export async function runBatchTag(opts: RunBatchTagOptions): Promise<BatchTagItem[]> {
  const { targets, onItemChange } = opts;
  const limit = Math.max(1, opts.concurrency ?? BATCH_TAG_CONCURRENCY);
  // 一次算好，别在每部里重复统计
  const vocabulary = opts.vocabulary ?? buildTagVocabulary(targets);

  const items: BatchTagItem[] = targets.map((a) => ({
    animeId: a.id,
    title: a.title,
    existingTags: a.tags.map((t) => t.name),
    suggested: [],
    status: 'pending' as BatchTagStatus,
  }));

  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= targets.length) return;
      if (opts.signal?.aborted) return; // 不再开始新的，已完成的结果保留

      const target = targets[index];
      items[index] = { ...items[index], status: 'running', error: undefined };
      onItemChange?.(items[index]);

      try {
        const result = await autoTag(target, { signal: opts.signal, run: opts.run, vocabulary });
        const fresh = diffSuggested(items[index].existingTags, result.suggestedTags || []);
        items[index] = { ...items[index], status: 'done', suggested: fresh };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        items[index] = { ...items[index], status: 'failed', error: message, suggested: [] };
      }
      onItemChange?.(items[index]);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(limit, targets.length) }, worker),
  );

  return items;
}

/** 统计（UI 顶部汇总用） */
export function summarizeBatchTag(items: BatchTagItem[]): {
  total: number; done: number; failed: number; pending: number;
  withNewTags: number; newTagCount: number;
} {
  let done = 0, failed = 0, pending = 0, withNewTags = 0, newTagCount = 0;
  for (const it of items) {
    if (it.status === 'done') done++;
    else if (it.status === 'failed') failed++;
    else pending++;
    if (it.suggested.length > 0) {
      withNewTags++;
      newTagCount += it.suggested.length;
    }
  }
  return { total: items.length, done, failed, pending, withNewTags, newTagCount };
}
