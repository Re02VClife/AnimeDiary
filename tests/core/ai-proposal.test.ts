/**
 * core/ai-proposal 单测 —— 提议是「AI 改动数据」的唯一入口，必须可预测
 *
 * 重点：
 *   1. 没有实际变化时不能产出空提议（否则用户会被要求确认一件什么都没做的事）
 *   2. 已有标签不能重复加
 *   3. 提议过期必须能被发现（否则会用旧提议覆盖用户的新改动）
 */
import { describe, it, expect } from 'vitest';
import {
  createProposal,
  createTagProposal,
  checkProposalStale,
  describeProposal,
  additionsOf,
  proposalAdditions,
} from '../../core/ai-proposal';

describe('createProposal', () => {
  it('过滤掉「改前改后相同」的字段，全空时返回 null', () => {
    expect(createProposal('tags', '空提议', [
      { animeId: 'a', animeTitle: 'A', changes: [{ field: 'tags', before: ['x'], after: ['x'] }] },
    ])).toBeNull();

    expect(createProposal('tags', '空提议', [])).toBeNull();
  });

  it('有实际变化时带上 id / createdAt', () => {
    const p = createProposal('tags', '加标签', [
      { animeId: 'a', animeTitle: 'A', changes: [{ field: 'tags', before: [], after: ['新'] }] },
    ]);
    expect(p).not.toBeNull();
    expect(p!.id).toMatch(/^proposal-/);
    expect(Number.isNaN(new Date(p!.createdAt).getTime())).toBe(false);
    // 只保留真正有变化的条目
    expect(p!.items).toHaveLength(1);
  });

  it('两次创建的 id 不同（撤销时要靠它找回）', () => {
    const mk = () => createProposal('tags', 't', [
      { animeId: 'a', animeTitle: 'A', changes: [{ field: 'tags', before: [], after: ['x'] }] },
    ])!;
    expect(mk().id).not.toBe(mk().id);
  });
});

describe('createTagProposal', () => {
  it('只提议新增的标签，已有的不重复加', () => {
    const p = createTagProposal('a', '86', ['刀', '战争'], ['刀', '反乌托邦', '群像剧', '反乌托邦']);
    expect(p).not.toBeNull();
    expect(additionsOf(p!.items[0].changes[0])).toEqual(['反乌托邦', '群像剧']);
  });

  it('建议的标签全都已存在时返回 null', () => {
    expect(createTagProposal('a', '86', ['刀'], ['刀'])).toBeNull();
  });

  it('忽略空白标签', () => {
    expect(createTagProposal('a', '86', [], ['  ', ''])).toBeNull();
  });
});

describe('checkProposalStale', () => {
  const proposal = createTagProposal('a', '86', ['刀'], ['反乌托邦'])!;

  it('当前值仍等于提议里的 before → 不过期', () => {
    const { stale } = checkProposalStale(proposal, () => ['刀']);
    expect(stale).toHaveLength(0);
  });

  it('当前值已被改过 → 判定过期并说明原因', () => {
    const { stale } = checkProposalStale(proposal, () => ['刀', '用户新加']);
    expect(stale).toHaveLength(1);
    expect(stale[0].animeId).toBe('a');
    expect(stale[0].reason).toContain('tags');
  });
});

describe('展示辅助', () => {
  it('describeProposal 每个改动一行', () => {
    const p = createProposal('mixed', 'x', [
      { animeId: 'a', animeTitle: '86', changes: [{ field: 'tags', before: [], after: ['刀'] }] },
      { animeId: 'b', animeTitle: '赛博朋克', changes: [{ field: 'scores.电波', before: 8, after: 9 }] },
    ])!;
    expect(describeProposal(p)).toEqual(['86 · tags', '赛博朋克 · scores.电波']);
  });

  it('proposalAdditions 拍平所有新增值；空提议返回空数组', () => {
    const p = createTagProposal('a', '86', ['刀'], ['反乌托邦', '群像剧'])!;
    expect(proposalAdditions(p)).toEqual(['反乌托邦', '群像剧']);
    expect(proposalAdditions(null)).toEqual([]);
  });

  it('additionsOf 对非数组字段返回空数组（不抛错）', () => {
    expect(additionsOf({ field: 'scores.电波', before: 8, after: 9 })).toEqual([]);
  });
});
