/**
 * AppIcon — 统一图标组件
 * 默认使用 emoji 渲染，支持通过 ThemeContext.customIcons 替换为自定义图片
 */

import React from 'react';
import { useTheme } from './ThemeContext';
import type { IconKey } from './types';

// ── 默认 emoji 映射表 ──
const EMOJI_MAP: Record<IconKey, string> = {
  // 通用操作
  search: '🔍',
  add: '➕',
  delete: '🗑️',
  edit: '✏️',
  save: '💾',
  close: '✕',
  'left-arrow': '◀',
  'right-arrow': '▶',
  import: '📥',
  export: '📤',
  // 导航/折叠
  'collapse-open': '▼',
  'collapse-close': '▶',
  'batch-check': '✓',
  // 番剧相关
  anime: '🎬',
  calendar: '📅',
  episodes: '📺',
  'bgm-score': '⭐',
  'external-link': '🔗',
  // 评分/分析
  'radar-chart': '📊',
  'ai-analysis': '🤖',
  'ai-target': '🎯',
  'ai-signal': '📡',
  'ai-globe': '🌐',
  review: '📝',
  'taste-report': '📋',
  // 海报/图片
  poster: '🖼️',
  'poster-save': '💾',
  'original-image': '🔍',
  'image-manager': '🖼️',
  // 标签/图谱
  'tag-manager': '🏷️',
  'smart-tag': '🤖',
  'batch-tag': '🏷️',
  'knowledge-graph': '🕸️',
  // 设置/工具
  settings: '⚙️',
  theme: '🎨',
  template: '📐',
  'dimension-manager': '📐',
  'user-data-export': '💾',
  'user-data-import': '📂',
  'fix-search': '🔄',
  'persist-posters': '🖼',
  'open-excel': '📋',
  // 状态
  loading: '⏳',
  empty: '📭',
  success: '✅',
  'warning-icon': '⚠️',
};

// ── 图标尺寸映射（emoji 按 fontSize 渲染） ──
interface AppIconProps {
  name: IconKey;
  size?: number;
  style?: React.CSSProperties;
  className?: string;
}

const AppIcon: React.FC<AppIconProps> = ({ name, size = 16, style, className }) => {
  const { state } = useTheme();
  const customUrl = state.customIcons[name];

  // 自定义图标：渲染 <img>
  if (customUrl) {
    return (
      <img
        src={customUrl}
        alt={name}
        style={{
          width: size,
          height: size,
          display: 'inline-block',
          verticalAlign: 'middle',
          objectFit: 'contain',
          ...style,
        }}
        className={className}
      />
    );
  }

  // 默认 emoji
  const emoji = EMOJI_MAP[name] || '•';

  return (
    <span
      style={{
        fontSize: size,
        display: 'inline-block',
        verticalAlign: 'middle',
        lineHeight: 1,
        ...style,
      }}
      className={className}
      role="img"
      aria-label={name}
    >
      {emoji}
    </span>
  );
};

export default AppIcon;
