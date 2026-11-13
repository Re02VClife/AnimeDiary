/**
 * core/review-timeline — 评价段落时间戳的纯逻辑（无 React、无 Excel、无 IO）
 *
 * 为什么需要它：一条番会被反复重刷，评价是分很多次写下的。正文存在 Excel 的「评价」列，
 * 时间戳必须另外存（不能写进正文，否则会污染用户自己能读的那段文字，也会被同步到 Bangumi）。
 * 于是正文和「每段是什么时候写的」成了两份数据，唯一的问题就是**它们会错位**：
 * 用户改一个字、拆一段、删一段，按索引对就全乱了。
 *
 * 这里只做三件事：
 *   1. 切段（空行分隔；没有空行就整篇一段）
 *   2. 用上一版正文做锚点对齐，只有真正新增的段落才打当前时间
 *   3. 给每段算一个底纹色相（按顺序从冷到暖，用来看出"越往后写越新"）
 *
 * 对齐的核心约定是「宁可显示未知，也不把时间指错段」：
 * 匹配不上就当新段处理，绝不硬按位置塞。
 */

/** 单段的时间信息 */
export interface ReviewSegmentMeta {
  /** 段落锚点：段首若干字（压缩空白后），用于正文变化后重新对上 */
  anchor: string;
  /**
   * 可以为空：老评价从没记录过时间，启用这个功能后第一次保存时，
   * 能对上旧正文的段落我们并不知道它是什么时候写的，宁可留空也不猜。
   * （除非调用方给了兜底时间，见 `estimated`。）
   */
  time?: string;
  /**
   * 这个时间是**估算**出来的，不是真的写下那会儿记的。
   *
   * 只出现在一种情况：老评价（从没记录过时间）按「观看日 12:00」补录。
   * 界面上会显示成「约 2025-05-04 12:00」，避免被当成真实记录。
   */
  estimated?: boolean;
  /** 手写注释，例如「二刷」「剧透预警」 */
  note?: string;
}

/** 评价时间线：正文快照 + 每段时间 */
export interface ReviewTimeline {
  /** 上次保存时的正文快照（对齐基准） */
  snapshot: string;
  segments: ReviewSegmentMeta[];
}

/** 评价相关的全部附加信息（序列化成一格 JSON 存 Excel） */
export interface ReviewMeta {
  /** 结构版本，将来改格式时用 */
  v: 1;
  /** 看过几遍，1 = 只看过一遍；缺省视为 1 */
  watchCount?: number;
  /** 二刷及以后的观看日期（首刷在 watchDate 里） */
  watchDates?: string[];
  timeline?: ReviewTimeline;
}

/** 锚点取前多少字。太短容易撞车，太长改几个字就失联 */
export const ANCHOR_LENGTH = 24;

/** 公共前缀至少这么长才算「同一段被改过」 */
export const MIN_PREFIX_MATCH = 12;

/** 段与段之间的底纹色相范围：旧 → 新，青蓝 → 品牌粉 */
const HUE_FROM = 200;
const HUE_TO = 330;

/** 压缩连续空白，锚点比对时不受缩进/多空格影响 */
function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 段落锚点：压缩空白后的前 ANCHOR_LENGTH 个字 */
export function reviewAnchor(text: string): string {
  return squash(text).slice(0, ANCHOR_LENGTH);
}

/**
 * 把评价正文切成段。
 *
 * 空行分段，段内的单个换行仍然属于同一段 —— 那通常只是折行，不是"另写了一段"。
 * 整篇没有空行时就是一段，此时时间戳退化成"这篇是某时写的"，仍然有意义。
 */
export function splitReviewParagraphs(text: string): string[] {
  return String(text ?? '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** 两段的最长公共前缀长度 */
function commonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/** 在当前正文里给某一段找上一版里对应的那一段；找不到返回 -1 */
function findPrevIndex(
  prevParas: string[],
  prevSegs: ReviewSegmentMeta[],
  used: Set<number>,
  para: string,
): number {
  const target = squash(para);

  // 1) 内容完全一致（最常见：别的段落改动了，这一段没动）
  for (let i = 0; i < prevParas.length; i++) {
    if (used.has(i) || !prevSegs[i]) continue;
    if (squash(prevParas[i]) === target) return i;
  }

  // 2) 前缀相似（这一段被润色了几个字）：取最长的那一个，别贪多
  let best = -1;
  let bestLen = MIN_PREFIX_MATCH - 1;
  for (let i = 0; i < prevParas.length; i++) {
    if (used.has(i) || !prevSegs[i]) continue;
    const len = commonPrefixLength(squash(prevParas[i]), target);
    if (len > bestLen) {
      bestLen = len;
      best = i;
    }
  }
  return best;
}

/**
 * 正文变化后重新算每段时间。
 *
 * @param prevReview   上一版正文（可能为空）
 * @param prevTimeline 上一版的时间线（可能没有：老数据从未记录过）
 * @param newReview    这次要保存的正文
 * @param now          新增段落要打的时间（YYYY-MM-DD HH:mm）
 * @param fallbackTime 老评价的兜底时间：观看日 12:00。给了之后，能对上旧正文的段落
 *                     会被标成 `estimated`，而不是留空（留空在界面上等于没有底纹，
 *                     看不出这个功能存在）
 */
export function alignReviewSegments(params: {
  prevReview: string;
  prevTimeline?: ReviewTimeline;
  newReview: string;
  now: string;
  fallbackTime?: string;
}): ReviewSegmentMeta[] {
  const { prevReview, prevTimeline, newReview, now, fallbackTime } = params;
  const newParas = splitReviewParagraphs(newReview);
  if (newParas.length === 0) return [];

  // 旧基准：有快照就用快照（segments 是对着它算的），否则退回上一版正文
  const prevParas = splitReviewParagraphs(prevTimeline?.snapshot ?? prevReview);
  /**
   * 老数据没有 segments，这里补一串"没有时间"的占位，
   * 让对齐走同一条路径：能对上旧正文的段保持无时间，真正新写的段才打时间。
   */
  const prevSegs: ReviewSegmentMeta[] = prevTimeline?.segments
    ?? prevParas.map((p) => ({ anchor: reviewAnchor(p) }));

  const used = new Set<number>();
  const segments: ReviewSegmentMeta[] = [];

  for (const para of newParas) {
    const idx = findPrevIndex(prevParas, prevSegs, used, para);
    if (idx >= 0) {
      used.add(idx);
      const seg = prevSegs[idx];
      const anchor = reviewAnchor(para);
      if (seg?.time) {
        segments.push({
          anchor,
          time: seg.time,
          ...(seg.estimated ? { estimated: true } : {}),
          ...(seg.note ? { note: seg.note } : {}),
        });
      } else if (fallbackTime) {
        // 老评价：没人记得那会儿是几点写的，用观看日中午补一个，并标记为估算
        segments.push({
          anchor,
          time: fallbackTime,
          estimated: true,
          ...(seg?.note ? { note: seg.note } : {}),
        });
      } else {
        segments.push({ anchor, ...(seg?.note ? { note: seg.note } : {}) });
      }
    } else {
      segments.push({ anchor: reviewAnchor(para), time: now });
    }
  }

  // 一段都拿不到时间 → 这篇评价既没改动、也没有历史时间，不写空壳进 Excel
  if (!segments.some((s) => s.time)) return [];
  return segments;
}

/** 当前时间的分钟精度文本 */
export function formatReviewTime(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

/** `now` 参数用：当前时刻 */
export function nowReviewTime(): string {
  return formatReviewTime(new Date());
}

/**
 * 老评价的兜底时间：观看日中午 12 点。
 *
 * 为什么是 12 点：没人记得某段评价是几点写的，但"看了之后当天写"大致成立，
 * 中午是这个估算里最不容易被误读成真实记录的时刻。会用 `estimated` 标出来。
 */
export function reviewFallbackTime(date?: string): string | undefined {
  const day = String(date ?? '').trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day} 12:00` : undefined;
}

/** 一段渲染所需的全部信息 */
export interface ReviewParagraphView {
  /** 段落在正文里的序号（从 0 开始） */
  index: number;
  text: string;
  /** 写下时间；老数据/外部改过正文时可能没有 */
  time?: string;
  /** 上面那个时间是估算的（老评价按观看日补录） */
  estimated?: boolean;
  note?: string;
  /** 底纹色相（0-360），按顺序从冷到暖 */
  hue: number;
}

/**
 * 底纹色相：段数越多跨度越大。
 * 单段时给品牌粉色相，避免"一篇评价只有一个颜色"时显得像随机色。
 */
export function reviewTintHue(index: number, total: number): number {
  if (total <= 1) return HUE_TO;
  const t = index / (total - 1);
  return Math.round(HUE_FROM + (HUE_TO - HUE_FROM) * t);
}

/**
 * 把正文 + 时间线拼成可渲染的段落列表。
 *
 * 逐段去上一版正文里找锚点，而不是按 index 硬对 —— 正文可能在 Excel 或表格视图里
 * 被手改过，一旦段数变了，按位置对就会把时间指到别的段落上。
 * 匹配不上的段不给时间，只显示正文。
 *
 * @param fallbackTime 老评价（从没记录过时间）的兜底时间，按观看日 12:00 补。
 *                     只在**完全没有时间线**时生效，避免把新写的段落也标成估算。
 */
export function buildReviewParagraphs(
  review: string,
  timeline?: ReviewTimeline,
  fallbackTime?: string,
): ReviewParagraphView[] {
  const paras = splitReviewParagraphs(review);
  const total = paras.length;
  const hasTimeline = !!timeline && timeline.segments.length > 0;
  const prevParas = hasTimeline ? splitReviewParagraphs(timeline!.snapshot) : [];
  const prevSegs = timeline?.segments ?? [];
  const used = new Set<number>();

  return paras.map((text, index) => {
    const idx = findPrevIndex(prevParas, prevSegs, used, text);
    let seg: ReviewSegmentMeta | undefined;
    if (idx >= 0) {
      used.add(idx);
      seg = prevSegs[idx];
    }

    let time = seg?.time;
    let estimated = seg?.estimated;
    if (!hasTimeline && fallbackTime) {
      // 从没记录过时间的老评价：整篇按观看日中午补一个估算时间
      time = fallbackTime;
      estimated = true;
    }

    return {
      index,
      text,
      ...(time ? { time } : {}),
      ...(estimated ? { estimated: true } : {}),
      ...(seg?.note ? { note: seg.note } : {}),
      hue: reviewTintHue(index, total),
    };
  });
}

/** 读懂 Excel 里那一格 JSON；坏数据一律当没有，不让它拖垮详情面板 */
export function parseReviewMeta(raw: string | undefined | null): ReviewMeta | undefined {
  const text = String(raw ?? '').trim();
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as ReviewMeta;
    if (!parsed || typeof parsed !== 'object') return undefined;
    return { ...parsed, v: 1 };
  } catch {
    return undefined;
  }
}

/** 写回 Excel：空对象就返回空串，避免往格里塞 `{}` */
export function serializeReviewMeta(meta: ReviewMeta | undefined): string {
  if (!meta) return '';
  const hasTimeline = !!meta.timeline && meta.timeline.segments.length > 0;
  const hasWatch = (meta.watchCount ?? 1) > 1 || (meta.watchDates?.length ?? 0) > 0;
  if (!hasTimeline && !hasWatch) return '';
  return JSON.stringify(meta);
}

/** 多刷次数：缺省/非法值一律当 1 */
export function normalizeWatchCount(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(99, Math.floor(n));
}
