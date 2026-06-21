/**
 * features/knowledge-graph 集成测试
 */
import { describe, it, expect } from 'vitest';
import { buildGraph, filterGraph, hasEnoughData } from '../../../features/knowledge-graph/graph-engine';
import type { AnimeEntry } from '../../../src/types';
import type { GraphEdgeRelation } from '../../../features/knowledge-graph/graph-types';

/** 创建简单测试番剧 */
function makeAnime(id: string, opts?: {
  studio?: string;
  tags?: string[];
  characters?: string[];
  category?: string;
  scores?: Record<string, number>;
}): AnimeEntry {
  return {
    id,
    title: `Anime ${id}`,
    posterUrl: '',
    category: opts?.category as AnimeEntry['category'] || 'watched',
    tags: (opts?.tags || []).map((name) => ({ name, highlighted: false })),
    studio: opts?.studio,
    characters: opts?.characters,
    scores: Object.entries(opts?.scores || {}).map(([k, v]) => ({ dimensionKey: k, score: v })),
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
  };
}

describe('hasEnoughData', () => {
  it('少于3部番剧返回 false', () => {
    expect(hasEnoughData([makeAnime('1')])).toBe(false);
    expect(hasEnoughData([makeAnime('1'), makeAnime('2')])).toBe(false);
  });

  it('3部及以上返回 true', () => {
    expect(hasEnoughData([
      makeAnime('1'), makeAnime('2'), makeAnime('3'),
    ])).toBe(true);
  });
});

describe('buildGraph', () => {
  it('空列表返回空图', () => {
    const graph = buildGraph([]);
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
  });

  it('单个番剧创建番剧节点但无边', () => {
    const graph = buildGraph([makeAnime('1')]);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].nodeType).toBe('anime');
    expect(graph.edges).toEqual([]);
  });

  it('相同制作公司的番剧间创建 same_studio 边', () => {
    const list = [
      makeAnime('1', { studio: 'A-1 Pictures' }),
      makeAnime('2', { studio: 'A-1 Pictures' }),
    ];
    const graph = buildGraph(list);
    const studioEdges = graph.edges.filter((e) => e.relation === 'same_studio');
    expect(studioEdges.length).toBeGreaterThan(0);
    // 制作公司节点出现 ≥2次才创建
    const studioNodes = graph.nodes.filter((n) => n.nodeType === 'studio');
    expect(studioNodes).toHaveLength(1);
  });

  it('共享标签的番剧间创建 shared_tags 边', () => {
    const list = [
      makeAnime('1', { tags: ['科幻', '战争'] }),
      makeAnime('2', { tags: ['科幻', '日常'] }),
      makeAnime('3', { tags: ['战争'] }),
    ];
    const graph = buildGraph(list);
    // 番剧1和2共享"科幻"，Jaccard=1/3≥0.25
    const sharedEdges = graph.edges.filter((e) => e.relation === 'shared_tags');
    expect(sharedEdges.length).toBeGreaterThan(0);
  });

  it('单次出现的实体不创建节点', () => {
    const list = [
      makeAnime('1', { studio: 'Unique Studio' }),
      makeAnime('2', { studio: 'Another Studio' }),
    ];
    const graph = buildGraph(list);
    // 每个studio只出现1次，不创建studio节点
    const studioNodes = graph.nodes.filter((n) => n.nodeType === 'studio');
    expect(studioNodes).toHaveLength(0);
  });

  it('角色节点正确创建', () => {
    const list = [
      makeAnime('1', { characters: ['艾伦', '三笠'] }),
      makeAnime('2', { characters: ['艾伦', '阿尔敏'] }),
    ];
    const graph = buildGraph(list);
    // "艾伦"出现2次，应创建节点
    const charNodes = graph.nodes.filter((n) => n.nodeType === 'character');
    expect(charNodes.length).toBeGreaterThanOrEqual(1);
    const allenNode = charNodes.find((n) => n.id === 'character:艾伦');
    expect(allenNode).toBeDefined();
  });
});

describe('filterGraph', () => {
  it('过滤后保留番剧节点和已连接的非番剧节点', () => {
    const list = [
      makeAnime('1', { studio: 'Kyoto Animation', tags: ['日常'] }),
      makeAnime('2', { studio: 'Kyoto Animation', tags: ['音乐'] }),
    ];
    const full = buildGraph(list);
    // 只保留 studio 关系
    const visible = new Set<GraphEdgeRelation>(['studio', 'same_studio']);
    const filtered = filterGraph(full, visible);

    // 番剧节点始终保留
    const animeNodes = filtered.nodes.filter((n) => n.nodeType === 'anime');
    expect(animeNodes).toHaveLength(2);

    // studio 节点保留（有 studio 边连接）
    const studioNodes = filtered.nodes.filter((n) => n.nodeType === 'studio');
    expect(studioNodes.length).toBeGreaterThan(0);

    // tag 节点被过滤掉（没有可见的 tag 边）
    const tagNodes = filtered.nodes.filter((n) => n.nodeType === 'tag');
    expect(tagNodes).toHaveLength(0);
  });
});
