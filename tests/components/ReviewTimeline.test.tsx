/**
 * ReviewTimeline 的渲染冒烟测试。
 *
 * 对齐逻辑在 core 里单测过了；这里只保证「阅读态不崩、该出现的底纹出现了」——
 * Popover 包裹 inline span、CSS 变量注入这些只有真实渲染才会暴露问题。
 *
 * 与 BangumiSyncModal.test.tsx 一样用 react-dom/client 手动渲染，
 * 项目没装 @testing-library/react。
 */
import React, { act } from 'react';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import ReviewTimeline from '../../src/components/ReviewTimeline';
import type { ReviewTimeline as TimelineData } from '../../core/review-timeline';
import { DEFAULT_REVIEW_DISPLAY } from '../../src/features/review-timeline/review-display-prefs';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(node: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root!.render(node); });
  return container;
}

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  container = null;
  root = null;
});

const TIMELINE: TimelineData = {
  snapshot: '第一段\n\n第二段',
  segments: [
    { anchor: '第一段', time: '2025-05-04 21:30' },
    { anchor: '第二段', time: '2026-01-11 09:15', note: '二刷' },
  ],
};

describe('ReviewTimeline', () => {
  it('有时间记录时，按段铺底纹并注入色相变量', () => {
    const el = render(
      <ReviewTimeline review={'第一段\n\n第二段'} timeline={TIMELINE} prefs={DEFAULT_REVIEW_DISPLAY} />,
    );
    const segs = el.querySelectorAll('.review-seg');
    expect(segs).toHaveLength(2);
    // 两段色相不同：越往后越暖
    const h0 = Number((segs[0] as HTMLElement).style.getPropertyValue('--seg-hue'));
    const h1 = Number((segs[1] as HTMLElement).style.getPropertyValue('--seg-hue'));
    expect(h0).toBeLessThan(h1);
  });

  it('整篇都没有时间记录时退回纯文本，不铺任何底纹', () => {
    const el = render(<ReviewTimeline review="老评价" prefs={DEFAULT_REVIEW_DISPLAY} />);
    expect(el.querySelectorAll('.review-seg')).toHaveLength(0);
    expect(el.textContent).toContain('老评价');
  });

  it('关掉底纹后不铺底纹，但正文照常显示', () => {
    const el = render(
      <ReviewTimeline
        review={'第一段\n\n第二段'}
        timeline={TIMELINE}
        prefs={{ ...DEFAULT_REVIEW_DISPLAY, tint: false }}
      />,
    );
    expect(el.querySelectorAll('.review-seg')).toHaveLength(0);
    expect(el.textContent).toContain('第一段');
    expect(el.textContent).toContain('第二段');
  });

  it('只给对得上时间的段落铺底纹（新增段没有时间）', () => {
    const el = render(
      <ReviewTimeline review={'第一段\n\n第二段\n\n第三段'} timeline={TIMELINE} prefs={DEFAULT_REVIEW_DISPLAY} />,
    );
    // 第三段匹配不上，不应有底纹
    expect(el.querySelectorAll('.review-seg')).toHaveLength(2);
  });
});
