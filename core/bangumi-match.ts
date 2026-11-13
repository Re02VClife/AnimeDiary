/**
 * core/bangumi-match — 「本地条目 ↔ Bangumi 条目」的标题匹配纯逻辑（无网络）
 *
 * 为什么要单独写：本地表里 189 条**一条 BGM ID 都没有**，上传前必须先把
 * 每一条对到一个 subject_id 上。而番剧标题天然是多对多的 ——
 * 中文译名、日文原名、检索别名各自能匹配上一半，而搜索结果里还混着
 * 同名书籍、OVA、剧场版、总集篇。对错了就是把自己的评分传到别人的条目上，
 * 这种错用户很难发现，所以这里只做「打分 + 分档」，最终确认必须交给人。
 */

/** 本地条目里可用来匹配的字段 */
export interface MatchSource {
  title: string;
  titleJa?: string;
  searchAlias?: string;
  /** 上映年月，形如 2021-04 / 2021 */
  releaseDate?: string;
}

/** Bangumi 搜索结果的精简形态（够打分用即可） */
export interface MatchCandidate {
  id: number;
  /** 原名（多数是日文） */
  name: string;
  /** 中文名 */
  nameCn?: string;
  /** infobox 里的别名 */
  aliases?: string[];
  /** 首播日期 YYYY-MM-DD */
  airDate?: string;
}

export type MatchConfidence = 'high' | 'medium' | 'none';

export interface ScoredCandidate {
  candidate: MatchCandidate;
  score: number;
  confidence: MatchConfidence;
}

/**
 * 归一化：全角转半角、小写、去掉空白与装饰性标点。
 * 不删括号内容 —— 括号里常常正是「第二季 / 剧场版」这种关键区分信息。
 */
export function normalizeTitle(input: string): string {
  if (!input) return '';
  return input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000]/g, '')
    .replace(/[·・:：;；\-–—_~～!！?？,，.。'"“”‘’「」『』【】\[\]()（）]/g, '');
}

function bigrams(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length - 1; i++) out.push(text.slice(i, i + 2));
  return out;
}

/** Dice 系数（二元组），对中日文标题的相关程度比较稳 */
function dice(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bag = new Map<string, number>();
  for (const g of bigrams(a)) bag.set(g, (bag.get(g) ?? 0) + 1);
  let hit = 0;
  for (const g of bigrams(b)) {
    const n = bag.get(g) ?? 0;
    if (n > 0) {
      hit++;
      bag.set(g, n - 1);
    }
  }
  return (2 * hit) / (a.length - 1 + b.length - 1);
}

/**
 * 单个标题对的相似度。
 * 包含关系给高分（「86 不存在的战区」vs「86－エイティシックス－」靠别名兜，
 * 但「辉夜大小姐想让我告白」vs「… -Ultra Romantic-」就是典型的前者包含后者）。
 */
export function titleSimilarity(a: string, b: string): number {
  const x = normalizeTitle(a);
  const y = normalizeTitle(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) {
    const longer = x.length >= y.length ? x : y;
    const shorter = x.length >= y.length ? y : x;
    // 按「多出来的内容」占比打分：多出的越少，越可能只是同一作品的另一种写法。
    // 用短标题占比会失真 ——「无职转生」被「无职转生 同人动画」包含时
    // 短标题只占一半，却和「辉夜大小姐」被某一季副标题包含一样危险。
    const extra = longer.replace(shorter, '');
    let score = 0.95 - 0.4 * (extra.length / longer.length);
    // 多出来的部分若是「漫画 / 剧场版 / 第二季」这类限定词，在 Bangumi 上
    // 基本就是另一个条目（同名书籍、续作分开收录），再扣一档。
    // 纯数字同理：「我心里危险的东西2」的 2 是续作标记，不能匹配到第一季。
    if (EXTRA_QUALIFIER.test(extra) || /^\d+$/.test(extra)) score -= 0.18;
    return Math.max(0, score);
  }
  return dice(x, y);
}

/** 出现在标题里就意味着「这不是同一个条目」的限定词 */
const EXTRA_QUALIFIER = /(漫画|小说|原作|剧场版|总集篇|ova|oad|真人版|舞台剧|外传|最终季|第[一二三四五六七八九十0-9]+[季期]|\d+期|season|part\s*\d)/i;

/** 本地侧所有可用名字 */
function sourceNames(src: MatchSource): string[] {
  return [src.title, src.titleJa, src.searchAlias].filter((s): s is string => !!s && !!s.trim());
}

/** 候选侧所有可用名字 */
function candidateNames(c: MatchCandidate): string[] {
  return [c.name, c.nameCn, ...(c.aliases ?? [])].filter((s): s is string => !!s && !!s.trim());
}

/** 年份是否一致（只比到年；月经常对不上，不参与） */
function sameYear(a?: string, b?: string): boolean {
  const ya = (a ?? '').match(/\d{4}/)?.[0];
  const yb = (b ?? '').match(/\d{4}/)?.[0];
  return !!ya && !!yb && ya === yb;
}

/**
 * 给候选打分。0–1，其中 0.1 留给年份一致性。
 * 取「所有名字对」里的最高分，而不是平均 —— 别名命中一次就够。
 */
export function matchScore(src: MatchSource, candidate: MatchCandidate): number {
  const left = sourceNames(src);
  const right = candidateNames(candidate);
  let best = 0;
  for (const a of left) {
    for (const b of right) {
      const s = titleSimilarity(a, b);
      if (s > best) best = s;
    }
  }
  if (best >= 0.6 && sameYear(src.releaseDate, candidate.airDate)) {
    best = Math.min(1, best + 0.08);
  }
  return best;
}

/**
 * 分档阈值。
 * 0.88 以上才敢标「高置信」，因为包含关系最高能给到 0.98，
 * 而「无职转生」被「无职转生 同人动画」包含时也会接近 0.9。
 * 高置信只是「默认勾上」，用户仍能在列表里改。
 */
export const MATCH_THRESHOLDS = { high: 0.88, medium: 0.6 } as const;

export function confidenceOf(score: number): MatchConfidence {
  if (score >= MATCH_THRESHOLDS.high) return 'high';
  if (score >= MATCH_THRESHOLDS.medium) return 'medium';
  return 'none';
}

/** 给一条本地条目排出候选（已按分数降序，最多 keep 个） */
export function rankCandidates(src: MatchSource, candidates: MatchCandidate[], keep = 5): ScoredCandidate[] {
  return candidates
    .map((candidate) => {
      const score = matchScore(src, candidate);
      return { candidate, score, confidence: confidenceOf(score) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, keep);
}
