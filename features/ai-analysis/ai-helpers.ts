/**
 * features/ai-analysis/ai-helpers — 各 Skill 共享的内部工具函数
 */
import type { AnimeEntry, Dimension } from '../../src/types';
import { DEFAULT_DIMENSIONS } from '../../src/types';
import { getTemplate } from '../anime-data/template-service';

/** 获取番剧某维度的分数 */
export function getScore(a: AnimeEntry, dimKey: string): number {
  return a.scores.find((s) => s.dimensionKey === dimKey)?.score ?? 0;
}

/** 计算加权总评（使用指定模板维度权重表，默认 DEFAULT_DIMENSIONS） */
export function calcOverall(a: AnimeEntry, dimensions?: Dimension[]): number {
  let total = 0;
  let totalWeight = 0;
  const dims = dimensions || DEFAULT_DIMENSIONS;
  for (const dim of dims) {
    if (dim.key === 'overall') continue;
    const s = getScore(a, dim.key);
    if (s > 0) {
      total += s * dim.weight;
      totalWeight += dim.weight;
    }
  }
  return totalWeight > 0 ? total / totalWeight : 0;
}

/**
 * 口味偏差值: (总评 × 0.4 + 电波 × 0.6) - BGM 评分
 * 正值 = 个人偏好高于社区，负值 = 社区评分高于个人
 */
export function calcTasteDeviation(a: AnimeEntry): number | null {
  const bgm = a.bangumiScore;
  if (bgm === undefined || bgm <= 0) return null;
  const overall = getScore(a, 'overall') || calcOverall(a, a.templateId ? getTemplate(a.templateId).dimensions : undefined);
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
