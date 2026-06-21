/**
 * 知识图谱全屏 Modal
 *   ECharts 力导向图，支持筛选、搜索、点击查看详情
 */
import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { Modal, Checkbox, Input, Button, Tag as AntTag, Empty } from 'antd';
import { SearchOutlined, InfoCircleOutlined } from '@ant-design/icons';
import ReactEChartsCore from 'echarts-for-react/lib/core';
import * as echarts from 'echarts/core';
import { GraphChart } from 'echarts/charts';
import {
  TooltipComponent,
  LegendComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { AnimeEntry } from '../../src/types';
import { CATEGORY_CONFIG } from '../../src/types';
import type {
  GraphEdgeRelation,
  EChartsGraphNode,
  EChartsGraphLink,
} from './graph-types';
import {
  GRAPH_CATEGORIES,
  RELATION_COLORS,
  RELATION_LABELS,
  CATEGORY_TO_INDEX,
} from './graph-types';
import { buildGraph, filterGraph, hasEnoughData } from './graph-engine';

// 注册 ECharts 必要组件
echarts.use([GraphChart, TooltipComponent, LegendComponent, CanvasRenderer]);

// ── 所有可选的关系类型 ──
const ALL_RELATIONS: GraphEdgeRelation[] = ['studio', 'tag', 'character'];

// ── 实体关系类型 ──
const ENTITY_RELATIONS: GraphEdgeRelation[] = ['studio', 'tag', 'character'];

interface KnowledgeGraphModalProps {
  open: boolean;
  onClose: () => void;
  animeList: AnimeEntry[];
  onAnimeClick: (anime: AnimeEntry) => void;
  /** 长按拖拽番剧到实体节点后的回调 */
  onCreateRelation?: (animeId: string, targetType: 'tag' | 'studio' | 'character', targetName: string) => void;
}

const KnowledgeGraphModal: React.FC<KnowledgeGraphModalProps> = ({
  open,
  onClose,
  animeList,
  onAnimeClick,
  onCreateRelation,
}) => {
  // —— 筛选状态 ——
  const [visibleRelations, setVisibleRelations] = useState<Set<GraphEdgeRelation>>(
    () => new Set(ALL_RELATIONS),
  );
  const [searchKeyword, setSearchKeyword] = useState('');
  const [selectedAnimeId, setSelectedAnimeId] = useState<string | null>(null);
  const chartRef = useRef<ReactEChartsCore>(null);

  // ── 连线模式状态（开关式，避免与 ECharts 拖拽冲突）──
  const [linkingMode, setLinkingMode] = useState(false);
  const [linkSource, setLinkSource] = useState<{ id: string; name: string } | null>(null);
  const [linkConfirmOpen, setLinkConfirmOpen] = useState(false);
  const [linkTarget, setLinkTarget] = useState<{ type: 'tag' | 'studio' | 'character'; name: string } | null>(null);
  const [linkHoverTarget, setLinkHoverTarget] = useState<{ type: 'tag' | 'studio' | 'character'; name: string } | null>(null);
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const linkSourcePosRef = useRef<{ x: number; y: number } | null>(null);
  const linkTargetPosRef = useRef<{ x: number; y: number } | null>(null);
  const mousePosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const entityPositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const rafRef = useRef<number>(0);

  // 退出连线模式（保留开关，只清除源和目标）
  const cancelLinking = useCallback(() => {
    setLinkSource(null);
    setLinkHoverTarget(null);
    linkSourcePosRef.current = null;
    linkTargetPosRef.current = null;
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
  }, []);

  // ── 连线模式：有源节点时启动 RAF 高亮循环 + 磁吸效果 ──
  useEffect(() => {
    if (!linkingMode || !linkSource) {
      // 清除残留的 RAF
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
      return;
    }
    const ec = chartRef.current?.getEchartsInstance();
    if (!ec) return;

    // 从 ECharts 内部获取所有实体节点的像素位置
    const updateEntityPositions = () => {
      try {
        const model = (ec as any).getModel?.() || (ec as any)._model;
        const series = model?.getSeriesByIndex?.(0);
        const graph = series?.getGraph?.();
        if (!graph) return;
        const map = new Map<string, { x: number; y: number }>();
        graph.eachNode((node: any) => {
          const id: string = node.id || '';
          if (id.startsWith('anime:')) return;
          const layout = node.getLayout();
          if (layout) {
            const pos = ec.convertToPixel({ seriesIndex: 0 }, [layout.x, layout.y]);
            map.set(id, { x: pos[0], y: pos[1] });
          }
        });
        entityPositionsRef.current = map;
      } catch { /* ignore */ }
    };

    // 高亮/取消高亮实体节点
    let lastHoveredNodeId: string | null = null;
    const highlightNode = (nodeId: string | null) => {
      if (lastHoveredNodeId === nodeId) return;
      if (lastHoveredNodeId) {
        try { ec.dispatchAction({ type: 'downplay', seriesIndex: 0, name: lastHoveredNodeId }); } catch { /* ignore */ }
      }
      if (nodeId) {
        try { ec.dispatchAction({ type: 'highlight', seriesIndex: 0, name: nodeId }); } catch { /* ignore */ }
      }
      lastHoveredNodeId = nodeId;
    };

    // RAF 循环：检测最近实体节点 + 更新磁吸位置
    const DISTANCE_THRESHOLD = 50;
    const tick = () => {
      updateEntityPositions(); // 每帧更新位置（力导向可能会微调）
      const mouse = mousePosRef.current;
      let bestDist = DISTANCE_THRESHOLD;
      let bestTarget: { type: 'tag' | 'studio' | 'character'; name: string; pos: { x: number; y: number }; nodeId: string } | null = null;

      for (const [nodeId, pos] of entityPositionsRef.current) {
        const dx = mouse.x - pos.x;
        const dy = mouse.y - pos.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < bestDist) {
          const match = nodeId.match(/^(tag|studio|character):(.+)$/);
          if (match) {
            bestDist = dist;
            bestTarget = { type: match[1] as 'tag' | 'studio' | 'character', name: match[2], pos, nodeId };
          }
        }
      }

      if (bestTarget) {
        setLinkHoverTarget({ type: bestTarget.type, name: bestTarget.name });
        linkTargetPosRef.current = bestTarget.pos;
        highlightNode(bestTarget.nodeId);
      } else {
        setLinkHoverTarget(null);
        linkTargetPosRef.current = null;
        highlightNode(null);
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    updateEntityPositions();
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      highlightNode(null);
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
    };
  }, [linkingMode, linkSource]);

  // Modal 打开/关闭时 resize 图表
  useEffect(() => {
    if (open) {
      const timer = setTimeout(() => {
        chartRef.current?.getEchartsInstance()?.resize();
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [open]);

  // —— 切换关系类型 ——
  const toggleRelation = useCallback((rel: GraphEdgeRelation) => {
    setVisibleRelations((prev) => {
      const next = new Set(prev);
      if (next.has(rel)) next.delete(rel);
      else next.add(rel);
      return next;
    });
  }, []);

  // —— 构建和过滤图数据 ——
  const fullGraph = useMemo(() => {
    if (!hasEnoughData(animeList)) return null;
    return buildGraph(animeList);
  }, [animeList]);

  const filteredGraph = useMemo(() => {
    if (!fullGraph) return null;
    return filterGraph(fullGraph, visibleRelations);
  }, [fullGraph, visibleRelations]);

  const selectedAnime = useMemo(() => {
    if (!selectedAnimeId) return null;
    return animeList.find((a) => a.id === selectedAnimeId) || null;
  }, [selectedAnimeId, animeList]);

  // —— 搜索：高亮匹配节点 ——
  const searchFiltered = useMemo(() => {
    if (!filteredGraph) return null;
    if (!searchKeyword.trim()) return filteredGraph;

    const kw = searchKeyword.trim().toLowerCase();
    const matchingIds = new Set(
      filteredGraph.nodes
        .filter((n) => n.name.toLowerCase().includes(kw))
        .map((n) => n.id),
    );

    return {
      ...filteredGraph,
      nodes: filteredGraph.nodes.map((n) => ({
        ...n,
        itemStyle: {
          ...n.itemStyle,
          opacity: matchingIds.size === 0 || matchingIds.has(n.id) ? 1 : 0.12,
        },
      })),
    };
  }, [filteredGraph, searchKeyword]);

  // —— 构建 ECharts 配置 ——
  const option = useMemo(() => {
    if (!searchFiltered || searchFiltered.nodes.length === 0) {
      return {}; // 空配置
    }

    // 转换为 ECharts 数据（实体节点不可拖拽；连线模式下全部不可拖拽）
    const graphNodes: EChartsGraphNode[] = searchFiltered.nodes.map((n) => {
      const isEntity = !n.animeId;
      return {
        id: n.id,
        name: n.name,
        category: n.category,
        symbolSize: n.symbolSize,
        animeId: n.animeId,
        draggable: linkingMode ? false : !isEntity,
        itemStyle: n.itemStyle,
      };
    });

    const graphLinks: EChartsGraphLink[] = searchFiltered.edges.map((e) => ({
      source: e.source,
      target: e.target,
      relation: e.relation,
      lineStyle: {
        color: RELATION_COLORS[e.relation] || '#484f58',
        width: e.relation === 'similar_scores' ? (0.5 + (e.weight || 0) * 2) : 0.5,
        curveness: e.relation === 'similar_scores' ? 0.3 : 0.1,
        opacity: 0.5,
      },
    }));

    return {
      backgroundColor: 'transparent',
      animationDurationUpdate: 300,
      animationEasingUpdate: 'quinticInOut',
      tooltip: {
        trigger: 'item',
        backgroundColor: '#1c2128',
        borderColor: '#30363d',
        textStyle: { color: '#e6edf3', fontSize: 12 },
        formatter: (params: { dataType?: string; name?: string; data?: EChartsGraphNode & { source?: string; target?: string; relation?: GraphEdgeRelation } }) => {
          if (params.dataType === 'node' && params.data) {
            const catName = GRAPH_CATEGORIES[params.data.category]?.name || '';
            const name = params.name || params.data.name || '';
            return `${name}<br/>类型: ${catName}`;
          }
          if (params.dataType === 'edge' && params.data) {
            const src = params.data.source || '';
            const tgt = params.data.target || '';
            const rel = RELATION_LABELS[params.data.relation as GraphEdgeRelation] || params.data.relation || '';
            return `${src} → ${tgt}<br/>${rel}`;
          }
          return '';
        },
      },
      series: [
        {
          type: 'graph',
          layout: 'force',
          roam: true,
          draggable: true,
          scaleLimit: { min: 0.3, max: 5 },
          zoom: 1.2,
          force: {
            repulsion: [200, 600],
            gravity: 0.08,
            edgeLength: [80, 300],
            layoutAnimation: true,
            friction: 0.6,
          },
          data: graphNodes,
          links: graphLinks,
          categories: GRAPH_CATEGORIES,
          itemStyle: {
            borderColor: '#30363d',
            borderWidth: 1,
          },
          label: {
            show: true,
            position: 'right',
            fontSize: 11,
            color: '#c9d1d9',
            formatter: (p: { data?: EChartsGraphNode }) => {
              if (!p.data) return '';
              // 番剧节点显示名称，非番剧节点在缩放够大时显示
              const name = p.data.name || '';
              if (p.data.animeId) {
                return name.length > 6 ? name.slice(0, 6) + '…' : name;
              }
              return name;
            },
          },
          lineStyle: {
            color: '#484f58',
            curveness: 0.2,
            opacity: 0.4,
          },
          emphasis: {
            focus: 'adjacency',
            blurScope: 'global',
            lineStyle: { width: 2, opacity: 0.9 },
            itemStyle: { borderColor: '#fff', borderWidth: 2 },
          },
        },
      ],
    };
  }, [searchFiltered, linkingMode]);

  // —— 图事件处理 ——
  // 点击：连线模式下选源/选目标，普通模式下查看详情
  const onChartClick = useCallback(
    (params: { dataType?: string; data?: EChartsGraphNode; event?: { event?: MouseEvent } }) => {
      if (linkingMode) {
        // 连线模式：点击番剧 → 设为源；点击实体 → 确认连接
        if (params.dataType === 'node' && params.data?.animeId) {
          // 记录源节点像素位置
          const evt = params.event?.event;
          if (chartContainerRef.current && evt) {
            const rect = chartContainerRef.current.getBoundingClientRect();
            linkSourcePosRef.current = {
              x: evt.clientX - rect.left,
              y: evt.clientY - rect.top,
            };
          }
          setLinkSource({ id: params.data.animeId, name: params.data.name || '' });
          setLinkHoverTarget(null);
          setSelectedAnimeId(null);
          return;
        }
        if (params.dataType === 'node' && params.data?.id && linkSource) {
          const nodeId: string = params.data.id;
          const match = nodeId.match(/^(tag|studio|character):(.+)$/);
          if (match) {
            setLinkTarget({ type: match[1] as 'tag' | 'studio' | 'character', name: match[2] });
            setLinkConfirmOpen(true);
            // 不在这里 cancelLinking —— 确认/取消时再清
            return;
          }
        }
        // 点击空白：取消当前源选择
        if (!params.dataType && linkSource) {
          cancelLinking();
        }
        return;
      }
      // 普通模式：选中番剧查看详情
      if (params.dataType === 'node' && params.data?.animeId) {
        setSelectedAnimeId(params.data.animeId);
      } else {
        setSelectedAnimeId(null);
      }
    },
    [linkingMode, linkSource, cancelLinking],
  );

  const onChartDblClick = useCallback(() => {
    const instance = chartRef.current?.getEchartsInstance();
    if (instance) {
      instance.dispatchAction({ type: 'restore' });
    }
  }, []);

  // 鼠标移动：更新坐标用于 SVG 线和 RAF 磁吸
  const onChartMouseMove = useCallback(
    (params: { event?: { event?: MouseEvent } }) => {
      const evt = params.event?.event;
      if (evt && chartContainerRef.current) {
        const rect = chartContainerRef.current.getBoundingClientRect();
        mousePosRef.current = {
          x: evt.clientX - rect.left,
          y: evt.clientY - rect.top,
        };
      }
    },
    [],
  );

  // 确认建立关系（直接确认，无需输入）
  const confirmCreateRelation = useCallback(() => {
    if (!linkSource || !linkTarget) return;
    onCreateRelation?.(linkSource.id, linkTarget.type, linkTarget.name);
    setLinkConfirmOpen(false);
    setLinkTarget(null);
    cancelLinking();
  }, [linkSource, linkTarget, onCreateRelation, cancelLinking]);

  const onChartEvents = useMemo(
    () => ({
      click: onChartClick,
      dblclick: onChartDblClick,
      mousemove: onChartMouseMove,
    }),
    [onChartClick, onChartDblClick, onChartMouseMove],
  );

  // —— 实体关系全选状态 ——
  const entityAllChecked = ENTITY_RELATIONS.every((r) => visibleRelations.has(r));

  // —— 是否数据不足 ——
  const notEnough = !hasEnoughData(animeList);

  return (
    <Modal
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ color: '#e6edf3', fontSize: 16 }}>🔗 知识图谱</span>
          <span style={{ fontSize: 12, color: '#8b949e', fontWeight: 400 }}>
            {animeList.length} 部番剧 · {fullGraph?.edges.length || 0} 条关系
          </span>
        </div>
      }
      open={open}
      onCancel={onClose}
      width="95vw"
      style={{ top: 20 }}
      styles={{
        body: { height: '82vh', padding: 0, background: '#0d1117' },
        header: { background: '#161b22', borderBottom: '1px solid #30363d' },
      }}
      footer={null}
      destroyOnClose
    >
      {notEnough ? (
        <div
          style={{
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Empty
            description={
              <span style={{ color: '#8b949e' }}>
                需要至少 3 部番剧才能构建知识图谱
              </span>
            }
          />
        </div>
      ) : (
        <div className="graph-modal-body">
          {/* ── 左侧控制面板 ── */}
          <div className="graph-sidebar">
            {/* 搜索框 */}
            <div style={{ marginBottom: 12 }}>
              <Input
                prefix={<SearchOutlined style={{ color: '#484f58' }} />}
                placeholder="搜索番剧…"
                value={searchKeyword}
                onChange={(e) => setSearchKeyword(e.target.value)}
                allowClear
                size="small"
                className="graph-search-input"
                style={{
                  background: '#0d1117',
                  borderColor: '#30363d',
                  color: '#e6edf3',
                }}
              />
            </div>

            {/* 关系类型筛选 */}
            <div style={{ marginBottom: 6, fontSize: 12, color: '#8b949e', fontWeight: 600 }}>
              实体关系
              <Checkbox
                checked={entityAllChecked}
                indeterminate={!entityAllChecked && ENTITY_RELATIONS.some((r) => visibleRelations.has(r))}
                onChange={(e) => {
                  const next = new Set(visibleRelations);
                  for (const rel of ENTITY_RELATIONS) {
                    if (e.target.checked) next.add(rel);
                    else next.delete(rel);
                  }
                  setVisibleRelations(next);
                }}
                style={{ float: 'right', fontSize: 11 }}
              >
                <span style={{ fontSize: 11 }}>全选</span>
              </Checkbox>
            </div>
            <div style={{ marginBottom: 10 }}>
              {ENTITY_RELATIONS.map((rel) => (
                <div key={rel} className="graph-filter-item">
                  <Checkbox
                    checked={visibleRelations.has(rel)}
                    onChange={() => toggleRelation(rel)}
                  />
                  <span
                    style={{
                      display: 'inline-block',
                      width: 12,
                      height: 12,
                      borderRadius: '50%',
                      background: RELATION_COLORS[rel],
                      marginRight: 6,
                    }}
                  />
                  <span style={{ fontSize: 12, color: '#c9d1d9' }}>
                    {RELATION_LABELS[rel]}
                  </span>
                </div>
              ))}
            </div>

            {/* 图例 */}
            <div style={{ fontSize: 11, color: '#484f58', marginBottom: 4, fontWeight: 600 }}>
              节点图例
            </div>
            <div className="graph-legend">
              {GRAPH_CATEGORIES.map((cat, idx) => (
                <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                  <span
                    style={{
                      display: 'inline-block',
                      width: 10,
                      height: 10,
                      borderRadius: '50%',
                      background: cat.itemStyle?.color || '#484f58',
                      border: '1px solid #30363d',
                    }}
                  />
                  <span style={{ color: '#8b949e', fontSize: 11 }}>
                    {cat.name}
                  </span>
                </div>
              ))}
            </div>

            {/* 连线模式开关 */}
            <div
              style={{
                marginTop: 16,
                borderTop: '1px solid #21262d',
                paddingTop: 10,
              }}
            >
              <div
                onClick={() => { setLinkingMode(!linkingMode); cancelLinking(); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '8px 12px', borderRadius: 8, cursor: 'pointer',
                  background: linkingMode ? 'rgba(251,114,153,0.12)' : '#21262d',
                  border: `1px solid ${linkingMode ? '#fb7299' : '#30363d'}`,
                  transition: 'all 0.2s',
                }}
              >
                <span style={{ fontSize: 15 }}>🔗</span>
                <div>
                  <div style={{ fontSize: 12, color: linkingMode ? '#fb7299' : '#8b949e', fontWeight: 600 }}>
                    连线模式
                  </div>
                  <div style={{ fontSize: 10, color: '#484f58' }}>
                    {linkingMode ? '点击番剧 → 点击实体关联' : '点击开启后建立关联'}
                  </div>
                </div>
                <div style={{
                  marginLeft: 'auto',
                  width: 36, height: 20, borderRadius: 10,
                  background: linkingMode ? '#fb7299' : '#30363d',
                  transition: 'background 0.2s',
                  position: 'relative',
                }}>
                  <div style={{
                    width: 14, height: 14, borderRadius: '50%',
                    background: '#fff',
                    position: 'absolute', top: 3,
                    left: linkingMode ? 18 : 3,
                    transition: 'left 0.2s',
                  }} />
                </div>
              </div>
            </div>

            {/* 操作提示 */}
            <div
              style={{
                marginTop: 10,
                fontSize: 10,
                color: '#484f58',
                lineHeight: 1.8,
              }}
            >
              <div>🖱️ 拖拽节点 · 滚轮缩放</div>
              <div>👆 点击番剧查看详情</div>
              <div>👆 双击空白重置视图</div>
            </div>

          </div>

          {/* ── 右侧画布 ── */}
          <div
            className="graph-canvas"
            ref={chartContainerRef}
            style={{
              cursor: linkingMode ? 'crosshair' : 'default',
              position: 'relative',
            }}
          >
            <ReactEChartsCore
              ref={chartRef}
              echarts={echarts}
              option={option}
              style={{ height: '100%', width: '100%' }}
              opts={{ renderer: 'canvas' }}
              lazyUpdate
              onEvents={onChartEvents}
            />
            {/* 连线模式：有源节点时显示拖拽线 */}
            {linkingMode && linkSource && linkSourcePosRef.current && (
              <svg
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: '100%',
                  pointerEvents: 'none',
                  zIndex: 10,
                }}
              >
                <line
                  x1={linkSourcePosRef.current.x}
                  y1={linkSourcePosRef.current.y}
                  x2={linkTargetPosRef.current?.x ?? mousePosRef.current.x}
                  y2={linkTargetPosRef.current?.y ?? mousePosRef.current.y}
                  stroke={linkHoverTarget ? '#52c41a' : '#fb7299'}
                  strokeWidth={linkHoverTarget ? 3 : 2}
                  strokeDasharray={linkHoverTarget ? 'none' : '6 4'}
                  opacity={0.85}
                />
                <circle
                  cx={linkSourcePosRef.current.x}
                  cy={linkSourcePosRef.current.y}
                  r={18}
                  fill="none"
                  stroke="#fb7299"
                  strokeWidth={2}
                  opacity={0.7}
                >
                  <animate
                    attributeName="r"
                    values="14;22;14"
                    dur="1.2s"
                    repeatCount="indefinite"
                  />
                  <animate
                    attributeName="opacity"
                    values="0.9;0.3;0.9"
                    dur="1.2s"
                    repeatCount="indefinite"
                  />
                </circle>
                {/* 磁吸成功：目标节点指示圈 */}
                {linkHoverTarget && linkTargetPosRef.current && (
                  <circle
                    cx={linkTargetPosRef.current.x}
                    cy={linkTargetPosRef.current.y}
                    r={20}
                    fill="rgba(82, 196, 26, 0.12)"
                    stroke="#52c41a"
                    strokeWidth={2}
                    opacity={0.9}
                  />
                )}
              </svg>
            )}
            {/* 连线模式提示横幅 */}
            {linkingMode && linkSource && (
              <div
                style={{
                  position: 'absolute',
                  top: 12,
                  left: '50%',
                  transform: 'translateX(-50%)',
                  background: '#1c2128',
                  border: `1px solid ${linkHoverTarget ? '#52c41a' : '#fb7299'}`,
                  borderRadius: 16,
                  padding: '6px 18px',
                  color: linkHoverTarget ? '#52c41a' : '#fb7299',
                  fontSize: 13,
                  zIndex: 11,
                  pointerEvents: 'none',
                  boxShadow: '0 2px 12px rgba(251,114,153,0.2)',
                  transition: 'border-color 0.15s, color 0.15s',
                }}
              >
                {linkHoverTarget
                  ? <>🎯 点击将「{linkSource.name}」连接到<span style={{ fontWeight: 600 }}>{linkHoverTarget.name}</span></>
                  : <>🔗 移动鼠标到目标标签/公司/角色上点击</>
                }
              </div>
            )}
          </div>

          {/* ── 连线确认对话框 ── */}
          <Modal
            title={<span style={{ color: '#e6edf3' }}>建立关联</span>}
            open={linkConfirmOpen}
            onOk={confirmCreateRelation}
            onCancel={() => { setLinkConfirmOpen(false); cancelLinking(); }}
            okText="确认"
            cancelText="取消"
            styles={{
              body: { background: '#161b22', padding: '20px 24px' },
              header: { background: '#161b22', borderBottom: '1px solid #30363d' },
              footer: { background: '#161b22', borderTop: '1px solid #30363d' },
            }}
          >
            <div style={{ color: '#8b949e', fontSize: 13, marginBottom: 8, textAlign: 'center' }}>
              番剧{' '}
              <span style={{ color: '#fb7299', fontWeight: 600 }}>{linkSource?.name}</span>
            </div>
            <div style={{ textAlign: 'center', color: '#8b949e', fontSize: 20, marginBottom: 8 }}>⬇️</div>
            <div style={{ color: '#8b949e', fontSize: 13, marginBottom: 16, textAlign: 'center' }}>
              {linkTarget?.type === 'tag' && (
                <>添加标签 <span style={{ color: '#2eaadc', fontWeight: 600 }}>{linkTarget.name}</span></>
              )}
              {linkTarget?.type === 'studio' && (
                <>制作公司设为 <span style={{ color: '#a371f7', fontWeight: 600 }}>{linkTarget.name}</span></>
              )}
              {linkTarget?.type === 'character' && (
                <>添加角色 <span style={{ color: '#d69d4a', fontWeight: 600 }}>{linkTarget.name}</span></>
              )}
            </div>
          </Modal>

          {/* ── 底部详情条 ── */}
          {selectedAnime && (
            <div className="graph-detail-panel">
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 0 }}>
                {/* 海报缩略图 */}
                {selectedAnime.posterUrl && (
                  <img
                    src={selectedAnime.posterUrl}
                    alt={selectedAnime.title}
                    style={{
                      width: 48,
                      height: 64,
                      objectFit: 'cover',
                      borderRadius: 4,
                      border: '1px solid #30363d',
                    }}
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                )}
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#e6edf3', marginBottom: 2 }}>
                    {selectedAnime.title}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <AntTag color={CATEGORY_CONFIG[selectedAnime.category].color}>
                      {CATEGORY_CONFIG[selectedAnime.category].label}
                    </AntTag>
                    {selectedAnime.bangumiScore && (
                      <span style={{ fontSize: 11, color: '#8b949e' }}>
                        BGM: {selectedAnime.bangumiScore.toFixed(1)}
                      </span>
                    )}
                    {selectedAnime.studio && (
                      <span style={{ fontSize: 11, color: '#a371f7' }}>
                        {selectedAnime.studio}
                      </span>
                    )}
                    {selectedAnime.tags.slice(0, 4).map((t) => (
                      <AntTag key={t.name} style={{ fontSize: 10, background: '#21262d', border: '1px solid #30363d', color: '#8b949e', margin: 0 }}>
                        {t.name}
                      </AntTag>
                    ))}
                  </div>
                </div>
              </div>
              <Button
                type="primary"
                size="small"
                icon={<InfoCircleOutlined />}
                onClick={() => {
                  if (selectedAnime) {
                    onAnimeClick(selectedAnime);
                  }
                }}
                style={{ borderRadius: 6, flexShrink: 0 }}
              >
                打开详情
              </Button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
};

export default KnowledgeGraphModal;
