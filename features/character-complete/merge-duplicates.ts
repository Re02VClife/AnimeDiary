/**
 * 合并重复角色卡 —— 纯计算层
 *
 * 背景：同一角色会在多部作品（同系列续作/客串）里出现，早期从不同作品解析时
 * 各自建卡，于是产生重复（实测 101 张卡里有 10 组同名，其中山田杏奈有三张）。
 * 现在新卡不会再重复，但**已经产生的重复需要合并**。
 *
 * 合并策略（刻意保守）：
 *   - 数据取「并集 + 更完整的那份」，不是简单取第一张
 *   - 你手写的文本（评价/备注）只有在保留卡没有时才搬过来
 *   - 同一维度有**不同**评分时标记为冲突，默认取保留卡的值，并在界面上标出来
 *   - 「详细人设」取更长的（信息更多），可切换成「取保留卡的」
 *   - 不做物理删行：被合并掉的卡片走应用既有的软删除（localStorage 黑名单），
 *     这样行号不错位，海报覆盖和其它行都不受影响，还能撤销
 */
import type { AnimeEntry, DimensionScore } from '../../src/types';
import { CHARACTER_TEMPLATE_ID } from '../../src/types';

export interface MergePlan {
  /** 规范化标题（分组用） */
  key: string;
  /** 显示用的角色名 */
  title: string;
  cards: AnimeEntry[];
  /** 用户选择保留的那张的 id */
  keptId: string;
  /** 详细人设的取舍：longer = 取更长的，kept = 只认保留卡的 */
  profileMode: 'longer' | 'kept';
  /** 用户是否勾选要合并这一组 */
  selected: boolean;
}

export interface MergedCardData {
  scores: DimensionScore[];
  customFields: Record<string, string>;
  posterUrl: string;
  link: string;
  review: string;
  notes: string;
  watchDate: string;
  /** 逐项说明「这个值来自哪张卡 / 来自并集」，用于界面预览 */
  origin: Record<string, string>;
  /** 同维度评分不同的项（需要用户留意） */
  scoreConflicts: string[];
}

/** 规范化角色名：去空白/间隔号/括号，用于分组（避免「星野爱」和「星野爱 」分成两组） */
export function normalizeCardTitle(input: unknown): string {
  return String(input ?? '')
    .replace(/[\s\u3000·・\u2010-\u2015_\-./\\、,，:：;；!！?？'"“”‘’`()（）[\]【】{}<>《》「」『』~～]/g, '')
    .toLowerCase();
}

/** 一张卡的「信息量」，用来默认选出保留哪张 */
export function cardRichness(card: AnimeEntry): number {
  const cf = card.customFields || {};
  const scoreCount = (card.scores || []).filter((s) => Number(s.score) > 0).length;
  return scoreCount * 10
    + (String(card.review || '').trim() ? 20 : 0)
    + (String(card.notes || '').trim() ? 8 : 0)
    + (card.posterUrl ? 4 : 0)
    + (card.link ? 2 : 0)
    + (String(cf.char_profile || '').length > 0 ? 3 : 0)
    + (card.watchDate ? 3 : 0);
}

/** 按规范化标题把角色卡分组，只返回有重复的组 */
export function buildDuplicateGroups(animeList: AnimeEntry[], isCard: (a: AnimeEntry) => boolean): MergePlan[] {
  const byKey = new Map<string, AnimeEntry[]>();
  for (const a of animeList) {
    if (!isCard(a)) continue;
    const key = normalizeCardTitle(a.title);
    if (!key) continue;
    const list = byKey.get(key) || [];
    list.push(a);
    byKey.set(key, list);
  }
  const groups: MergePlan[] = [];
  for (const [key, cards] of byKey) {
    if (cards.length < 2) continue;
    // 默认保留信息量最大的那张（并列时取靠前的，保证结果稳定）
    let kept = cards[0];
    for (const c of cards) if (cardRichness(c) > cardRichness(kept)) kept = c;
    groups.push({
      key,
      title: kept.title.trim(),
      cards: [...cards].sort((a, b) => (a.excelRowIndex ?? 0) - (b.excelRowIndex ?? 0)),
      keptId: kept.id,
      profileMode: 'longer',
      selected: true,
    });
  }
  // 组内卡片多的排前面，便于先处理最乱的
  return groups.sort((a, b) => b.cards.length - a.cards.length || a.title.localeCompare(b.title, 'zh-Hans-CN'));
}

const text = (v: unknown) => (v === undefined || v === null ? '' : String(v));

/** 取第一个非空值，并记录它来自哪张卡 */
function firstNonEmpty(
  cards: AnimeEntry[],
  keptId: string,
  pick: (c: AnimeEntry) => string,
): { value: string; from: AnimeEntry | null } {
  // 保留卡优先
  const ordered = [...cards].sort((a, b) => (a.id === keptId ? -1 : b.id === keptId ? 1 : 0));
  for (const c of ordered) {
    const v = pick(c).trim();
    if (v) return { value: v, from: c };
  }
  return { value: '', from: null };
}

const rowLabel = (c: AnimeEntry) => (c.excelRowIndex !== undefined ? `行${c.excelRowIndex + 1}` : c.title);

/**
 * 计算合并后的卡片数据。纯函数，不改任何东西 —— 界面拿它做预览，
 * 用户确认后才由调用方写回。
 */
export function computeMergedCard(plan: MergePlan): MergedCardData {
  const { cards, keptId, profileMode } = plan;
  const kept = cards.find((c) => c.id === keptId) || cards[0];
  const origin: Record<string, string> = {};

  // ── 评分：逐维度取「第一个有值的」；同维度不同值记为冲突 ──
  const byDim = new Map<string, { score: number; from: AnimeEntry }[]>();
  for (const c of cards) {
    for (const s of c.scores || []) {
      if (!s || Number(s.score) <= 0) continue;
      const list = byDim.get(s.dimensionKey) || [];
      list.push({ score: s.score, from: c });
      byDim.set(s.dimensionKey, list);
    }
  }
  const scores: DimensionScore[] = [];
  const scoreConflicts: string[] = [];
  const scoreFrom: string[] = [];
  for (const [dimensionKey, list] of byDim) {
    const distinct = new Set(list.map((x) => x.score));
    if (distinct.size > 1) {
      scoreConflicts.push(dimensionKey);
      // 冲突时以保留卡的值为准（没有则取第一张有值的）
      const fromKept = list.find((x) => x.from.id === keptId);
      const chosen = fromKept || list[0];
      scores.push({ dimensionKey, score: chosen.score });
      scoreFrom.push(`${dimensionKey}=${chosen.score}(保留卡，另有 ${[...distinct].filter((v) => v !== chosen.score).join('/')})`);
    } else {
      scores.push({ dimensionKey, score: list[0].score });
      scoreFrom.push(`${dimensionKey}=${list[0].score}`);
    }
  }
  if (scores.length > 0) origin['评分'] = `${scores.length} 项：${scoreFrom.join('、')}`;

  // ── 自定义字段：所属作品取并集，其余取第一个非空（保留卡优先） ──
  const workSet = new Set<string>();
  for (const c of cards) {
    for (const w of text((c.customFields || {}).char_source).split('/')) {
      const t = w.trim();
      if (t) workSet.add(t);
    }
  }
  const sources = [...workSet];
  const customFields: Record<string, string> = {
    char_source: sources.slice(0, 6).join('/'),
    char_cv: firstNonEmpty(cards, keptId, (c) => text((c.customFields || {}).char_cv)).value,
    char_birthday: firstNonEmpty(cards, keptId, (c) => text((c.customFields || {}).char_birthday)).value,
    char_profile: '',
  };
  origin['所属作品'] = sources.length > 1 ? `${sources.length} 部取并集：${customFields.char_source}` : customFields.char_source || '(空)';

  // ── 详细人设：默认取更长的（信息更多），可切换成只认保留卡的 ──
  const profileOf = (c: AnimeEntry) => text((c.customFields || {}).char_profile);
  if (profileMode === 'kept') {
    customFields.char_profile = profileOf(kept);
    origin['详细人设'] = `${customFields.char_profile.length} 字（取保留卡 ${rowLabel(kept)}）`;
  } else {
    let best = kept;
    for (const c of cards) if (profileOf(c).length > profileOf(best).length) best = c;
    customFields.char_profile = profileOf(best);
    origin['详细人设'] = customFields.char_profile
      ? `${customFields.char_profile.length} 字（取最长的，来自 ${rowLabel(best)}）`
      : '(都为空)';
  }

  // ── 海报：保留卡有就用它的，否则搬一张过来 ──
  const poster = firstNonEmpty(cards, keptId, (c) => text(c.posterUrl));
  origin['海报'] = poster.from ? (poster.from.id === keptId ? '沿用保留卡' : `搬自 ${rowLabel(poster.from)}`) : '(都为空)';

  // ── 链接 / 评价 / 备注 / 观看时间：第一个非空，保留卡优先 ──
  const link = firstNonEmpty(cards, keptId, (c) => text(c.link));
  const review = firstNonEmpty(cards, keptId, (c) => text(c.review));
  const notes = firstNonEmpty(cards, keptId, (c) => text(c.notes));
  const watchDate = firstNonEmpty(cards, keptId, (c) => text(c.watchDate));
  if (link.value) origin['链接'] = link.from?.id === keptId ? '沿用保留卡' : `搬自 ${rowLabel(link.from!)}`;
  if (review.value) origin['评价'] = review.from?.id === keptId ? '保留卡已有' : `搬自 ${rowLabel(review.from!)}`;
  if (notes.value) origin['备注'] = notes.from?.id === keptId ? '保留卡已有' : `搬自 ${rowLabel(notes.from!)}`;
  if (watchDate.value) origin['观看时间'] = watchDate.from?.id === keptId ? '保留卡已有' : `搬自 ${rowLabel(watchDate.from!)}`;

  return {
    scores,
    customFields,
    posterUrl: poster.value,
    link: link.value,
    review: review.value,
    notes: notes.value,
    watchDate: watchDate.value,
    origin,
    scoreConflicts,
  };
}

/** 一组里将被移除（软删除）的卡片 */
export function removedCards(plan: MergePlan): AnimeEntry[] {
  return plan.cards.filter((c) => c.id !== plan.keptId);
}

export { CHARACTER_TEMPLATE_ID };
