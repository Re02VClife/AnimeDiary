/**
 * 评价时间线的显示偏好
 *
 * 这三项都是纯观感开关，不参与数据写入，所以放 localStorage 而不是 Excel ——
 * 换台机器后评价正文和它各段的时间都还在，只是显示方式回到默认，这没有问题。
 *
 * 与 quick-actions 同一套写法：localStorage + 自定义事件，
 * 让设置面板改了之后详情面板立刻跟着变（不需要刷新）。
 */
import { useCallback, useEffect, useState } from 'react';

export interface ReviewDisplayPrefs {
  /** 段落底纹：给每一段一个很淡的背景，鼠标移上去才浮出时间 */
  tint: boolean;
  /** 底纹按写作先后取色（关掉则统一用品牌色） */
  multicolor: boolean;
  /** 悬停时显示时间气泡（关掉后底纹只是装饰，不弹窗） */
  hoverTime: boolean;
}

export const DEFAULT_REVIEW_DISPLAY: ReviewDisplayPrefs = {
  tint: true,
  multicolor: true,
  hoverTime: true,
};

const STORAGE_KEY = 'anime_diary_review_display';
const CHANGE_EVENT = 'anime_diary_review_display_changed';

export function loadReviewDisplayPrefs(): ReviewDisplayPrefs {
  if (typeof window === 'undefined') return DEFAULT_REVIEW_DISPLAY;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_REVIEW_DISPLAY;
    const parsed = JSON.parse(raw) as Partial<ReviewDisplayPrefs>;
    return {
      tint: typeof parsed.tint === 'boolean' ? parsed.tint : DEFAULT_REVIEW_DISPLAY.tint,
      multicolor: typeof parsed.multicolor === 'boolean' ? parsed.multicolor : DEFAULT_REVIEW_DISPLAY.multicolor,
      hoverTime: typeof parsed.hoverTime === 'boolean' ? parsed.hoverTime : DEFAULT_REVIEW_DISPLAY.hoverTime,
    };
  } catch {
    return DEFAULT_REVIEW_DISPLAY;
  }
}

export function saveReviewDisplayPrefs(prefs: ReviewDisplayPrefs): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    /* 写不进去也不影响当前会话 */
  }
}

/** 设置面板与详情面板共用 */
export function useReviewDisplayPrefs() {
  const [prefs, setPrefs] = useState<ReviewDisplayPrefs>(loadReviewDisplayPrefs);

  useEffect(() => {
    const sync = () => setPrefs(loadReviewDisplayPrefs());
    window.addEventListener(CHANGE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const update = useCallback((patch: Partial<ReviewDisplayPrefs>) => {
    const next = { ...loadReviewDisplayPrefs(), ...patch };
    saveReviewDisplayPrefs(next);
    setPrefs(next);
  }, []);

  return { prefs, update };
}
