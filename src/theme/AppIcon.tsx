/**
 * AppIcon — 统一图标组件
 * 浅色主题优先使用内置「二次元贴纸」图标集（src/assets/icons/light），
 * 缺图时回退 emoji；ThemeContext.customIcons 的优先级最高。
 */

import React from 'react';
import { useTheme } from './ThemeContext';
import type { IconKey, ThemeMode } from './types';

// ── 内置图标集：文件名即 IconKey，缺哪个就回退 emoji ──
const toUrlMap = (mods: Record<string, unknown>): Record<string, string> => {
  const set: Record<string, string> = {};
  Object.entries(mods).forEach(([file, url]) => {
    const key = file.split('/').pop()?.replace(/\.png$/i, '');
    if (key) set[key] = String(url);
  });
  return set;
};

export const BUILTIN_ICONS: Record<ThemeMode, Record<string, string>> = {
  // 浅色：粉紫描边的圆角贴纸图标
  light: toUrlMap(
    import.meta.glob('../assets/icons/light/*.png', {
      eager: true,
      query: '?url',
      import: 'default',
    }),
  ),
  // 深色：目录为空时自动回退 emoji
  dark: toUrlMap(
    import.meta.glob('../assets/icons/dark/*.png', {
      eager: true,
      query: '?url',
      import: 'default',
    }),
  ),
};

/**
 * 角色头像图标（设置里的「图标库」可手动替换过来）。
 * customIcons 里存的是 `char:<角色名>` 而不是 URL——打包后资源带哈希，
 * 直接存 URL 会在下次构建后全部 404。
 */
export const CHARACTER_ICONS: Record<string, string> = {
  ...toUrlMap(
    import.meta.glob('../assets/icons/portraits-v2/*.png', {
      eager: true,
      query: '?url',
      import: 'default',
    }),
  ),
  ...toUrlMap(
    import.meta.glob('../assets/icons/portraits-batch2/*.png', {
      eager: true,
      query: '?url',
      import: 'default',
    }),
  ),
};

/** 把 customIcons 的存储值（char:名字 或 直接 URL）解析成可用的图片地址 */
export const resolveIconValue = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  return value.startsWith('char:') ? CHARACTER_ICONS[value.slice(5)] : value;
};

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
  // 标签
  'tag-manager': '🏷️',
  'smart-tag': '🤖',
  'batch-tag': '🏷️',
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
  // 自定义图标 > 当前主题内置图标 > emoji
  const customUrl =
    resolveIconValue(state.customIcons[name]) || BUILTIN_ICONS[state.themeMode]?.[name];

  // 图片图标：渲染 <img>
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
