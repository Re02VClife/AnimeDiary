/**
 * core/ai-proposal — AI 改动提议
 *
 * AI 不该直接写数据，而是产出一份 Proposal：「对《X》加标签 A、B」。
 * 调用方（详情面板 / 将来的对话窗口）负责把 before/after 摆出来，
 * 用户确认后再 apply —— confirm 档靠它落地，write 档也要走同一条路径（只是跳过确认），
 * 这样「AI 改了什么」永远有同一份结构可查、可撤销。
 *
 * 为什么每条改动都带 baseValues（改前值）：
 *   提议生成和落库之间可能隔了几分钟，这中间用户自己也可能改过同一个字段。
 *   apply 前比对 baseValues，对不上就拒绝 —— 绝不能用一条过期的提议覆盖新数据。
 *   这比「事后发现标签被 AI 悄悄覆盖了」便宜得多。
 */

export interface ProposedFieldChange {
  /** 字段名，如 'tags' / 'scores.电波' */
  field: string;
  before: unknown;
  after: unknown;
}

export interface ProposedItemChange {
  animeId: string;
  animeTitle: string;
  changes: ProposedFieldChange[];
}

export interface AIProposal {
  /** 会话内唯一，用于撤销时找回 */
  id: string;
  kind: 'tags' | 'scores' | 'mixed';
  title: string;
  items: ProposedItemChange[];
  /** 生成时间（ms），用于展示与判断新鲜度 */
  createdAt: number;
}

let proposalSeq = 0;

function nextProposalId(): string {
  proposalSeq += 1;
  return `proposal-${Date.now().toString(36)}-${proposalSeq}`;
}

/** 组装一份提议；没有任何实际改动时返回 null（别给用户看一份空提议） */
export function createProposal(
  kind: AIProposal['kind'],
  title: string,
  items: ProposedItemChange[],
): AIProposal | null {
  const effective = items
    .map((item) => ({
      ...item,
      changes: item.changes.filter((c) => !isSameValue(c.before, c.after)),
    }))
    .filter((item) => item.changes.length > 0);
  if (effective.length === 0) return null;
  return { id: nextProposalId(), kind, title, items: effective, createdAt: Date.now() };
}

/** 标签提议：给某部番补上若干新标签（已存在的不重复加，全都有则返回 null） */
export function createTagProposal(
  animeId: string,
  animeTitle: string,
  existingTags: readonly string[],
  suggestedTags: readonly string[],
): AIProposal | null {
  // 用同一个集合同时挡住「已存在」和「模型自己返回重复」——
  // 后者是真会发生的（同一部番输出两次"群像剧"），漏了就会把重复标签写进 Excel
  const seen = new Set(existingTags.map((t) => t.trim()));
  const additions: string[] = [];
  for (const raw of suggestedTags) {
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    additions.push(name);
  }
  if (additions.length === 0) return null;
  return createProposal('tags', `给《${animeTitle}》加 ${additions.length} 个标签`, [
    {
      animeId,
      animeTitle,
      changes: [{
        field: 'tags',
        before: [...existingTags],
        after: [...existingTags, ...additions],
      }],
    },
  ]);
}

/** 深比较够用的等价判断：只为「值没变」这种常见情况，不做通用 diff */
function isSameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return false;
}

export interface ProposalStaleness {
  /** 数据已经变了、不能再按这份提议落库的条目 */
  stale: { animeId: string; animeTitle: string; reason: string }[];
}

/**
 * 检查提议是否过期：把当前值喂进来，与提议里记录的 before 比对。
 * 返回非空的 stale 时，调用方应当拒绝 apply 并提示重新生成 —— 而不是硬写。
 */
export function checkProposalStale(
  proposal: AIProposal,
  currentValueOf: (change: ProposedItemChange) => unknown,
): ProposalStaleness {
  const stale: ProposalStaleness['stale'] = [];
  for (const item of proposal.items) {
    const current = currentValueOf(item);
    const conflict = item.changes.find((c) => !isSameValue(c.before, current));
    if (conflict) {
      stale.push({
        animeId: item.animeId,
        animeTitle: item.animeTitle,
        reason: `「${conflict.field}」在提议生成后已被修改`,
      });
    }
  }
  return { stale };
}

/** 人读的改动摘要，用于确认面板和日志 */
export function describeProposal(proposal: AIProposal): string[] {
  const lines: string[] = [];
  for (const item of proposal.items) {
    for (const change of item.changes) {
      lines.push(`${item.animeTitle} · ${change.field}`);
    }
  }
  return lines;
}

/** 一条数组型改动里「新增」了什么（确认面板要逐项列出来给人看） */
export function additionsOf(change: ProposedFieldChange): string[] {
  const before = Array.isArray(change.before) ? change.before.map(String) : [];
  const after = Array.isArray(change.after) ? change.after.map(String) : [];
  const beforeSet = new Set(before);
  return after.filter((v) => !beforeSet.has(v));
}

/** 整份提议里所有新增值，拍平成一个清单 */
export function proposalAdditions(proposal: AIProposal | null | undefined): string[] {
  if (!proposal) return [];
  return proposal.items.flatMap((item) => item.changes.flatMap((c) => additionsOf(c)));
}
