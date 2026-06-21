/**
 * 评分雷达图组件
 *   以维度的百分位排名为轴值（非原始分数）
 *   支持完整版和迷你版两种尺寸
 */
import ReactECharts from 'echarts-for-react';
import { useMemo } from 'react';
import type { AnimeEntry } from '../types';
import { DEFAULT_DIMENSIONS } from '../types';
import { buildPercentileMap, getPercentileScores } from '../services/rankingService';

interface RadarChartProps {
  anime: AnimeEntry;
  allAnime: AnimeEntry[];
  /** 迷你模式：更小的图表，用于卡片内嵌 */
  mini?: boolean;
}

const RadarChart: React.FC<RadarChartProps> = ({ anime, allAnime, mini = false }) => {
  const stats = useMemo(() => buildPercentileMap(allAnime), [allAnime]);
  const percentileData = useMemo(
    () => getPercentileScores(anime, stats),
    [anime, stats],
  );

  // 排除总评维度（它是计算值，不做排名）
  const dims = percentileData.filter((d) => d.dimensionKey !== 'overall');

  const option = useMemo(() => ({
    backgroundColor: 'transparent',
    radar: {
      center: ['50%', '50%'],
      radius: mini ? '60%' : '75%',
      axisName: {
        color: '#8b949e',
        fontSize: mini ? 8 : 11,
        fontWeight: 'normal' as const,
      },
      indicator: dims.map((d) => ({
        name: d.label,
        max: 100,
      })),
      axisLine: { lineStyle: { color: '#30363d' } },
      splitLine: { lineStyle: { color: '#21262d' } },
      splitArea: {
        areaStyle: { color: ['#161b22', '#1c2128'] },
      },
    },
    series: [
      {
        type: 'radar',
        data: [
          {
            value: dims.map((d) => Math.max(10, d.percentile)),
            name: anime.title,
            symbol: mini ? 'none' : 'circle',
            symbolSize: 4,
            lineStyle: { color: '#fb7299', width: 2 },
            areaStyle: { color: 'rgba(251, 114, 153, 0.15)' },
            itemStyle: { color: '#fb7299' },
          },
        ],
        emphasis: {
          lineStyle: { width: 3 },
          areaStyle: { color: 'rgba(251, 114, 153, 0.25)' },
        },
      },
    ],
    tooltip: {
      trigger: 'item' as const,
      backgroundColor: '#1c2128',
      borderColor: '#30363d',
      textStyle: { color: '#e6edf3', fontSize: 12 },
      formatter: (params: unknown) => {
        const p = params as { name?: string; value?: number };
        return `${p.name}: 排名前 ${100 - (p.value || 0)}%`;
      },
    },
  }), [dims, anime.title, mini]);

  return (
    <ReactECharts
      option={option}
      style={{ height: mini ? 140 : 320, width: '100%' }}
      opts={{ renderer: 'svg' }}
      notMerge
      lazyUpdate
    />
  );
};

export default RadarChart;
