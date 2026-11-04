/**
 * 分数分布（筹码峰）计算
 *
 * 侧栏「维度排序」右侧的分布图需要三样东西：每档条数、平均分、单档峰值。
 * 这里只做纯计算，渲染交给 src/components/ScoreDistribution.tsx —— 分档边界可以单独测。
 */
import { round2 } from '../../core/math';

/**
 * 候选步长。
 *
 * 用自适应步长而不是固定 0.5：各维度的分数跨度差别很大（总评可能铺满 7~9.5，
 * 「深度」可能全挤在 0.3 分内）。固定步长会让窄跨度维度只剩两三个条，
 * 看不出"峰"在哪，点击定位的粒度也太粗。
 */
const STEP_CANDIDATES = [0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1];

/** 目标档数：太少不像分布，太多每档只剩一两个条目、条宽起伏没有意义 */
const TARGET_BINS = 20;

/** 分数区间（下沿含、上沿不含） */
export interface ScoreRange {
  lo: number;
  hi: number;
}

/**
 * 分布图点选后交给网格的「分数焦点」。
 * nonce 自增，保证连点同一档也能再次触发滚动。
 */
export interface ScoreFocus extends ScoreRange {
  dimKey: string;
  nonce: number;
}

export interface ScoreBin {
  /** 区间下沿（含） */
  lo: number;
  /** 区间上沿（不含；最后一档含端点） */
  hi: number;
  /** 落在本档的条目数 */
  count: number;
}

export interface ScoreDistribution {
  /** 从高分到低分排列的档位 */
  bins: ScoreBin[];
  /** 参与统计的条目数（有效分数个数） */
  total: number;
  /** 平均分；无数据时为 0 */
  mean: number;
  /** 单档最多条数（条宽归一化用） */
  peak: number;
  /** 分档步长；无数据时为 0 */
  step: number;
}

const EMPTY: ScoreDistribution = { bins: [], total: 0, mean: 0, peak: 0, step: 0 };

/**
 * 把一组分数切成等宽区间。
 *
 * 0 分与非法值一律视为「未评分」丢弃 —— 否则它们会堆在最低档，
 * 看上去像"很多人打 0 分"。
 *
 * 不做 0-10 的截断：实测数据里存在超范围脏值（「制作」列出现过 15），
 * 截断会把它悄悄混进 10 分档；按真实范围分档才能和排名列表对上号。
 */
export function buildScoreDistribution(scores: number[]): ScoreDistribution {
  const valid = scores.filter((s) => Number.isFinite(s) && s > 0);
  if (valid.length === 0) return EMPTY;

  const min = Math.min(...valid);
  const max = Math.max(...valid);

  // 选出能让档数不超过 TARGET_BINS 的最小步长；
  // 分数跨度离谱时（脏值）退化成整数步长兜底
  const span = max - min;
  const step = STEP_CANDIDATES.find((s) => span / s <= TARGET_BINS)
    ?? Math.ceil(span / TARGET_BINS);
  // 每 1 分切成多少格；用整数格号做分桶，避免 0.05 这类步长的浮点误差
  const unit = Math.max(1, Math.round(1 / step));

  const loIdx = Math.floor(min * unit);
  const hiIdx = Math.max(Math.ceil(max * unit), loIdx + 1);
  const counts = new Array<number>(hiIdx - loIdx).fill(0);
  for (const s of valid) {
    const idx = Math.min(hiIdx - 1, Math.max(loIdx, Math.floor(s * unit)));
    counts[idx - loIdx] += 1;
  }

  const bins: ScoreBin[] = [];
  for (let idx = hiIdx - 1; idx >= loIdx; idx--) {
    bins.push({
      lo: round2(idx / unit),
      hi: round2((idx + 1) / unit),
      count: counts[idx - loIdx],
    });
  }

  return {
    bins,
    total: valid.length,
    mean: round2(valid.reduce((sum, s) => sum + s, 0) / valid.length),
    peak: counts.reduce((m, c) => Math.max(m, c), 0),
    // 实际档宽（整数化后的 unit 可能与候选步长略有出入）
    step: 1 / unit,
  };
}

/** 平均分在分布图上的纵向位置（0=顶部最高分，100=底部最低分） */
export function meanPositionPercent(dist: ScoreDistribution): number {
  if (dist.bins.length === 0) return 0;
  const top = dist.bins[0].hi;
  const bottom = dist.bins[dist.bins.length - 1].lo;
  if (top <= bottom) return 0;
  return Math.min(100, Math.max(0, ((top - dist.mean) / (top - bottom)) * 100));
}

/**
 * 在「按当前排序维度分数排好的序列」里找某个分数区间的落点。
 *
 * 区间内一条都没有时（点了空档，或该分数段被分类/标签过滤掉了）退化为
 * 分数最接近档位中心的那条 —— 否则点下去毫无反应，像是坏了。
 *
 * 侧栏排名列表和主界面网格共用这一套判定，保证两边跳到的是同一个分数段。
 *
 * @returns 下标；序列为空返回 -1
 */
export function findScoreRangeIndex(values: number[], lo: number, hi: number): number {
  if (values.length === 0) return -1;
  const hit = values.findIndex((v) => v >= lo && v < hi);
  if (hit >= 0) return hit;

  const mid = (lo + hi) / 2;
  let best = -1;
  let bestDiff = Infinity;
  values.forEach((v, i) => {
    const diff = Math.abs(v - mid);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  });
  return best;
}

