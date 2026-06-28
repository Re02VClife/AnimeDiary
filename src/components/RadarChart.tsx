/**
 * 评分雷达图组件
 *   支持两种显示模式：
 *     - percentile: 百分位排名 (0-100)，显示"前 X%"
 *     - fixed:      固定数值范围 (0-10)，显示原始分数，超出 10 的可溢出显示
 *   支持自定义最小值（底边值，默认 0）
 */
import ReactECharts from 'echarts-for-react';
import { useMemo } from 'react';
import type { AnimeEntry } from '../types';
import { getActiveDimensions } from '../../features/anime-data/template-service';
import { buildPercentileMap, getPercentileScores } from '../services/rankingService';

interface RadarChartProps {
  anime: AnimeEntry;
  allAnime: AnimeEntry[];
  /** 迷你模式：更小的图表，用于卡片内嵌 */
  mini?: boolean;
  /** 覆盖模板 ID（详情面板切换模板时使用，缺省从 anime 读取） */
  templateId?: string;
  /** 雷达图显示模式 */
  radarMode?: 'percentile' | 'fixed';
  /** 最小值（底边值），默认 0 */
  radarMin?: number;
}

const RadarChart: React.FC<RadarChartProps> = ({
  anime,
  allAnime,
  mini = false,
  templateId,
  radarMode = 'percentile',
  radarMin = 0,
}) => {
  const stats = useMemo(() => buildPercentileMap(allAnime), [allAnime]);
  const templateDims = useMemo(
    () => templateId ? getActiveDimensions({ ...anime, templateId }) : getActiveDimensions(anime),
    [anime, templateId],
  );
  const percentileData = useMemo(
    () => getPercentileScores(anime, stats, templateDims),
    [anime, stats, templateDims],
  );

  // 排除总评维度
  const dims = percentileData.filter((d) => d.dimensionKey !== 'overall');

  // ── 计算显示参数 ──
  const { indicatorMax, dataValues, tooltipFormat } = useMemo(() => {
    if (radarMode === 'fixed') {
      // 固定数值模式：0-10 刻度，超出 10 的数值自然溢出雷达图边界
      return {
        indicatorMax: 10,
        // 不截断原始分数，只应用最小值底线；超 max 的值会在雷达图边界外显示
        dataValues: dims.map((d) => Math.max(radarMin, d.rawScore)),
        tooltipFormat: (label: string, v: number) =>
          `${label}: <b style="color:#fb7299">${v.toFixed(1)} / 10</b>`,
      };
    }
    // 百分位模式：0-100 刻度，显示百分位排名
    return {
      indicatorMax: 100,
      dataValues: dims.map((d) => Math.max(radarMin, d.percentile)),
      tooltipFormat: (label: string, v: number) =>
        `${label}: <b style="color:#fb7299">前 ${Math.round(100 - v)}%</b>`,
    };
  }, [dims, radarMode, radarMin]);

  const option = useMemo(() => ({
    backgroundColor: 'transparent',
    radar: {
      center: ['50%', '50%'],
      radius: mini ? '60%' : '75%',
      axisName: {
        color: 'var(--text-secondary)',
        fontSize: mini ? 8 : 11,
        fontWeight: 'normal' as const,
      },
      indicator: dims.map((d) => ({
        name: d.label,
        max: indicatorMax,
      })),
      axisLine: { lineStyle: { color: 'var(--border-primary)' } },
      splitLine: { lineStyle: { color: 'var(--bg-quaternary)' } },
      splitArea: {
        areaStyle: { color: ['var(--bg-secondary)', 'var(--bg-tertiary)'] },
      },
    },
    series: [
      {
        type: 'radar',
        data: [
          {
            value: dataValues,
            name: anime.title,
            symbol: mini ? 'none' : 'circle',
            symbolSize: 4,
            lineStyle: { color: 'var(--brand-primary)', width: 2 },
            areaStyle: { color: 'rgba(251, 114, 153, 0.15)' },
            itemStyle: { color: 'var(--brand-primary)' },
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
      backgroundColor: 'var(--bg-tertiary)',
      borderColor: 'var(--border-primary)',
      textStyle: { color: 'var(--text-primary)', fontSize: 12 },
      formatter: (params: unknown) => {
        const p = params as { name?: string; value?: number[] };
        if (!Array.isArray(p.value)) return '';
        const lines = dims.map((d, i) => {
          const v = p.value?.[i] ?? 0;
          return tooltipFormat(d.label, v);
        });
        return lines.join('<br/>');
      },
    },
  }), [dims, anime.title, mini, indicatorMax, dataValues, tooltipFormat]);

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
