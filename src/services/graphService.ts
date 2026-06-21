/**
 * 知识图谱构建引擎
 *   从番剧列表中抽取实体和关系，构建力导向图数据
 *   所有计算均为纯函数，在 useMemo 中调用
 */
import type { AnimeEntry } from '../types';
import type {
  GraphData,
  GraphNodeDef,
  GraphEdgeDef,
  GraphEdgeRelation,
} from '../types/graph';
import { CATEGORY_TO_INDEX } from '../types/graph';

// ── 工具函数 ──

/** 字符串哈希 → 0-360 的色相值（同一名称始终同色） */
function nameToHue(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

/** HSL → HEX（s/l 为 0-100 的百分比） */
function hslToHex(h: number, s: number, l: number): string {
  const sNorm = s / 100;
  const lNorm = l / 100;
  const a = sNorm * Math.min(lNorm, 1 - lNorm);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return lNorm - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
  };
  const r = Math.round(f(0) * 255);
  const g = Math.round(f(8) * 255);
  const b = Math.round(f(4) * 255);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

/** HEX → { h, s, l }（用于颜色混合） */
function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return { h: h * 360, s: s * 100, l: l * 100 };
}

/** 混合多个 HSL 颜色，取平均色相（环形均值）和平均饱和/亮度 */
function mixHslColors(colors: { h: number; s: number; l: number }[]): { h: number; s: number; l: number } {
  if (colors.length === 0) return { h: 0, s: 0, l: 45 };
  // 色相用环形均值（sin/cos 平均）
  let sinSum = 0, cosSum = 0, sSum = 0, lSum = 0;
  for (const c of colors) {
    const rad = (c.h * Math.PI) / 180;
    sinSum += Math.sin(rad);
    cosSum += Math.cos(rad);
    sSum += c.s;
    lSum += c.l;
  }
  const avgH = ((Math.atan2(sinSum / colors.length, cosSum / colors.length) * 180) / Math.PI + 360) % 360;
  return {
    h: avgH,
    s: sSum / colors.length,
    l: lSum / colors.length,
  };
}

/** 计算两个向量的余弦相似度 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** 计算两个标签集合的 Jaccard 相似度 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** 安全截断字符串（用于节点标签） */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '…';
}

// ── 核心构建函数 ──

/**
 * 从番剧列表构建完整的知识图谱数据
 * @param animeList 番剧列表
 * @returns 图节点和边的集合
 */
export function buildGraph(animeList: AnimeEntry[]): GraphData {
  const nodes: GraphNodeDef[] = [];
  const edges: GraphEdgeDef[] = [];

  if (animeList.length === 0) return { nodes, edges };

  // ── Step 1: 聚合实体节点 ──
  const studioCount = new Map<string, number>();
  const tagCount = new Map<string, number>();
  const charCount = new Map<string, number>();

  for (const anime of animeList) {
    if (anime.studio) {
      const s = anime.studio.trim();
      if (s) studioCount.set(s, (studioCount.get(s) || 0) + 1);
    }
    for (const tag of anime.tags) {
      const name = tag.name.trim();
      if (name) tagCount.set(name, (tagCount.get(name) || 0) + 1);
    }
    if (anime.characters) {
      for (const ch of anime.characters) {
        const name = ch.trim();
        if (name) charCount.set(name, (charCount.get(name) || 0) + 1);
      }
    }
  }

  // 创建番剧节点
  const animeNodeIds = new Set<string>();
  for (const anime of animeList) {
    const nodeId = `anime:${anime.id}`;
    animeNodeIds.add(nodeId);
    nodes.push({
      id: nodeId,
      name: truncate(anime.title, 12),
      nodeType: 'anime',
      category: CATEGORY_TO_INDEX[anime.category] ?? 1,
      animeId: anime.id,
      animeCategory: anime.category,
      symbolSize: 30,
    });
  }

  // 创建制作公司节点（出现 ≥2 次，颜色基于名称哈希）
  const studioNodeIds = new Set<string>();
  for (const [name, count] of studioCount) {
    if (count >= 2) {
      const nodeId = `studio:${name}`;
      studioNodeIds.add(nodeId);
      nodes.push({
        id: nodeId,
        name: truncate(name, 16),
        nodeType: 'studio',
        category: 5,
        symbolSize: 18,
        itemStyle: { color: hslToHex(nameToHue(name), 55, 55) },
      });
    }
  }

  // 创建标签节点（出现 ≥2 次，最多 40 个，颜色基于名称哈希）
  const sortedTags = [...tagCount.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40);
  const tagNodeIds = new Set<string>();
  for (const [name] of sortedTags) {
    const nodeId = `tag:${name}`;
    tagNodeIds.add(nodeId);
    nodes.push({
      id: nodeId,
      name: truncate(name, 10),
      nodeType: 'tag',
      category: 6,
      symbolSize: 14,
      itemStyle: { color: hslToHex(nameToHue(name), 60, 55) },
    });
  }

  // 创建角色节点（出现 ≥2 次，最多 30 个，颜色基于名称哈希）
  const sortedChars = [...charCount.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30);
  const charNodeIds = new Set<string>();
  for (const [name] of sortedChars) {
    const nodeId = `character:${name}`;
    charNodeIds.add(nodeId);
    nodes.push({
      id: nodeId,
      name: truncate(name, 10),
      nodeType: 'character',
      category: 7,
      symbolSize: 14,
      itemStyle: { color: hslToHex(nameToHue(name), 50, 55) },
    });
  }

  // ── Step 2: 生成 anime-to-entity 边 ──
  for (const anime of animeList) {
    const animeNodeId = `anime:${anime.id}`;

    // anime → studio
    if (anime.studio) {
      const studioId = `studio:${anime.studio.trim()}`;
      if (studioNodeIds.has(studioId)) {
        edges.push({
          source: animeNodeId,
          target: studioId,
          relation: 'studio',
        });
      }
    }

    // anime → tag
    for (const tag of anime.tags) {
      const tagId = `tag:${tag.name.trim()}`;
      if (tagNodeIds.has(tagId)) {
        edges.push({
          source: animeNodeId,
          target: tagId,
          relation: 'tag',
        });
      }
    }

    // anime → character
    if (anime.characters) {
      for (const ch of anime.characters) {
        const charId = `character:${ch.trim()}`;
        if (charNodeIds.has(charId)) {
          edges.push({
            source: animeNodeId,
            target: charId,
            relation: 'character',
          });
        }
      }
    }
  }

  // ── Step 3: 生成番剧间连线 ──
  generateAnimeAnimeEdges(animeList, edges);

  // ── 后处理：大小 → 颜色 ──
  applyNodeSizingByDegree(nodes, edges);
  applyColorPropagation(nodes, edges);

  return { nodes, edges };
}

/** 番剧默认灰（无连接时显示） */
const ANIME_GREY = '#6e7681';
/** 实体颜色对番剧的影响力：0=永远灰, 1=完全被实体颜色覆盖 */
const COLOR_PROPAGATION_STRENGTH = 0.65;

/**
 * 颜色传播：番剧节点吸收所连接实体节点的颜色
 *   番剧默认灰，连接实体越多越趋近实体颜色的混合
 *   无连接的番剧保持灰色
 */
export function applyColorPropagation(
  nodes: GraphNodeDef[],
  edges: GraphEdgeDef[],
): void {
  // 建立邻接映射：节点 → 相连的实体节点
  const adjacency = new Map<string, GraphNodeDef[]>();
  const nodeMap = new Map<string, GraphNodeDef>();
  for (const n of nodes) {
    nodeMap.set(n.id, n);
    adjacency.set(n.id, []);
  }
  for (const e of edges) {
    const src = nodeMap.get(e.source);
    const tgt = nodeMap.get(e.target);
    if (!src || !tgt) continue;
    // 只收集实体节点（非 anime）
    if (src.nodeType !== 'anime') adjacency.get(e.target)?.push(src);
    if (tgt.nodeType !== 'anime') adjacency.get(e.source)?.push(tgt);
  }

  // 对每个番剧节点计算混合色
  for (const n of nodes) {
    if (n.nodeType !== 'anime') continue;
    const neighbors = adjacency.get(n.id) || [];

    if (neighbors.length === 0) {
      n.itemStyle = { color: ANIME_GREY };
      continue;
    }

    // 收集邻居的 HSL
    const hslColors = neighbors
      .map((nb) => nb.itemStyle?.color)
      .filter((c): c is string => !!c && c.startsWith('#'))
      .map((c) => hexToHsl(c));

    if (hslColors.length === 0) {
      n.itemStyle = { color: ANIME_GREY };
      continue;
    }

    // 混合邻居颜色
    const mixed = mixHslColors(hslColors);
    // 番剧色 = 灰色 + 实体混合色 * 传播强度
    const greyHsl = hexToHsl(ANIME_GREY);
    const finalH = mixed.h;
    const finalS = greyHsl.s + (mixed.s - greyHsl.s) * COLOR_PROPAGATION_STRENGTH;
    const finalL = greyHsl.l + (mixed.l - greyHsl.l) * COLOR_PROPAGATION_STRENGTH;

    n.itemStyle = { color: hslToHex(finalH, finalS, finalL) };
  }
}

/** 节点尺寸范围：按类型区分，[最小, 最大, 默认(度数相同时)] */
const SIZE_RANGE: Record<string, [number, number, number]> = {
  anime: [12, 32, 20],
  studio: [14, 34, 18],
  tag: [10, 48, 14],
  character: [10, 18, 14],
};

/**
 * 根据度数（连接边数）调整所有节点的 symbolSize
 *   连线越多 → 节点越大 → 视觉上更显眼
 */
function applyNodeSizingByDegree(
  nodes: GraphNodeDef[],
  edges: GraphEdgeDef[],
): void {
  // 统计所有节点的度数
  const degreeMap = new Map<string, number>();
  for (const n of nodes) {
    degreeMap.set(n.id, 0);
  }
  for (const e of edges) {
    degreeMap.set(e.source, (degreeMap.get(e.source) || 0) + 1);
    degreeMap.set(e.target, (degreeMap.get(e.target) || 0) + 1);
  }

  // 按节点类型分组，各自独立映射大小
  const groups = new Map<string, GraphNodeDef[]>();
  for (const n of nodes) {
    if (!groups.has(n.nodeType)) groups.set(n.nodeType, []);
    groups.get(n.nodeType)!.push(n);
  }

  for (const [nodeType, group] of groups) {
    const range = SIZE_RANGE[nodeType];
    if (!range || group.length === 0) continue;

    const degrees = group.map((n) => degreeMap.get(n.id) || 0);
    const minDeg = Math.min(...degrees);
    const maxDeg = Math.max(...degrees);

    // 所有度数相同 → 使用默认尺寸
    if (maxDeg === minDeg) {
      for (const n of group) n.symbolSize = range[2];
      continue;
    }

    // 线性映射：度数 → [minSize, maxSize]
    const [minSize, maxSize] = range;
    for (const n of group) {
      const deg = degreeMap.get(n.id) || 0;
      const t = (deg - minDeg) / (maxDeg - minDeg);
      n.symbolSize = Math.round(minSize + t * (maxSize - minSize));
    }
  }
}

/**
 * 生成番剧间连线（同制作公司、共享标签、评分相似）
 *   与番剧网络 KnowledgeGraphModal 的连接方式一致
 */
function generateAnimeAnimeEdges(
  animeList: AnimeEntry[],
  edges: GraphEdgeDef[],
): void {
  if (animeList.length < 2) return;

  // ── same_studio：同制作公司 ──
  const studioGroups = new Map<string, string[]>();
  for (const a of animeList) {
    if (a.studio) {
      const s = a.studio.trim();
      if (s) {
        if (!studioGroups.has(s)) studioGroups.set(s, []);
        studioGroups.get(s)!.push(a.id);
      }
    }
  }
  for (const [, ids] of studioGroups) {
    if (ids.length < 2) continue;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        edges.push({
          source: `anime:${ids[i]}`,
          target: `anime:${ids[j]}`,
          relation: 'same_studio',
        });
      }
    }
  }

  // ── shared_tags：共享标签 Jaccard ≥ 0.25 ──
  const tagSets = animeList.map((a) => new Set(a.tags.map((t) => t.name.trim()).filter(Boolean)));
  for (let i = 0; i < animeList.length; i++) {
    for (let j = i + 1; j < animeList.length; j++) {
      const sim = jaccardSimilarity(tagSets[i], tagSets[j]);
      if (sim >= 0.25) {
        edges.push({
          source: `anime:${animeList[i].id}`,
          target: `anime:${animeList[j].id}`,
          relation: 'shared_tags',
          weight: sim,
        });
      }
    }
  }

  // ── similar_scores：评分向量余弦相似 top-3/番剧 ──
  const scoreVecs = animeList.map((a) => [
    (a.bangumiScore ?? 0) / 10,
    (a.aniListScore ?? 0) / 100,
  ]);
  const TOP_N = 3;
  for (let i = 0; i < animeList.length; i++) {
    const sims: { j: number; sim: number }[] = [];
    for (let j = 0; j < animeList.length; j++) {
      if (i === j) continue;
      const sim = cosineSimilarity(scoreVecs[i], scoreVecs[j]);
      if (sim > 0.7) sims.push({ j, sim });
    }
    sims.sort((a, b) => b.sim - a.sim);
    for (let k = 0; k < Math.min(TOP_N, sims.length); k++) {
      const j = sims[k].j;
      if (i < j) {
        edges.push({
          source: `anime:${animeList[i].id}`,
          target: `anime:${animeList[j].id}`,
          relation: 'similar_scores',
          weight: sims[k].sim,
        });
      }
    }
  }
}

/**
 * 按关系类型过滤边，并移除孤立的非番剧节点
 * @param data 完整图数据
 * @param visibleRelations 可见关系类型集合
 * @returns 过滤后的 { nodes, edges }
 */
export function filterGraph(
  data: GraphData,
  visibleRelations: Set<GraphEdgeRelation>,
): { nodes: GraphNodeDef[]; edges: GraphEdgeDef[] } {
  const filteredEdges = data.edges.filter((e) => visibleRelations.has(e.relation));

  // 找出在过滤后边中出现的所有节点 ID
  const connectedIds = new Set<string>();
  for (const e of filteredEdges) {
    connectedIds.add(e.source);
    connectedIds.add(e.target);
  }

  // 保留番剧节点（即使孤立也显示）+ 非番剧节点仅在有边时保留
  const filteredNodes = data.nodes.filter(
    (n) => n.nodeType === 'anime' || connectedIds.has(n.id),
  );

  // 根据过滤后的度数重新调整大小和颜色
  applyNodeSizingByDegree(filteredNodes, filteredEdges);
  applyColorPropagation(filteredNodes, filteredEdges);

  return { nodes: filteredNodes, edges: filteredEdges };
}

/**
 * 检查是否有足够的数据来构建有意义的图谱
 */
export function hasEnoughData(animeList: AnimeEntry[]): boolean {
  return animeList.length >= 3;
}
