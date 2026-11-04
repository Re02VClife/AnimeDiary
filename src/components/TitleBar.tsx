/**
 * 自定义标题栏（仅桌面版渲染）
 *
 * 主进程用 `titleBarStyle: 'hidden'` 隐藏了系统标题栏，窗口内容因此延伸到顶部；
 * 这个组件补一条可拖动区域来显示应用名，右侧留空给系统窗口按钮
 * （由 `titleBarOverlay` 绘制，仍然是系统原生按钮，保留缩放手势）。
 *
 * 它把自身高度写成 CSS 变量 `--app-titlebar-height`：
 * 抽屉这类 `position: fixed; top: 0` 的浮层不在布局流里，感知不到这条标题栏，
 * 会直接钻到系统窗口按钮底下。让它们读这个变量自己下移。
 * 浏览器里没有标题栏 → 变量不设 → 读方用 fallback 0px。
 */
import React, { useEffect } from 'react';

/** 与 electron/main.js 的 titleBarOverlay.height 及 App.css 的 .app-titlebar 保持一致 */
const TITLEBAR_HEIGHT = 36;

const TitleBar: React.FC = () => {
  // 浏览器里没有 electronAPI，不渲染
  const isDesktop = Boolean(window.electronAPI);

  useEffect(() => {
    if (!isDesktop) return;
    const root = document.documentElement;
    root.style.setProperty('--app-titlebar-height', `${TITLEBAR_HEIGHT}px`);
    return () => { root.style.removeProperty('--app-titlebar-height'); };
  }, [isDesktop]);

  if (!isDesktop) return null;

  return (
    <div className="app-titlebar">
      <span className="app-titlebar-logo">🎬</span>
      <span className="app-titlebar-title">AnimeDiary</span>
      <span className="app-titlebar-sub">番剧评分管理</span>
    </div>
  );
};

export default TitleBar;
