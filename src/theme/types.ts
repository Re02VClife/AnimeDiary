/**
 * 主题系统类型定义
 * 定义主题模式、颜色 token、图标标识和主题状态
 */

// ── 主题模式 ──
export type ThemeMode = 'dark' | 'light';

// ── 语义颜色 token（14 个） ──
export interface ThemeColors {
  /** 页面主背景 */
  bgPrimary: string;
  /** 侧栏/卡片背景 */
  bgSecondary: string;
  /** 输入框/弹层背景 */
  bgTertiary: string;
  /** 标签/芯片背景 */
  bgQuaternary: string;
  /** 主边框/分割线 */
  borderPrimary: string;
  /** 主文字 */
  textPrimary: string;
  /** 辅助文字 */
  textSecondary: string;
  /** 占位/禁用文字 */
  textMuted: string;
  /** 品牌强调色（粉红） */
  brandPrimary: string;
  /** 成功/绿色 */
  colorSuccess: string;
  /** 警告/橙色 */
  colorWarning: string;
  /** 错误/红色 */
  colorError: string;
  /** 信息/蓝色 */
  colorInfo: string;
  /** 滚动条滑块 */
  scrollbarThumb: string;
  /** 滚动条 hover */
  scrollbarThumbHover: string;
}

// ── 图标标识 ──
export const ICON_KEYS = [
  // 通用操作
  'search', 'add', 'delete', 'edit', 'save', 'close',
  'left-arrow', 'right-arrow', 'import', 'export',
  // 导航/折叠
  'collapse-open', 'collapse-close', 'batch-check',
  // 番剧相关
  'anime', 'calendar', 'episodes', 'bgm-score', 'external-link',
  // 评分/分析
  'radar-chart', 'ai-analysis', 'ai-target', 'ai-signal', 'ai-globe',
  'review', 'taste-report',
  // 海报/图片
  'poster', 'poster-save', 'original-image', 'image-manager',
  // 标签/图谱
  'tag-manager', 'smart-tag', 'batch-tag', 'knowledge-graph',
  // 设置/工具
  'settings', 'theme', 'template', 'dimension-manager',
  'user-data-export', 'user-data-import', 'fix-search',
  'persist-posters', 'open-excel',
  // 状态
  'loading', 'empty', 'success', 'warning-icon',
] as const;

export type IconKey = (typeof ICON_KEYS)[number];

// ── 主题状态 ──
export interface ThemeState {
  /** 深色/浅色模式 */
  themeMode: ThemeMode;
  /** 用户自定义颜色覆盖（只保存与预设不同的值） */
  customColors: Partial<ThemeColors>;
  /** 猫娘模式开关 */
  catgirlMode: boolean;
  /** 自定义图标映射（图标 key → 图片 URL/dataURL） */
  customIcons: Partial<Record<IconKey, string>>;
}

// ── localStorage 键名 ──
export const THEME_STORAGE_KEY = 'anime_diary_theme';
