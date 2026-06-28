/**
 * src/theme — 全局主题系统
 */

export { ThemeProvider, useTheme } from './ThemeContext';
export { default as AppIcon } from './AppIcon';
export {
  DARK_COLORS,
  LIGHT_COLORS,
  getPresetColors,
  mergeColors,
  colorsToCSSVariables,
} from './presets';
export type { ThemeMode, ThemeColors, ThemeState, IconKey } from './types';
export { ICON_KEYS, THEME_STORAGE_KEY } from './types';
export { catgirlfy, catgirlSystemPrompt, useCatgirlText, catgirlMessage, isCatgirlMode } from './catgirl';
