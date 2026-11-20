/**
 * ScoreRankChart — 番剧网格底部的「评分 · 名次」总览图
 *
 * 一个面板、十来条折线：每条线是一个评分维度（总评 / 音声 / 制作 / 作画 / 沉浸 /
 * 剧情 / 人设 / 深度 / 电波 / BGM），横轴是「这一维度排第几」，纵轴是分数。
 * **每个点对应一部具体的番**，点一下直接打开它的详情卡片 —— 所以这个图既是分布总览，
 * 也是从分数反查番剧的入口。
 *
 * 分工：
 *   - 数据构建、排序、名次计算在 features/ranking/score-rank-series.ts（纯函数、可单测）；
 *   - 这里只管画：深浅主题两套配色、图例、tooltip、点击分发。
 *
 * 为什么要「按维度各自排名」而不是「按网格顺序」：参考的是同一套思路的榜单图 ——
 * 横轴换成网格顺序时，十个维度的线会在同一 x 上挤成一团，看不出「谁在这个维度更强」；
 * 各自排名后每条线都是一条单调下降的阶梯，维度之间的高低差、尾部断崖一眼能看出来。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ReactECharts from 'echarts-for-react';
import type { AnimeEntry, Dimension } from '../types';
import { DEFAULT_DIMENSIONS } from '../types';
import { useTheme } from '../theme/ThemeContext';
import { calcEntryOverall } from '../../core/overall';
import { getTemplateDimensions } from '../../features/anime-data/template-service';
import { fmt2 } from '../../core/math';
import {
  buildScoreRankSeries,
  maxRank,
  type ScoreRankPoint,
} from '../../features/ranking/score-rank-series';
import './ScoreRankChart.css';

/** 折叠状态（底部这块图占一屏，切成收起后下次进来保持收起） */
const COLLAPSED_KEY = 'anime_diary_score_rank_collapsed';

/**
 * 维度 → 小圆点颜色。
 *
 * 深色主题用高亮色相（在 #0d1117 上都能拉开），浅色主题换成同色相的深色版本 ——
 * 直接复用深色那套在白底上会糊成一片。键是维度 key，自定义维度走 fallback 轮转。
 * BGM 刻意用中性灰：它不是你的评分，是外部参考线，不该跟自有维度抢颜色。
 */
const DARK_DIM_COLORS: Record<string, string> = {
  overall: '#f8fafc',
  audio: '#22d3ee',
  production: '#facc15',
  animation: '#60a5fa',
  immersion: '#a78bfa',
  plot: '#34d399',
  character: '#fb923c',
  depth: '#f472b6',
  vibe: '#a3e635',
  char_appearance: '#f472b6',
  char_personality: '#34d399',
  char_voice: '#22d3ee',
  char_moe: '#a3e635',
  char_favor: '#fb923c',
  bgm: '#94a3b8',
};

const LIGHT_DIM_COLORS: Record<string, string> = {
  overall: '#0f172a',
  audio: '#0e7490',
  production: '#a16207',
  animation: '#1d4ed8',
  immersion: '#6d28d9',
  plot: '#047857',
  character: '#c2410c',
  depth: '#be185d',
  vibe: '#4d7c0f',
  char_appearance: '#be185d',
  char_personality: '#047857',
  char_voice: '#0e7490',
  char_moe: '#4d7c0f',
  char_favor: '#c2410c',
  bgm: '#64748b',
};

/** 用户自定义维度（模板里新加的 key）没有固定色，按顺序轮转取色 */
const DARK_FALLBACK_COLORS = [
  '#f472b6', '#38bdf8', '#fbbf24', '#a3e635', '#c084fc',
  '#fb923c', '#2dd4bf', '#e879f9', '#94a3b8',
];
const LIGHT_FALLBACK_COLORS = [
  '#be185d', '#0369a1', '#a16207', '#4d7c0f', '#6d28d9',
  '#c2410c', '#0f766e', '#a21caf', '#475569',
];

/** 番名里可能有 < > &（作品名经常带方括号书名号），tooltip 是 HTML，必须转义 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

export interface ScoreRankChartProps {
  /** 当前网格里的条目（已按分类 / 标签 / 搜索筛过），图表跟着筛选走 */
  animeList: AnimeEntry[];
  /** 当前模板的维度表（含 overall）；缺省退回 DEFAULT_DIMENSIONS */
  dimensions?: Dimension[];
  /** 当前网格选中的维度：这一条线加粗（其余保持原色，不做压暗）；不是评分维度时全部同权 */
  activeDim?: string;
  /** 点某个点 → 打开该番详情卡片 */
  onPickAnime?: (anime: AnimeEntry) => void;
}

const ScoreRankChart: React.FC<ScoreRankChartProps> = ({
  animeList,
  dimensions,
  activeDim,
  onPickAnime,
}) => {
  const { state, colors } = useTheme();
  const dark = state.themeMode === 'dark';

  const [collapsed, setCollapsed] = useState(readCollapsed);
  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
    } catch {
      /* 隐私模式 / 配额满：记不住就算了，不影响图 */
    }
  }, [collapsed]);

  const dims = dimensions && dimensions.length > 0 ? dimensions : DEFAULT_DIMENSIONS;

  /**
   * 总评唯一入口：core/overall 的 calcEntryOverall（按条目所属模板的权重算）。
   * 别在这里自己加权 —— 那会和详情面板、卡片上的总评分叉。
   */
  const overallOf = useCallback(
    (anime: AnimeEntry) => calcEntryOverall(anime, getTemplateDimensions),
    [],
  );

  const seriesData = useMemo(
    () => buildScoreRankSeries(animeList, dims, { overallOf }),
    [animeList, dims, overallOf],
  );

  /**
   * 标题区那两个数直接从 series 里数：再跑一遍 buildScoreRankSeries 只为拿计数
   * 是白算一次十个维度的排序（而且两处容易算岔）。
   */
  const summary = useMemo(() => {
    const ids = new Set<string>();
    for (const s of seriesData) for (const p of s.points) ids.add(p.animeId);
    return { titles: ids.size, series: seriesData.length };
  }, [seriesData]);

  /** 点击时按 id 找回条目（data 里只存 id，避免把整个 entry 塞进每个点） */
  const byId = useMemo(() => {
    const map = new Map<string, AnimeEntry>();
    for (const anime of animeList) map.set(anime.id, anime);
    return map;
  }, [animeList]);

  const onEvents = useMemo(
    () => ({
      click: (params: { data?: { point?: ScoreRankPoint } }) => {
        const point = params?.data?.point;
        if (!point || !onPickAnime) return;
        const anime = byId.get(point.animeId);
        if (anime) onPickAnime(anime);
      },
    }),
    [byId, onPickAnime],
  );

  const option = useMemo(() => {
    const palette = dark ? DARK_DIM_COLORS : LIGHT_DIM_COLORS;
    const fallback = dark ? DARK_FALLBACK_COLORS : LIGHT_FALLBACK_COLORS;
    const highlighted = seriesData.some((s) => s.key === activeDim);
    const xMax = Math.max(4, maxRank(seriesData) + 1);
    /**
     * 纵轴默认 0–10（评分尺度），但真出现超 10 分的异常数据时抬高上界，
     * 别把点裁在网格外 —— 模板权重被改坏时 Excel 里真能读出 10.2 这种值。
     */
    let maxScore = 0;
    for (const s of seriesData) for (const p of s.points) if (p.score > maxScore) maxScore = p.score;
    const yMax = Math.max(10, Math.ceil(maxScore));
    /**
     * 点的大小跟数据量走：168 部番时 6px 的点会在密集区糊成一坨，
     * 缩到 5px 仍然点得中（命中区是 symbol 的外接矩形）；「全部」分类几百部时再小一档。
     */
    const longest = maxRank(seriesData);
    const dotSize = longest > 300 ? 4 : longest > 140 ? 5 : longest > 80 ? 5.5 : 6;
    // 上千个点逐点播入场动画会明显掉帧，数据多时直接出静态图
    const animate = longest <= 200;

    const colorOf = (key: string, index: number) =>
      palette[key] ?? fallback[index % fallback.length];

    const series = seriesData.map((item, index) => {
      const color = colorOf(item.key, index);
      const isActive = highlighted && item.key === activeDim;
      /**
       * 侧栏「维度排序」选中某个维度时，这里跟着聚焦：那条线加粗、点加大、画在最上层，
       * 其余维度整体压淡。压淡但**不隐去** —— 位置和走势还看得见，方便对比；
       * 只留 0.2 的线、0.44 的点，颜色仍能分辨出是哪一维。
       */
      const dimmed = highlighted && !isActive;
      return {
        name: item.label,
        type: 'line',
        /** [名次, 分数]；point 挂在数据项上供 tooltip / 点击回查 */
        data: item.points.map((point) => ({ value: [point.rank, point.score], point })),
        symbol: 'circle',
        symbolSize: isActive ? dotSize + 2 : dotSize,
        showSymbol: true,
        /**
         * 虚线连接：点很多时实线会把相邻两点的空隙全部吃满，虚线的"珠子串"更容易
         * 看出每一部番的位置（参考的那种榜单图也是这条线型）。
         */
        lineStyle: {
          width: isActive ? 2.2 : 1,
          type: 'dashed' as const,
          color,
          opacity: dimmed ? 0.2 : 0.9,
        },
        itemStyle: {
          color,
          opacity: dimmed ? 0.44 : 1,
          borderWidth: 0,
        },
        // 当前维度的线压在所有淡化线之上，密集区不会被别的颜色盖住
        z: isActive ? 12 : 1,
        emphasis: {
          scale: 1.9,
          focus: 'series' as const,
          itemStyle: {
            shadowBlur: 10,
            shadowColor: color,
          },
          lineStyle: { width: 2.6, opacity: 1 },
        },
        animationDuration: animate ? 480 : 0,
      };
    });

    return {
      backgroundColor: 'transparent',
      animation: animate,
      animationDuration: animate ? 480 : 0,
      animationEasing: 'cubicOut',
      grid: {
        left: 6,
        right: 18,
        top: 34,
        bottom: 6,
        containLabel: true,
      },
      legend: {
        type: 'scroll',
        top: 2,
        left: 0,
        right: 0,
        icon: 'circle',
        itemWidth: 8,
        itemHeight: 8,
        itemGap: 16,
        textStyle: { color: colors.textSecondary, fontSize: 11 },
        inactiveColor: dark ? '#3d444d' : '#c9d1d9',
        pageIconColor: colors.textSecondary,
        pageIconInactiveColor: colors.textMuted,
        pageTextStyle: { color: colors.textMuted, fontSize: 11 },
        data: seriesData.map((s) => s.label),
      },
      tooltip: {
        trigger: 'item' as const,
        confine: true,
        backgroundColor: dark ? 'rgba(22, 27, 34, 0.96)' : 'rgba(255, 255, 255, 0.98)',
        borderColor: colors.borderPrimary,
        borderWidth: 1,
        padding: [8, 10] as [number, number],
        textStyle: { color: colors.textPrimary, fontSize: 12 },
        extraCssText: 'border-radius:10px;box-shadow:0 14px 32px -14px rgba(0,0,0,.75);',
        formatter: (params: {
          seriesName?: string;
          data?: { point?: ScoreRankPoint };
        }) => {
          const point = params?.data?.point;
          if (!point) return '';
          const series = seriesData.find((s) => s.label === params.seriesName);
          const color = series ? colorOf(series.key, seriesData.indexOf(series)) : colors.brandPrimary;
          return [
            `<div style="max-width:240px;white-space:normal;line-height:1.45;`
              + `font-size:12px;font-weight:600;margin-bottom:6px">${escapeHtml(point.title)}</div>`,
            '<div style="display:flex;align-items:center;gap:6px;font-size:12px">',
            `<span style="width:7px;height:7px;border-radius:50%;background:${color};flex:0 0 auto"></span>`,
            `<span style="color:${colors.textSecondary}">${escapeHtml(params.seriesName || '')}</span>`,
            `<b style="color:${color};font-variant-numeric:tabular-nums">${fmt2(point.score)}</b>`,
            `<span style="color:${colors.textMuted};font-size:11px">第 ${point.rank} 名</span>`,
            '</div>',
            `<div style="margin-top:6px;font-size:11px;color:${colors.textMuted}">点击打开这部番</div>`,
          ].join('');
        },
      },
      xAxis: {
        type: 'value' as const,
        min: 1,
        max: xMax,
        splitNumber: 6,
        axisLine: { lineStyle: { color: colors.borderPrimary } },
        axisTick: { show: false },
        axisLabel: {
          color: colors.textSecondary,
          fontSize: 11,
          formatter: (value: number) => String(Math.round(value)),
        },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value' as const,
        min: 0,
        max: yMax,
        interval: 1,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          color: colors.textSecondary,
          fontSize: 11,
          formatter: (value: number) => fmt2(value),
        },
        // 横向网格线：跟参考图一样铺满，方便横向读分
        splitLine: {
          lineStyle: {
            color: colors.borderPrimary,
            opacity: dark ? 0.42 : 0.55,
          },
        },
      },
      series,
    };
  }, [activeDim, colors, dark, seriesData]);

  const isEmpty = seriesData.length === 0 || summary.titles === 0;

  return (
    <section className={`score-rank-panel${collapsed ? ' is-collapsed' : ''}`}>
      <header className="score-rank-head">
        <div className="score-rank-title">
          <span className="score-rank-title-main">评分 · 名次</span>
          <span className="score-rank-title-sub">
            横轴为各维度名次（同分按网格顺序），纵轴为评分；点任意一点打开该番
          </span>
        </div>
        <div className="score-rank-meta">
          {!isEmpty && (
            <>
              <span><b>{summary.titles}</b> 部</span>
              <span className="score-rank-meta-dot" aria-hidden>·</span>
              <span><b>{summary.series}</b> 个维度</span>
            </>
          )}
          <button
            type="button"
            className="score-rank-toggle"
            onClick={() => setCollapsed((prev) => !prev)}
            aria-expanded={!collapsed}
          >
            {collapsed ? '展开' : '收起'}
          </button>
        </div>
      </header>

      {!collapsed && (
        isEmpty ? (
          <div className="score-rank-empty">
            当前筛选下没有可绘制的维度分数 —— 给番剧打个分，这里就会长出曲线。
          </div>
        ) : (
          <div className="score-rank-body">
            <ReactECharts
              option={option}
              style={{ height: 340, width: '100%' }}
              opts={{ renderer: 'canvas' }}
              onEvents={onEvents}
              notMerge
              lazyUpdate
              aria-label="评分名次图：横轴为各维度名次，纵轴为评分，点一下打开对应番剧"
            />
          </div>
        )
      )}
    </section>
  );
};

export default ScoreRankChart;
