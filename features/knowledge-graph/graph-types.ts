/**
 * 知识图谱类型定义
 *   图节点、边、ECharts 配置映射
 */
import type { AnimeCategory } from '../../src/types';

// ── 节点类型 ──

/** 图节点实体类型 */
export type GraphNodeType = 'anime' | 'studio' | 'tag' | 'character';

/** 图边关系类型 */
export type GraphEdgeRelation =
  | 'studio'       // anime → 制作公司
  | 'tag'          // anime → 标签
  | 'character'    // anime → 角色
  | 'same_studio'  // 同制作公司
  | 'shared_tags'  // 共享标签（Jaccard ≥ 0.25）
  | 'similar_scores'; // 评分向量余弦相似 top-3

// ── 内部构建用类型 ──

/** 图节点定义（构建过程中使用） */
export interface GraphNodeDef {
  id: string;
  name: string;
  nodeType: GraphNodeType;
  /** ECharts categories 数组索引 */
  category: number;
  /** 仅 anime 类型，指向原始 AnimeEntry.id */
  animeId?: string;
  /** 仅 anime 类型 */
  animeCategory?: AnimeCategory;
  symbolSize: number;
  itemStyle?: { color?: string };
}

/** 图边定义 */
export interface GraphEdgeDef {
  source: string;
  target: string;
  relation: GraphEdgeRelation;
  /** 余弦相似度等权重值，用于线条粗细 */
  weight?: number;
}

/** 图构建结果 */
export interface GraphData {
  nodes: GraphNodeDef[];
  edges: GraphEdgeDef[];
}

// ── ECharts 序列化类型 ──

/** ECharts graph 系列的节点数据 */
export interface EChartsGraphNode {
  id: string;
  name: string;
  category: number;
  symbolSize: number;
  animeId?: string;
  /** 固定位置，不受力导向影响 */
  fixed?: boolean;
  /** 是否可拖拽 */
  draggable?: boolean;
  itemStyle?: { color?: string; opacity?: number };
  label?: { show?: boolean };
}

/** ECharts graph 系列的边数据 */
export interface EChartsGraphLink {
  source: string;
  target: string;
  relation: GraphEdgeRelation;
  lineStyle?: {
    color?: string;
    width?: number;
    curveness?: number;
    opacity?: number;
  };
}

// ── ECharts 类别常量（索引与 category 字段对应）──

export const GRAPH_CATEGORIES = [
  { name: '在看', itemStyle: { color: '#fb7299' } },
  { name: '看过', itemStyle: { color: '#52c41a' } },
  { name: '想看', itemStyle: { color: '#00a1d6' } },
  { name: '搁置', itemStyle: { color: '#ffb347' } },
  { name: '抛弃', itemStyle: { color: '#8b949e' } },
  { name: '制作公司', itemStyle: { color: '#a371f7' } },
  { name: '标签', itemStyle: { color: '#2eaadc' } },
  { name: '角色', itemStyle: { color: '#d69d4a' } },
];

/** 番剧分类 → 类别索引 */
export const CATEGORY_TO_INDEX: Record<AnimeCategory, number> = {
  watching: 0,
  watched: 1,
  wantToWatch: 2,
  onHold: 3,
  dropped: 4,
};

// ── 关系类型颜色 ──

export const RELATION_COLORS: Record<GraphEdgeRelation, string> = {
  studio: '#5688c7',
  tag: '#2eaadc',
  character: '#d69d4a',
  same_studio: '#a371f7',
  shared_tags: '#3fb950',
  similar_scores: '#fb7299',
};

/** 关系类型的中文标签 */
export const RELATION_LABELS: Record<GraphEdgeRelation, string> = {
  studio: '制作公司',
  tag: '标签',
  character: '角色',
  same_studio: '同制作公司',
  shared_tags: '共享标签',
  similar_scores: '评分相似',
};
