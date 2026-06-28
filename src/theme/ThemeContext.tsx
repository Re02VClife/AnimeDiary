/**
 * ThemeProvider + useTheme hook
 * 管理主题模式、自定义配色、猫娘模式、自定义图标，全部持久化到 localStorage
 */

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useMemo,
  type ReactNode,
} from 'react';
import type { ThemeMode, ThemeColors, ThemeState, IconKey } from './types';
import { THEME_STORAGE_KEY } from './types';
import { mergeColors, colorsToCSSVariables } from './presets';

// ── 默认状态 ──
const DEFAULT_STATE: ThemeState = {
  themeMode: 'dark',
  customColors: {},
  catgirlMode: false,
  customIcons: {},
};

// ── Context 类型 ──
interface ThemeContextValue {
  state: ThemeState;

  /** 当前生效的颜色（预设合并自定义） */
  colors: ThemeColors;

  /** 切换深色/浅色 */
  setThemeMode: (mode: ThemeMode) => void;

  /** 更新自定义颜色（传入部分颜色，只保存与预设不同的值） */
  setCustomColors: (colors: Partial<ThemeColors>) => void;

  /** 重置自定义颜色为预设 */
  resetCustomColors: () => void;

  /** 切换猫娘模式 */
  toggleCatgirlMode: () => void;

  /** 设置自定义图标 */
  setCustomIcons: (icons: Partial<Record<IconKey, string>>) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

// ── 从 localStorage 加载 ──
const loadState = (): ThemeState => {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        themeMode: parsed.themeMode || 'dark',
        customColors: parsed.customColors || {},
        catgirlMode: !!parsed.catgirlMode,
        customIcons: parsed.customIcons || {},
      };
    }
  } catch {
    // 忽略解析错误，使用默认
  }
  return { ...DEFAULT_STATE };
};

// ── 保存到 localStorage ──
const saveState = (state: ThemeState) => {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 静默失败
  }
};

// ── 应用 CSS 变量到 document.documentElement ──
const applyCSSVariables = (colors: ThemeColors) => {
  const css = colorsToCSSVariables(colors);
  // 将 CSS 变量字符串拆分为单条设置到 style 上
  const root = document.documentElement;
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
  Object.entries(map).forEach(([key, val]) => {
    root.style.setProperty(key, val);
  });
};

// ── Provider 组件 ──
export const ThemeProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [state, setState] = useState<ThemeState>(loadState);

  // 计算当前生效颜色
  const colors = useMemo(
    () => mergeColors(state.themeMode, state.customColors),
    [state.themeMode, state.customColors],
  );

  // 颜色变更时同步到 CSS 变量和 data-theme 属性
  useEffect(() => {
    applyCSSVariables(colors);
    document.documentElement.setAttribute('data-theme', state.themeMode);
  }, [colors, state.themeMode]);

  // 状态变更时持久化
  useEffect(() => {
    saveState(state);
  }, [state]);

  // ── Actions ──

  const setThemeMode = useCallback((mode: ThemeMode) => {
    setState((prev) => ({ ...prev, themeMode: mode }));
  }, []);

  const setCustomColors = useCallback((partial: Partial<ThemeColors>) => {
    setState((prev) => ({
      ...prev,
      customColors: { ...prev.customColors, ...partial },
    }));
  }, []);

  const resetCustomColors = useCallback(() => {
    setState((prev) => ({ ...prev, customColors: {} }));
  }, []);

  const toggleCatgirlMode = useCallback(() => {
    setState((prev) => ({ ...prev, catgirlMode: !prev.catgirlMode }));
  }, []);

  const setCustomIcons = useCallback(
    (icons: Partial<Record<IconKey, string>>) => {
      setState((prev) => ({
        ...prev,
        customIcons: { ...prev.customIcons, ...icons },
      }));
    },
    [],
  );

  const value = useMemo<ThemeContextValue>(
    () => ({
      state,
      colors,
      setThemeMode,
      setCustomColors,
      resetCustomColors,
      toggleCatgirlMode,
      setCustomIcons,
    }),
    [state, colors, setThemeMode, setCustomColors, resetCustomColors, toggleCatgirlMode, setCustomIcons],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
};

// ── useTheme hook ──
export const useTheme = (): ThemeContextValue => {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme 必须在 ThemeProvider 内部使用');
  }
  return ctx;
};

export default ThemeContext;
