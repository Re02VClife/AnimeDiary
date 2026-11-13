/**
 * core/review-timeline 单元测试
 *
 * 这块唯一会「悄悄出错」的地方是段落对齐：对齐错了不会报错，
 * 只会在面板上给某一段显示一个不属于它的时间 —— 比没有时间更糟。
 * 所以重点覆盖拆段、对齐、失配降级。
 */
import { describe, it, expect } from 'vitest';
import {
  splitReviewParagraphs,
  reviewAnchor,
  alignReviewSegments,
  formatReviewTime,
  reviewTintHue,
  buildReviewParagraphs,
  parseReviewMeta,
  serializeReviewMeta,
  normalizeWatchCount,
  reviewFallbackTime,
  ANCHOR_LENGTH,
  type ReviewTimeline,
} from '../../core/review-timeline';

describe('splitReviewParagraphs', () => {
  it('空行分段，段内换行保留在同一段', () => {
    const text = '第一段第一行\n第一段第二行\n\n第二段';
    expect(splitReviewParagraphs(text)).toEqual(['第一段第一行\n第一段第二行', '第二段']);
  });

  it('没有空行时整篇算一段', () => {
    expect(splitReviewParagraphs('op 好看\ned 别跳')).toEqual(['op 好看\ned 别跳']);
  });

  it('忽略纯空白段', () => {
    expect(splitReviewParagraphs('甲\n\n   \n\n乙')).toEqual(['甲', '乙']);
  });

  it('空文本得到空数组', () => {
    expect(splitReviewParagraphs('')).toEqual([]);
    expect(splitReviewParagraphs('   \n  ')).toEqual([]);
  });
});

describe('reviewAnchor', () => {
  it('压缩空白并截断到固定长度', () => {
    const long = '  一段　很长  的评价' + '字'.repeat(50);
    const anchor = reviewAnchor(long);
    expect(anchor.length).toBe(ANCHOR_LENGTH);
    expect(anchor).not.toMatch(/\s{2,}/);
    // 全角空格与连续空格都压成一个，不是删掉（"一段 很长 的评价" 共 9 字符）
    expect(anchor).toBe('一段 很长 的评价' + '字'.repeat(ANCHOR_LENGTH - 9));
  });
});

describe('alignReviewSegments', () => {
  const t1 = '2025-05-04 21:30';
  const t2 = '2026-01-11 09:15';

  it('首次从空正文写入：全部段打当前时间', () => {
    const segs = alignReviewSegments({ prevReview: '', newReview: '甲\n\n乙', now: t1 });
    expect(segs.map((s) => s.time)).toEqual([t1, t1]);
    expect(segs.map((s) => s.anchor)).toEqual(['甲', '乙']);
  });

  it('老数据首次记录（此前已有正文）：不猜时间，整篇留空', () => {
    const segs = alignReviewSegments({ prevReview: '老评价正文', newReview: '老评价正文', now: t1 });
    expect(segs).toEqual([]);
  });

  it('老数据上新增一段：只有新段打时间，旧段留空', () => {
    const segs = alignReviewSegments({ prevReview: '老评价正文', newReview: '老评价正文\n\n二刷补的一段', now: t1 });
    expect(segs).toHaveLength(2);
    expect(segs[0].time).toBeUndefined();
    expect(segs[1].time).toBe(t1);
  });

  it('给了兜底时间：老评价按观看日中午补录，并标记 estimated', () => {
    const segs = alignReviewSegments({
      prevReview: '老评价正文',
      newReview: '老评价正文\n\n二刷补的一段',
      now: t1,
      fallbackTime: '2025-05-04 12:00',
    });
    expect(segs[0]).toMatchObject({ time: '2025-05-04 12:00', estimated: true });
    expect(segs[1]).toMatchObject({ time: t1 });
    expect(segs[1].estimated).toBeUndefined();
  });

  it('只新增一段：老段保留原时间，新段打当前时间', () => {
    const prev: ReviewTimeline = {
      snapshot: '甲',
      segments: [{ anchor: '甲', time: t1 }],
    };
    const segs = alignReviewSegments({ prevReview: '甲', prevTimeline: prev, newReview: '甲\n\n乙', now: t2 });
    expect(segs.map((s) => s.time)).toEqual([t1, t2]);
  });

  it('润色了段落：前缀够长就继承原时间', () => {
    const prev: ReviewTimeline = {
      snapshot: 'op 的合照记得看，ed 别跳',
      segments: [{ anchor: 'op 的合照记得看，ed 别跳', time: t1 }],
    };
    // 加了个「要」字
    const next = 'op 的合照记得看，ed 千万别跳';
    const segs = alignReviewSegments({ prevReview: prev.snapshot, prevTimeline: prev, newReview: next, now: t2 });
    expect(segs).toHaveLength(1);
    expect(segs[0].time).toBe(t1);
    // 锚点跟着新正文更新
    expect(segs[0].anchor).toBe(reviewAnchor(next));
  });

  it('删掉一段：剩下的段各自保留自己的时间，不串位', () => {
    const prev: ReviewTimeline = {
      snapshot: '甲\n\n乙\n\n丙',
      segments: [
        { anchor: '甲', time: t1 },
        { anchor: '乙', time: t1 },
        { anchor: '丙', time: t2 },
      ],
    };
    const segs = alignReviewSegments({ prevReview: prev.snapshot, prevTimeline: prev, newReview: '甲\n\n丙', now: '2026-02-01 00:00' });
    expect(segs.map((s) => s.anchor)).toEqual(['甲', '丙']);
    expect(segs.map((s) => s.time)).toEqual([t1, t2]);
  });

  it('在中间插入一段：新段打当前时间，后面的段不串位', () => {
    const prev: ReviewTimeline = {
      snapshot: '甲\n\n丙',
      segments: [
        { anchor: '甲', time: t1 },
        { anchor: '丙', time: t2 },
      ],
    };
    const segs = alignReviewSegments({ prevReview: prev.snapshot, prevTimeline: prev, newReview: '甲\n\n乙\n\n丙', now: '2026-02-01 00:00' });
    expect(segs.map((s) => s.anchor)).toEqual(['甲', '乙', '丙']);
    expect(segs.map((s) => s.time)).toEqual([t1, '2026-02-01 00:00', t2]);
  });

  it('两段内容一模一样时不会重复吃同一个锚点', () => {
    const prev: ReviewTimeline = {
      snapshot: '同样的话',
      segments: [{ anchor: '同样的话', time: t1 }],
    };
    const segs = alignReviewSegments({ prevReview: prev.snapshot, prevTimeline: prev, newReview: '同样的话\n\n同样的话', now: t2 });
    expect(segs.map((s) => s.time)).toEqual([t1, t2]);
  });

  it('保留用户手写的注释', () => {
    const prev: ReviewTimeline = {
      snapshot: '这段有剧透',
      segments: [{ anchor: '这段有剧透', time: t1, note: '剧透预警' }],
    };
    const segs = alignReviewSegments({ prevReview: prev.snapshot, prevTimeline: prev, newReview: '这段有剧透\n\n新的一段', now: t2 });
    expect(segs[0].note).toBe('剧透预警');
    expect(segs[1].note).toBeUndefined();
  });

  it('清空正文：段清空，时间线也清空', () => {
    const prev: ReviewTimeline = { snapshot: '甲', segments: [{ anchor: '甲', time: t1 }] };
    expect(alignReviewSegments({ prevReview: prev.snapshot, prevTimeline: prev, newReview: '', now: t2 })).toEqual([]);
  });

  it('快照与段数不一致（坏数据）时不崩，能匹配的照常继承', () => {
    const prev: ReviewTimeline = {
      snapshot: '甲\n\n乙',
      segments: [{ anchor: '甲', time: t1 }],
    };
    const segs = alignReviewSegments({ prevReview: prev.snapshot, prevTimeline: prev, newReview: '甲\n\n乙', now: t2 });
    expect(segs[0].time).toBe(t1);
    expect(segs[1].time).toBe(t2);
  });
});

describe('buildReviewParagraphs', () => {
  it('时间对齐时按段给出时间与色相', () => {
    const timeline: ReviewTimeline = {
      snapshot: '甲\n\n乙\n\n丙',
      segments: [
        { anchor: '甲', time: '2025-05-04 21:30' },
        { anchor: '乙', time: '2025-06-01 10:00' },
        { anchor: '丙', time: '2026-01-11 09:15' },
      ],
    };
    const view = buildReviewParagraphs('甲\n\n乙\n\n丙', timeline);
    expect(view.map((v) => v.time)).toEqual(['2025-05-04 21:30', '2025-06-01 10:00', '2026-01-11 09:15']);
    // 色相从冷到暖
    expect(view[0].hue).toBeLessThan(view[2].hue);
  });

  it('正文在外部被改过（段数变了）：能对上的段照常给时间，新增的段没有时间', () => {
    const timeline: ReviewTimeline = {
      snapshot: '甲\n\n乙',
      segments: [
        { anchor: '甲', time: '2025-05-04 21:30' },
        { anchor: '乙', time: '2025-06-01 10:00' },
      ],
    };
    const view = buildReviewParagraphs('甲\n\n乙\n\n丙', timeline);
    expect(view.map((v) => v.time)).toEqual(['2025-05-04 21:30', '2025-06-01 10:00', undefined]);
  });

  it('段内被手改：只对不上的那段不给时间', () => {
    const timeline: ReviewTimeline = {
      snapshot: '甲\n\n乙',
      segments: [
        { anchor: '甲', time: '2025-05-04 21:30' },
        { anchor: '乙', time: '2025-06-01 10:00' },
      ],
    };
    const view = buildReviewParagraphs('甲\n\n完全换掉的一段', timeline);
    expect(view[0].time).toBe('2025-05-04 21:30');
    expect(view[1].time).toBeUndefined();
  });

  it('没有时间线时也能正常渲染', () => {
    const view = buildReviewParagraphs('甲\n\n乙');
    expect(view).toHaveLength(2);
    expect(view.every((v) => v.time === undefined)).toBe(true);
  });

  it('没有时间线的老评价给了兜底时间：整篇按观看日中午渲染，并标估算', () => {
    const view = buildReviewParagraphs('甲\n\n乙', undefined, '2025-05-04 12:00');
    expect(view.every((v) => v.time === '2025-05-04 12:00')).toBe(true);
    expect(view.every((v) => v.estimated === true)).toBe(true);
  });

  it('已有时间线时兜底时间不生效（新写的段落不该被标成估算）', () => {
    const timeline: ReviewTimeline = {
      snapshot: '甲',
      segments: [{ anchor: '甲', time: '2025-05-04 21:30' }],
    };
    const view = buildReviewParagraphs('甲\n\n乙', timeline, '2025-05-04 12:00');
    expect(view[0]).toMatchObject({ time: '2025-05-04 21:30' });
    expect(view[0].estimated).toBeUndefined();
    expect(view[1].time).toBeUndefined();
  });
});

describe('reviewTintHue', () => {
  it('单段用品牌粉色相', () => {
    expect(reviewTintHue(0, 1)).toBe(330);
  });

  it('多段从冷到暖且单调递增', () => {
    const hues = [0, 1, 2, 3].map((i) => reviewTintHue(i, 4));
    expect(hues[0]).toBe(200);
    expect(hues[3]).toBe(330);
    for (let i = 1; i < hues.length; i++) expect(hues[i]).toBeGreaterThan(hues[i - 1]);
  });
});

describe('formatReviewTime', () => {
  it('精确到分钟，补零', () => {
    expect(formatReviewTime(new Date(2026, 0, 5, 9, 7))).toBe('2026-01-05 09:07');
  });
});

describe('reviewFallbackTime', () => {
  it('取日期前 10 位并补中午 12:00', () => {
    expect(reviewFallbackTime('2025-05-04')).toBe('2025-05-04 12:00');
    // ISO 时间戳也取日期部分
    expect(reviewFallbackTime('2025-05-04T09:30:00.000Z')).toBe('2025-05-04 12:00');
  });

  it('缺失或非法日期返回 undefined', () => {
    expect(reviewFallbackTime(undefined)).toBeUndefined();
    expect(reviewFallbackTime('')).toBeUndefined();
    expect(reviewFallbackTime('2025-05')).toBeUndefined();
    expect(reviewFallbackTime('不知道')).toBeUndefined();
  });
});

describe('parseReviewMeta / serializeReviewMeta', () => {
  it('空值返回 undefined / 空串', () => {
    expect(parseReviewMeta('')).toBeUndefined();
    expect(parseReviewMeta(undefined)).toBeUndefined();
    expect(serializeReviewMeta(undefined)).toBe('');
  });

  it('坏 JSON 当没有，不抛错', () => {
    expect(parseReviewMeta('{不是JSON')).toBeUndefined();
  });

  it('只有默认值时不写任何东西（不往格里塞空对象）', () => {
    expect(serializeReviewMeta({ v: 1 })).toBe('');
    expect(serializeReviewMeta({ v: 1, watchCount: 1, watchDates: [] })).toBe('');
  });

  it('往返一致', () => {
    const meta = {
      v: 1 as const,
      watchCount: 2,
      watchDates: ['2026-01-11'],
      timeline: { snapshot: '甲', segments: [{ anchor: '甲', time: '2025-05-04 21:30', note: '二刷' }] },
    };
    expect(parseReviewMeta(serializeReviewMeta(meta))).toEqual(meta);
  });
});

describe('normalizeWatchCount', () => {
  it('缺省和非法值当 1', () => {
    expect(normalizeWatchCount(undefined)).toBe(1);
    expect(normalizeWatchCount(0)).toBe(1);
    expect(normalizeWatchCount(-3)).toBe(1);
    expect(normalizeWatchCount('abc')).toBe(1);
  });

  it('取整并夹到 99', () => {
    expect(normalizeWatchCount(2.7)).toBe(2);
    expect(normalizeWatchCount(1000)).toBe(99);
  });
});
