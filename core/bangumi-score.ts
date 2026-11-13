/**
 * core/bangumi-score — 本地综合分 → Bangumi 评分的纯逻辑（无网络）
 *
 * 两边的口径不一样，不能直接抄：
 *   - 本地：维度加权平均，连续值，实际分布集中在 7.5–9.5；
 *   - Bangumi：整数 1–10，1 = 不忍直视，10 = 神作，0 = 不评分。
 *
 * 直接四舍五入的结果是 175 条里有大半挤进 9 和 10 两档，等于把你原本
 * 有区分度的打分压平了。所以留两个旋钮：
 *   slope  —— 以 center 为轴缩放。小于 1 时分数往 center 收（封顶更严）；
 *   offset —— 整体平移，用来纠正「我打分普遍比 BGM 高一档」。
 */

export interface ScoreMapping {
  /** 平移量（-2 ~ +2），正数整体抬高 */
  offset: number;
  /** 缩放系数（0.5 ~ 1.5），以 center 为轴 */
  slope: number;
  /** 缩放中心，默认 8（本地分数的密集区） */
  center: number;
}

export const DEFAULT_SCORE_MAPPING: ScoreMapping = { offset: 0, slope: 1, center: 8 };

/** 旋钮的安全范围，超出就在 UI 上限制，避免一键把全部评分推到 1 或 10 */
export const SCORE_MAPPING_LIMITS = {
  offset: { min: -2, max: 2 },
  /**
   * 上限 2.5。本地分数范围 4.72–8.96、Bangumi 4.40–8.70，要让你心里的
   * 「8 分 = 满分」对上，解出来斜率约 2.3；再大（2.8 以上）10 分档会明显
   * 鼓出来，变成「堆在边界」而不是「摊开」。
   */
  slope: { min: 0.5, max: 2.5 },
  center: { min: 6, max: 9 },
} as const;

/**
 * 映射成 Bangumi 的 rate。
 * 返回 null 表示「这条不该写评分」——本地没打过分，或值非法。
 * 注意 Bangumi 的 0 是「清除评分」，不能用它表示低分。
 */
export function mapScore(overall: number | null | undefined, mapping: ScoreMapping = DEFAULT_SCORE_MAPPING): number | null {
  if (typeof overall !== 'number' || !Number.isFinite(overall) || overall <= 0) return null;
  const raw = mapping.center + (overall - mapping.center) * mapping.slope + mapping.offset;
  if (!Number.isFinite(raw)) return null;
  // 四舍五入后再钳制：0.4 分不能变成「清除评分」
  return Math.min(10, Math.max(1, Math.round(raw)));
}

/** 把映射结果按 1–10 计数，索引 0 空着不用（便于直方图按分数取值） */
export function scoreHistogram(values: Array<number | null>): number[] {
  const buckets = new Array(11).fill(0);
  for (const v of values) {
    if (typeof v === 'number' && v >= 1 && v <= 10) buckets[Math.round(v)]++;
  }
  return buckets;
}

/** 映射效果概览：落到最低/最高档的比例，用来提示「旋钮调过头了」 */
export function mappingSummary(values: Array<number | null>): { total: number; atMax: number; atMin: number } {
  let total = 0;
  let atMax = 0;
  let atMin = 0;
  for (const v of values) {
    if (typeof v !== 'number') continue;
    total++;
    if (v >= 10) atMax++;
    if (v <= 1) atMin++;
  }
  return { total, atMax, atMin };
}

/**
 * 高斯核密度估计，用来画「Bangumi 社区评分」的分布曲线。
 *
 * 社区评分是 7.6 / 8.3 / 4.4 这种小数，四舍五入进整数档会把信息抹平
 * （8.4 和 8.6 被拆到 8 和 9，看着像两拨人）。曲线能保住形状。
 *
 * bandwidth 取 0.45：小于 0.3 会变成一排尖刺，大于 0.6 整个分布糊成一坨。
 * 返回值是「每 0.05 分一个采样点」的密度，纵轴没有绝对意义，只用来比形状。
 */
export function kdeSamples(samples: number[], bandwidth = 0.45): Array<{ x: number; density: number }> {
  const clean = samples.filter((v) => Number.isFinite(v));
  if (clean.length === 0) return [];
  const norm = 1 / (clean.length * bandwidth * Math.sqrt(2 * Math.PI));
  const out: Array<{ x: number; density: number }> = [];
  // 采样范围比 1-10 略宽，两端的高斯尾巴才不会被硬切断
  for (let x = 0.5; x <= 10.5001; x += 0.05) {
    let sum = 0;
    for (const s of clean) {
      const z = (x - s) / bandwidth;
      sum += Math.exp(-0.5 * z * z);
    }
    out.push({ x, density: sum * norm });
  }
  return out;
}

/** 平均值，没样本时返回 null（避免 0 被当成「平均 0 分」） */
export function meanOf(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * 总体标准差。用来回答「我的评分比大众分散多少，以及映射后还剩多少」——
 * 个人口味的分差本来就该比社区均值大，但这个「大多少」得有数字，
 * 否则调斜率全靠感觉。
 */
export function stdOf(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}
