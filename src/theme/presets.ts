/**
 * 深色/浅色预设色值 + CSS 变量生成
 */

import type { ThemeColors, ThemeMode } from './types';

// ── 深色预设（与当前硬编码颜色完全一致，保证向后兼容） ──
export const DARK_COLORS: ThemeColors = {
  bgPrimary: '#0d1117',
  bgSecondary: '#161b22',
  bgTertiary: '#1c2128',
  bgQuaternary: '#21262d',
  borderPrimary: '#30363d',
  textPrimary: '#e6edf3',
  textSecondary: '#8b949e',
  textMuted: '#484f58',
  brandPrimary: '#fb7299',
  colorSuccess: '#3fb950',
  colorWarning: '#d29922',
  colorError: '#f85149',
  colorInfo: '#58a6ff',
  scrollbarThumb: '#30363d',
  scrollbarThumbHover: '#484f58',
};

// ── 浅色预设 ──
export const LIGHT_COLORS: ThemeColors = {
  bgPrimary: '#ffffff',
  bgSecondary: '#f6f8fa',
  bgTertiary: '#ffffff',
  bgQuaternary: '#f0f0f0',
  borderPrimary: '#d0d7de',
  textPrimary: '#1f2328',
  textSecondary: '#656d76',
  textMuted: '#8b949e',
  brandPrimary: '#cf2256',
  colorSuccess: '#1a7f37',
  colorWarning: '#9a6700',
  colorError: '#cf222e',
  colorInfo: '#0969da',
  scrollbarThumb: '#d0d7de',
  scrollbarThumbHover: '#8b949e',
};

// ── 根据模式获取预设 ──
export const getPresetColors = (mode: ThemeMode): ThemeColors =>
  mode === 'dark' ? DARK_COLORS : LIGHT_COLORS;

// ── 合并自定义颜色到预设 ──
export const mergeColors = (
  mode: ThemeMode,
  custom?: Partial<ThemeColors>,
): ThemeColors => {
  const base = getPresetColors(mode);
  if (!custom) return base;
  return { ...base, ...custom };
};

// ── 将 ThemeColors 转为 CSS 变量字符串 ──
export const colorsToCSSVariables = (colors: ThemeColors): string => {
  const map: Record<string, string> = {
    '--bg-primary': colors.bgPrimary,
    '--bg-secondary': colors.bgSecondary,
    '--bg-tertiary': colors.bgTertiary,
    '--bg-quaternary': colors.bgQuaternary,
    '--border-primary': colors.borderPrimary,
    '--text-primary': colors.textPrimary,
    '--text-secondary': colors.textSecondary,
    '--text-muted': colors.textMuted,
    '--brand-primary': colors.brandPrimary,
    '--color-success': colors.colorSuccess,
    '--color-warning': colors.colorWarning,
    '--color-error': colors.colorError,
    '--color-info': colors.colorInfo,
    '--scrollbar-thumb': colors.scrollbarThumb,
    '--scrollbar-thumb-hover': colors.scrollbarThumbHover,
  };
  return Object.entries(map)
    .map(([k, v]) => `${k}: ${v};`)
    .join('\n  ');
};
