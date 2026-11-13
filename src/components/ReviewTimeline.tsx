/**
 * ReviewTimeline — 评价的阅读态渲染
 *
 * 一条番会被反复重刷，评价是分很多次写下的。这里把正文按段落切开，
 * 给**有时间记录**的那几段铺一层很淡的底纹（形似荧光笔），鼠标移上去才浮出
 * 「什么时候写的」以及一个可填的备注（「二刷」「剧透预警」）。
 *
 * 几个刻意的取舍：
 *   - 没有时间记录的段落**不铺底纹**。底纹本身就是「这段有记录」的提示，
 *     否则用户永远不知道该往哪儿悬停。老评价（从没记录过时间）看上去就跟以前一样。
 *   - 着色只落在背景上，文字保持 `--text-primary`。通篇彩色字会挤掉正文的可读性，
 *     而底色深浅不影响认字。
 *   - 底纹用 inline 的 span 而不是 block：贴合文字更像荧光笔，也不会把短段落
 *     拉成一条横贯整行的色带。
 */
import React, { useEffect, useState } from 'react';
import { Popover, Input } from 'antd';
import type { ReviewTimeline as ReviewTimelineData } from '../../core/review-timeline';
import { buildReviewParagraphs, type ReviewParagraphView } from '../../core/review-timeline';
import type { ReviewDisplayPrefs } from '../features/review-timeline/review-display-prefs';

interface ReviewTimelineProps {
  review: string;
  timeline?: ReviewTimelineData;
  prefs: ReviewDisplayPrefs;
  /** 老评价（没有历史时间）的兜底时间：观看日 12:00，界面上会标成「约」 */
  fallbackTime?: string;
  /** 改某段备注。不传则气泡里只显示时间 */
  onNoteChange?: (segmentIndex: number, note: string) => void;
}

/** 气泡：时间 + 备注输入 */
const SegmentBubble: React.FC<{
  para: ReviewParagraphView;
  onNoteChange?: (segmentIndex: number, note: string) => void;
}> = ({ para, onNoteChange }) => {
  const [draft, setDraft] = useState(para.note ?? '');

  // 保存后父级会带回新的 note（可能是被别处改过的），同步回来
  useEffect(() => {
    setDraft(para.note ?? '');
  }, [para.note]);

  const commit = () => {
    const value = draft.trim();
    if (value === (para.note ?? '')) return;
    onNoteChange?.(para.index, value);
  };

  return (
    <div style={{ maxWidth: 260 }}>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
        {para.time ? (
          <>
            {para.estimated ? '约 ' : '写于 '}
            <b style={{ color: 'var(--text-primary)' }}>{para.time}</b>
            {para.estimated && (
              <span style={{ fontSize: 11, opacity: 0.75 }}>（按观看日补录）</span>
            )}
          </>
        ) : '这段没有记录时间'}
      </div>
      {onNoteChange && (
        <Input
          size="small"
          value={draft}
          maxLength={40}
          placeholder="备注：二刷 / 剧透预警…"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onPressEnter={commit}
        />
      )}
      {!onNoteChange && para.note && (
        <div style={{ fontSize: 12, color: 'var(--brand-primary)' }}>{para.note}</div>
      )}
    </div>
  );
};

const ReviewTimeline: React.FC<ReviewTimelineProps> = ({ review, timeline, prefs, fallbackTime, onNoteChange }) => {
  const paragraphs = buildReviewParagraphs(review, timeline, fallbackTime);
  const anyTime = paragraphs.some((p) => !!p.time);

  // 整篇都没有时间：维持原来的纯文本观感，不铺任何底纹
  if (!anyTime) {
    return (
      <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.75, color: 'var(--text-primary)' }}>
        {review}
      </div>
    );
  }

  return (
    <div style={{ lineHeight: 1.9, color: 'var(--text-primary)' }}>
      {paragraphs.map((para, i) => {
        const hasTime = !!para.time;
        const tinted = hasTime && prefs.tint;
        // 有底纹时按写作先后取色（冷 → 暖）；关掉多色就统一用品牌粉色相
        const hue = prefs.multicolor ? para.hue : 330;

        const body = (
          <span
            className={tinted ? 'review-seg' : undefined}
            style={tinted ? ({ '--seg-hue': hue } as React.CSSProperties) : undefined}
          >
            {para.text}
          </span>
        );

        return (
          <React.Fragment key={para.index}>
            {i > 0 && <div style={{ height: 10 }} />}
            {hasTime && prefs.hoverTime ? (
              <Popover
                content={<SegmentBubble para={para} onNoteChange={onNoteChange} />}
                mouseEnterDelay={0.2}
                trigger="hover"
                placement="top"
              >
                {body}
              </Popover>
            ) : body}
          </React.Fragment>
        );
      })}
    </div>
  );
};

export default ReviewTimeline;
