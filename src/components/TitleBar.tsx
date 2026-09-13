/**
 * 自定义标题栏（仅桌面版渲染）
 *
 * 主进程用 `titleBarStyle: 'hidden'` 隐藏了系统标题栏，窗口内容因此延伸到顶部；
 * 这个组件补一条可拖动区域来显示应用名，右侧留空给系统窗口按钮
 * （由 `titleBarOverlay` 绘制，仍然是系统原生按钮，保留缩放手势）。
 */
import React from 'react';

const TitleBar: React.FC = () => {
  // 浏览器里没有 electronAPI，不渲染
  if (!window.electronAPI) return null;

  return (
    <div className="app-titlebar">
      <span className="app-titlebar-logo">🎬</span>
      <span className="app-titlebar-title">AnimeDiary</span>
      <span className="app-titlebar-sub">番剧评分管理</span>
    </div>
  );
};

export default TitleBar;
