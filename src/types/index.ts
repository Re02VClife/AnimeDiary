/** 番剧分类 */
export type AnimeCategory = 'watching' | 'wantToWatch' | 'onHold' | 'watched' | 'dropped';

/** 评分维度定义 */
export interface Dimension {
  key: string;
  label: string;
  description: string;
  weight: number; // 0-1, 用于计算综合分
}

/** 番剧标签 */
export interface AnimeTag {
  name: string;
  highlighted: boolean;
}

/** 单维度评分 */
export interface DimensionScore {
  dimensionKey: string;
  score: number; // 0-10
}

/** 维度专项评价 */
export interface DimensionReview {
  dimensionKey: string;
  content: string;
}

/** 番剧条目 */
export interface AnimeEntry {
  id: string;
  /** Excel 行号（0-based，用于写回定位） */
  excelRowIndex?: number;
  title: string;
  titleJa?: string;
  /** 检索别名（Excel 检索名列） */
  searchAlias?: string;
  posterUrl: string;
  category: AnimeCategory;
  tags: AnimeTag[];
  /** 评分模板 ID，缺省时使用默认模板 */
  templateId?: string;
  scores: DimensionScore[];
  releaseDate?: string;
  bangumiScore?: number;
  /** Bangumi subject ID，用于关联和跳转 */
  bangumiId?: number;
  characters?: string[];
  episodes?: number;
  /** 制作组/动画公司 */
  studio?: string;
  /** 总张数（中割统计） */
  frameCount?: number;
  /** AniList 评分 */
  aniListScore?: number;
  /** 观看时间（首刷日期） */
  watchDate?: string;
  /** 全局评价 */
  review?: string;
  /** 备注 */
  notes?: string;
  /** 维度专项评价 */
  dimensionReviews?: DimensionReview[];
  /** 模板自定义补充字段（key-value）*/
  customFields?: Record<string, string | number>;
  /** 外部链接（详情页标题处可跳转） */
  link?: string;
  createdAt: string;
  updatedAt: string;
}

/** 单集评价 */
export interface EpisodeReview {
  id: string;
  animeId: string;
  episodeNumber: number;
  title?: string;
  plot: string;        // 主要剧情
  highlights: string;  // 名场面
  score: number;       // 单集评分 0-10
  impression: string;  // 观后感
  createdAt: string;
}

/** 看番日历记录 */
export interface WatchRecord {
  date: string; // YYYY-MM-DD
  animeId: string;
  episodeCount: number;
}

/** 评价（Legacy，保留兼容） */
export interface Review {
  id: string;
  animeId: string;
  type: 'global' | 'episode';
  episodeNumber?: number;
  content: string;
  highlights: string[]; // 名场面
  score?: number;
  createdAt: string;
}

/** 图片条目 */
export interface ImageEntry {
  id: string;
  animeId: string;
  animeTitle: string;
  fileName: string;
  dataUrl: string; // 显示用 URL（API 路径）
  filePath?: string; // 本地相对路径
  size?: number;
  type: 'screenshot' | 'fanart' | 'other';
  createdAt: string;
}

/** 用户本地覆盖数据 */
export interface AnimeOverrides {
  /** 分类覆盖：animeId → category */
  categories: Record<string, AnimeCategory>;
  /** 在看删除黑名单：animeId → true */
  watchingDeleted: Record<string, boolean>;
  /** 自定义维度（覆盖默认） */
  dimensions?: Dimension[];
}

/** Bangumi 搜索结果 */
export interface BangumiSearchItem {
  id: number;
  name: string;
  name_cn: string;
  summary: string;
  /** 封面图 */
  images: {
    large: string;
    common: string;
    medium: string;
    small: string;
  };
  rating: {
    score: number;
    total: number;
  };
  /** 上映日期 */
  air_date: string;
  /** 总集数 */
  eps: number;
}

/** 分类标签配置 */
export const CATEGORY_CONFIG: Record<AnimeCategory, { label: string; color: string }> = {
  watching: { label: '在看', color: '#fb7299' },
  wantToWatch: { label: '想看', color: '#fb7299' },
  onHold: { label: '搁置', color: '#fb7299' },
  watched: { label: '看过', color: '#fb7299' },
  dropped: { label: '抛弃', color: '#fb7299' },
};

// ── 评分模板系统 ──

/** 默认评分模板 ID */
export const DEFAULT_TEMPLATE_ID = 'default';

/** 适用题材类型 */
export type TemplateGenre = 'anime' | 'game' | 'movie' | 'book' | 'custom';

/** 自定义字段定义 */
export interface TemplateCustomField {
  key: string;
  label: string;
  type: 'text' | 'number';
}

/** 模板字段配置 — 控制详情面板显示哪些字段 */
export interface TemplateFieldConfig {
  showAnilistScore: boolean;
  showBangumiId: boolean;
  showReleaseDate: boolean;
  showFrameCount: boolean;
  showStudio: boolean;
  showCharacters: boolean;
  showEpisodes: boolean;
  /** 模板自定义补充字段定义 */
  customFields: TemplateCustomField[];
}

/** 默认字段配置（动画模板：全部显示） */
export const DEFAULT_FIELD_CONFIG: TemplateFieldConfig = {
  showAnilistScore: true,
  showBangumiId: true,
  showReleaseDate: true,
  showFrameCount: true,
  showStudio: true,
  showCharacters: true,
  showEpisodes: false,
  customFields: [],
};

/** 分类标签覆盖（key = AnimeCategory 原始值） */
export type CategoryOverrides = Partial<Record<string, string>>;

/** 从模板的分类标签覆盖中提取"可见分类"列表。
 *  - 有非空 label 的分类 → 在顶栏显示 tab
 *  - label 为空/未设置 → 隐藏该分类 tab
 *  - 返回 [] 表示全部留空 → 不按分类筛选，显示该模板所有条目 */
export function getVisibleCategories(labels?: CategoryOverrides): AnimeCategory[] {
  if (!labels) return [];
  return (Object.keys(CATEGORY_CONFIG) as AnimeCategory[])
    .filter((cat) => labels[cat] && String(labels[cat]).trim() !== '');
}

/** 海报宽高比预设 */
export type PosterAspectRatio = '3/4' | '16/9' | '2/3' | '1/1';

/** 详情面板布局配置（模板级别，编辑模式下可拖动调整） */
export interface DetailLayoutConfig {
  /** 海报宽度百分比（相对于右侧栏，30-100），默认 100 */
  posterWidth: number;
  /** 海报宽高比，默认 '3/4' */
  posterAspectRatio: PosterAspectRatio;
  /** 左栏宽度百分比（30-80），默认 67 */
  leftRatio: number;
  /** 左栏区块排序（key 数组，越前越靠上） */
  leftOrder: string[];
  /** 右栏区块排序 */
  rightOrder: string[];
}

/** 默认详情面板布局（与当前硬编码布局一致） */
export const DEFAULT_DETAIL_LAYOUT: DetailLayoutConfig = {
  posterWidth: 100,
  posterAspectRatio: '3/4',
  leftRatio: 67,
  leftOrder: ['radar', 'scores', 'ai', 'review'],
  rightOrder: ['poster', 'characters', 'tags'],
};

/** 评分模板 */
export interface ScoreTemplate {
  id: string;
  name: string;
  applicableGenre: TemplateGenre;
  dimensions: Dimension[];
  isDefault: boolean;
  /** 详情面板字段配置 */
  fieldConfig: TemplateFieldConfig;
  /** 分类标签覆盖（可自定义"在看""看过"等的显示名） */
  categoryLabels?: CategoryOverrides;
  /** 详情面板布局配置（拖拽排序 + 海报尺寸等，缺省使用默认布局） */
  layoutConfig?: DetailLayoutConfig;
  createdAt: string;
  updatedAt: string;
}

/** 创建默认模板（维度 = DEFAULT_DIMENSIONS） */
export function createDefaultTemplate(): ScoreTemplate {
  return {
    id: DEFAULT_TEMPLATE_ID,
    name: '番剧评分',
    applicableGenre: 'anime',
    dimensions: DEFAULT_DIMENSIONS.map((d) => ({ ...d })),
    isDefault: true,
    fieldConfig: { ...DEFAULT_FIELD_CONFIG, customFields: [] },
    categoryLabels: {},
    layoutConfig: { ...DEFAULT_DETAIL_LAYOUT },
    createdAt: new Date().toISOString().split('T')[0],
    updatedAt: new Date().toISOString().split('T')[0],
  };
}

/**
 * @deprecated 使用模板系统替代：通过 getActiveDimensions(entry) 获取条目对应模板的维度。
 *             此常量仅作为默认模板的维度集保留，不应用于业务逻辑。
 */
export const DEFAULT_DIMENSIONS: Dimension[] = [
  { key: 'overall', label: '总评', description: '由各维度加权计算得出', weight: 0 },
  { key: 'audio', label: '音声', description: 'OP/ED/BGM/声优表现', weight: 0.12 },
  { key: 'production', label: '制作', description: '分镜、演出、张数、运镜、特效、摄影', weight: 0.15 },
  { key: 'animation', label: '作画', description: '画面质感、构图、色彩与光影', weight: 0.13 },
  { key: 'immersion', label: '沉浸', description: '音乐、画面、分镜、剧情协同度', weight: 0.15 },
  { key: 'plot', label: '剧情', description: '作品的灵魂', weight: 0.20 },
  { key: 'character', label: '人设', description: '角色设计', weight: 0.10 },
  { key: 'depth', label: '深度', description: '思想深度', weight: 0.10 },
  { key: 'vibe', label: '电波', description: '个人主观综合', weight: 0.05 },
];

/** 维度标签映射 */
export const DIMENSION_LABEL_MAP: Record<string, string> = {};
DEFAULT_DIMENSIONS.forEach((d) => { DIMENSION_LABEL_MAP[d.key] = d.label; });
