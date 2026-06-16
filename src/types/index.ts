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
  scores: DimensionScore[];
  releaseDate?: string;
  bangumiScore?: number;
  characters?: string[];
  episodes?: number;
  /** 制作组/动画公司 */
  studio?: string;
  /** 总张数（中割统计） */
  frameCount?: number;
  /** 全局评价 */
  review?: string;
  /** 备注 */
  notes?: string;
  /** 维度专项评价 */
  dimensionReviews?: DimensionReview[];
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
  wantToWatch: { label: '想看', color: '#00a1d6' },
  onHold: { label: '搁置', color: '#ffb347' },
  watched: { label: '看过', color: '#52c41a' },
  dropped: { label: '抛弃', color: '#8b949e' },
};

/** 默认评分维度 */
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
