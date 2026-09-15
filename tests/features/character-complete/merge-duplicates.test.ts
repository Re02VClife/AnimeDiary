/**
 * features/character-complete/merge-duplicates 单元测试
 *
 * 合并会动用户的真实数据（评分、评价），所以这里重点覆盖：
 *   - 评分取并集，冲突时以保留卡为准并**标记出来**（而不是悄悄选一个）
 *   - 你自己的评价/备注只在保留卡没有时才搬过来
 *   - 所属作品取并集（一对多绑定）
 *   - 被移除的卡片清单正确（软删除用）
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeCardTitle,
  cardRichness,
  buildDuplicateGroups,
  computeMergedCard,
  removedCards,
} from '../../../features/character-complete/merge-duplicates';
import type { MergePlan } from '../../../features/character-complete/merge-duplicates';
import type { AnimeEntry, DimensionScore } from '../../../src/types';
import { CHARACTER_TEMPLATE_ID } from '../../../src/types';

function card(partial: Partial<AnimeEntry> & { excelRowIndex?: number }): AnimeEntry {
  return {
    id: partial.id || 'excel-1',
    title: '星野爱',
    posterUrl: '',
    category: 'watching',
    tags: [],
    templateId: CHARACTER_TEMPLATE_ID,
    scores: [],
    customFields: {},
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    ...partial,
  };
}

const score = (dimensionKey: string, s: number): DimensionScore => ({ dimensionKey, score: s });

describe('normalizeCardTitle', () => {
  it('空白/间隔号/括号差异归为同一个键', () => {
    expect(normalizeCardTitle('星野爱 ')).toBe(normalizeCardTitle('星野爱'));
    expect(normalizeCardTitle('辛・诺赞')).toBe(normalizeCardTitle('辛诺赞'));
    expect(normalizeCardTitle('【我推的孩子】')).toBe(normalizeCardTitle('我推的孩子'));
  });

  it('不同角色不会归一成同一个', () => {
    expect(normalizeCardTitle('星野爱')).not.toBe(normalizeCardTitle('星野露比'));
  });
});

describe('cardRichness', () => {
  it('有评分的卡明显更「富」', () => {
    const withScores = card({ scores: [score('a', 8), score('b', 7)] });
    const plain = card({});
    expect(cardRichness(withScores)).toBeGreaterThan(cardRichness(plain));
  });

  it('评价比人设更值钱（手写内容优先保留）', () => {
    const withReview = card({ review: '写了很多' });
    const withProfile = card({ customFields: { char_profile: '抓来的人设' } });
    expect(cardRichness(withReview)).toBeGreaterThan(cardRichness(withProfile));
  });

  it('0 分的维度不计入', () => {
    expect(cardRichness(card({ scores: [score('a', 0)] }))).toBe(cardRichness(card({})));
  });
});

describe('buildDuplicateGroups', () => {
  it('只返回有重复的组，默认保留信息量最大的那张', () => {
    const rich = card({ id: 'excel-2', excelRowIndex: 1, scores: [score('a', 8)] });
    const poor = card({ id: 'excel-5', excelRowIndex: 4 });
    const unique = card({ id: 'excel-9', title: '独一无二' });
    const groups = buildDuplicateGroups([poor, rich, unique], (a) => a.templateId === CHARACTER_TEMPLATE_ID);
    expect(groups).toHaveLength(1);
    expect(groups[0].keptId).toBe('excel-2');
    expect(groups[0].cards.map((c) => c.id)).toEqual(['excel-2', 'excel-5']); // 按行号排
  });

  it('忽略非角色卡', () => {
    const anime = card({ id: 'excel-1', templateId: undefined });
    const anime2 = card({ id: 'excel-2', templateId: undefined });
    expect(buildDuplicateGroups([anime, anime2], (a) => a.templateId === CHARACTER_TEMPLATE_ID)).toHaveLength(0);
  });

  it('卡数多的组排在前面', () => {
    const a1 = card({ id: 'a1', title: '甲' });
    const a2 = card({ id: 'a2', title: '甲' });
    const a3 = card({ id: 'a3', title: '甲' });
    const b1 = card({ id: 'b1', title: '乙' });
    const b2 = card({ id: 'b2', title: '乙' });
    const groups = buildDuplicateGroups([a1, a2, a3, b1, b2], () => true);
    expect(groups[0].title).toBe('甲');
  });

  it('默认勾选所有组，人设默认取最长', () => {
    const groups = buildDuplicateGroups([card({ id: 'x' }), card({ id: 'y' })], () => true);
    expect(groups[0].selected).toBe(true);
    expect(groups[0].profileMode).toBe('longer');
  });
});

describe('computeMergedCard', () => {
  const plan = (cards: AnimeEntry[], keptId: string, profileMode: 'longer' | 'kept' = 'longer'): MergePlan => ({
    key: 'k', title: '星野爱', cards, keptId, profileMode, selected: true,
  });

  it('评分取并集：不同维度各自保留', () => {
    const a = card({ id: 'a', scores: [score('char_appearance', 8)] });
    const b = card({ id: 'b', scores: [score('char_voice', 9)] });
    const merged = computeMergedCard(plan([a, b], 'a'));
    expect(merged.scores.map((s) => s.dimensionKey).sort()).toEqual(['char_appearance', 'char_voice']);
    expect(merged.scoreConflicts).toEqual([]);
  });

  it('回归：同维度评分不同 → 标记冲突并以保留卡为准', () => {
    const kept = card({ id: 'kept', scores: [score('char_appearance', 8)] });
    const other = card({ id: 'other', scores: [score('char_appearance', 5)] });
    const merged = computeMergedCard(plan([kept, other], 'kept'));
    expect(merged.scoreConflicts).toEqual(['char_appearance']);
    expect(merged.scores.find((s) => s.dimensionKey === 'char_appearance')?.score).toBe(8);
    // 预览里要说明另一张是多少，用户才知道自己被舍弃了什么
    expect(merged.origin['评分']).toContain('另有 5');
  });

  it('同维度同分不算冲突', () => {
    const a = card({ id: 'a', scores: [score('x', 7)] });
    const b = card({ id: 'b', scores: [score('x', 7)] });
    expect(computeMergedCard(plan([a, b], 'a')).scoreConflicts).toEqual([]);
  });

  it('所属作品取并集并去重', () => {
    const a = card({ id: 'a', customFields: { char_source: '我推的孩子/我推的孩子2' } });
    const b = card({ id: 'b', customFields: { char_source: '我推的孩子/【我推的孩子】' } });
    const merged = computeMergedCard(plan([a, b], 'a'));
    expect(merged.customFields.char_source).toBe('我推的孩子/我推的孩子2/【我推的孩子】');
  });

  it('声优/生日取第一个非空，保留卡优先', () => {
    const kept = card({ id: 'kept', customFields: { char_cv: '保留卡的CV' } });
    const other = card({ id: 'other', customFields: { char_cv: '别张的CV', char_birthday: '生日01-01' } });
    const merged = computeMergedCard(plan([kept, other], 'kept'));
    expect(merged.customFields.char_cv).toBe('保留卡的CV');
    expect(merged.customFields.char_birthday).toBe('生日01-01');
  });

  it('详细人设默认取最长的；切到「只认保留卡」时用保留卡的', () => {
    const kept = card({ id: 'kept', customFields: { char_profile: '短' } });
    const other = card({ id: 'other', customFields: { char_profile: '这条人设长得多' } });
    expect(computeMergedCard(plan([kept, other], 'kept')).customFields.char_profile).toBe('这条人设长得多');
    expect(computeMergedCard(plan([kept, other], 'kept', 'kept')).customFields.char_profile).toBe('短');
  });

  it('回归：评价/备注/观看时间只在保留卡没有时才搬过来', () => {
    const kept = card({ id: 'kept', review: '我的评价' });
    const other = card({ id: 'other', review: '别张的评价', notes: '别张的备注', watchDate: '2024-05-01' });
    const merged = computeMergedCard(plan([kept, other], 'kept'));
    expect(merged.review).toBe('我的评价');       // 保留卡已有 → 不覆盖
    expect(merged.notes).toBe('别张的备注');       // 保留卡没有 → 搬过来
    expect(merged.watchDate).toBe('2024-05-01');
    expect(merged.origin['评价']).toBe('保留卡已有');
    expect(merged.origin['备注']).toContain('搬自');
  });

  it('海报：保留卡有就沿用，没有才搬', () => {
    const keptHas = computeMergedCard(plan([
      card({ id: 'kept', posterUrl: '/api/images/file?anime=A&file=cover.jpg' }),
      card({ id: 'other', posterUrl: '/api/images/file?anime=B&file=cover.jpg' }),
    ], 'kept'));
    expect(keptHas.posterUrl).toContain('anime=A');
    expect(keptHas.origin['海报']).toBe('沿用保留卡');

    const keptEmpty = computeMergedCard(plan([
      card({ id: 'kept' }),
      card({ id: 'other', posterUrl: '/api/images/file?anime=B&file=cover.jpg' }),
    ], 'kept'));
    expect(keptEmpty.posterUrl).toContain('anime=B');
    expect(keptEmpty.origin['海报']).toContain('搬自');
  });

  it('所属作品上限 6 个', () => {
    const many = Array.from({ length: 8 }, (_, i) => `作品${i}`).join('/');
    const merged = computeMergedCard(plan([card({ id: 'a', customFields: { char_source: many } }), card({ id: 'b' })], 'a'));
    expect(merged.customFields.char_source.split('/').length).toBeLessThanOrEqual(6);
  });

  it('三张卡也能正确合并（山田杏奈那种情况）', () => {
    const a = card({ id: 'a', scores: [score('x', 7)] });
    const b = card({ id: 'b' });
    const c = card({ id: 'c', customFields: { char_source: '我心里危险的东西' } });
    const merged = computeMergedCard(plan([a, b, c], 'a'));
    expect(merged.scores).toHaveLength(1);
    expect(merged.customFields.char_source).toBe('我心里危险的东西');
    expect(removedCards(plan([a, b, c], 'a')).map((x) => x.id)).toEqual(['b', 'c']);
  });
});

describe('removedCards', () => {
  it('排除保留的那张', () => {
    const a = card({ id: 'a' });
    const b = card({ id: 'b' });
    expect(removedCards({ key: 'k', title: 't', cards: [a, b], keptId: 'b', profileMode: 'longer', selected: true }))
      .toEqual([a]);
  });
});
