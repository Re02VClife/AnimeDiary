/**
 * features/ai-analysis/ai-helpers — 各 Skill 共享的内部工具函数
 */
import type { AnimeEntry, Dimension } from '../../src/types';
import { DEFAULT_DIMENSIONS } from '../../src/types';
import { getTemplate, getTemplateDimensions } from '../anime-data/template-service';
import { calcOverall as calcWeightedOverall, calcEntryOverall } from '../../core/overall';

/** 获取番剧某维度的分数 */
export function getScore(a: AnimeEntry, dimKey: string): number {
  return a.scores.find((s) => s.dimensionKey === dimKey)?.score ?? 0;
}

/**
 * 计算加权总评（算法本体在 core/overall，这里只决定维度来源）。
 *
 * - **不传 dimensions**：用条目自身模板的维度权重（getTemplate 会回退用户默认模板），
 *   与网格卡片 / 侧栏排行 / 详情面板同一口径。
 *   旧实现在这里固定用 DEFAULT_DIMENSIONS（代码里硬编码的权重），用户改过模板权重后
 *   AI 算出的总评就和界面上不是一个数 —— 就是 HANDOVER §6.1 那个 bug 的 AI 侧副本。
 * - **传 dimensions**：按传入的维度表算。跨模板的批量统计（getDimensionsForList）必须
 *   用同一把尺，否则每部番各用自己模板的权重，平均值之间没有可比性。
 */
export function calcOverall(a: AnimeEntry, dimensions?: Dimension[]): number {
  return dimensions
    ? calcWeightedOverall(a.scores, dimensions)
    : calcEntryOverall(a, getTemplateDimensions);
}

/**
 * 口味偏差值: (总评 × 0.4 + 电波 × 0.6) - BGM 评分
 * 正值 = 个人偏好高于社区，负值 = 社区评分高于个人
 */
export function calcTasteDeviation(a: AnimeEntry): number | null {
  const bgm = a.bangumiScore;
  if (bgm === undefined || bgm <= 0) return null;
  // 不传 dimensions：跟随 calcOverall 的默认口径（条目所属模板，默认模板条目走用户默认模板）
  const overall = getScore(a, 'overall') || calcOverall(a);
  const vibe = getScore(a, 'vibe');
  if (overall <= 0 || vibe <= 0) return null;
  return (overall * 0.4 + vibe * 0.6) - bgm;
}

/**
 * 一批番剧共用的维度表。
 * 列表里混了多个模板（番剧 + 角色卡）时退回默认维度，
 * 否则把一个模板的维度标签套到另一个模板的条目上，分数全是 0。
 */
export function getDimensionsForList(animeList: AnimeEntry[]): Dimension[] {
  const ids = new Set(
    animeList
      .filter((a) => a.scores.some((s) => s.score > 0))
      .map((a) => a.templateId || 'default'),
  );
  if (ids.size === 1) {
    const [only] = [...ids];
    return getTemplate(only).dimensions;
  }
  return DEFAULT_DIMENSIONS;
}

/** 格式化维度分数为单行文本 */
export function fmtDims(a: AnimeEntry, dimensions?: Dimension[]): string {
  const dims = dimensions || (a.templateId ? getTemplate(a.templateId).dimensions : DEFAULT_DIMENSIONS);
  return dims
    .filter((d) => d.key !== 'overall')
    .map((d) => `${d.label}${getScore(a, d.key).toFixed(d.key === 'vibe' ? 2 : 1)}`)
    .join(' ');
}

/** 构建评分向量（排除 overall），维度数由模板决定 */
export function buildScoreVector(a: AnimeEntry, dimensions?: Dimension[]): number[] {
  const dims = dimensions || (a.templateId ? getTemplate(a.templateId).dimensions : DEFAULT_DIMENSIONS);
  return dims
    .filter((d) => d.key !== 'overall')
    .map((d) => getScore(a, d.key));
}

/** 一位用户的口味摘要（给推荐/单番分析共用，避免重复拼长文本） */
export function summarizeTaste(animeList: AnimeEntry[], dimensions?: Dimension[]): string {
  const dims = dimensions || getDimensionsForList(animeList);
  const scored = animeList.filter((a) => a.scores.some((s) => s.score > 0));
  if (scored.length === 0) return '（暂无评分数据）';

  const sorted = [...scored].sort((a, b) => calcOverall(b, dims) - calcOverall(a, dims));
  const top = sorted.slice(0, 8).map((a) => `${a.title}(${calcOverall(a, dims).toFixed(1)})`);
  const bottom = sorted.slice(-5).reverse().map((a) => `${a.title}(${calcOverall(a, dims).toFixed(1)})`);

  return [
    `已评 ${scored.length} 部`,
    `最高分：${top.join('、')}`,
    `最低分：${bottom.join('、')}`,
  ].join('\n');
}
