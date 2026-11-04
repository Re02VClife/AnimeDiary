/**
 * ScoreDistribution — 「维度排序」右侧的分数分布图（筹码峰）
 *
 * 纵向是分数（高分在上），横向是落在该分数档的条目数，虚线标平均值。
 * 点任意一档 → 把分数区间交给上层：侧栏排名列表和右侧番剧网格
 * 都会滑到对应分数段（见 Sidebar.handlePickScoreRange / AnimeGrid 的 scoreFocus 效果）。
 */
import React, { useMemo } from 'react';
import { fmt2 } from '../../core/math';
import {
  buildScoreDistribution,
  meanPositionPercent,
} from '../../features/ranking/score-distribution';
import type { ScoreRange } from '../../features/ranking/score-distribution';

interface ScoreDistributionProps {
  /** 当前维度的有效分数（0 分已在内部丢弃） */
  scores: number[];
  /** 当前选中档；null = 未选 */
  pickedRange: ScoreRange | null;
  /** 点击某一档 */
  onPickRange: (range: ScoreRange) => void;
  /** 维度名，用于「该维度没有分数」的提示 */
  dimLabel: string;
}

const ScoreDistribution: React.FC<ScoreDistributionProps> = ({
  scores, pickedRange, onPickRange, dimLabel,
}) => {
  const dist = useMemo(() => buildScoreDistribution(scores), [scores]);
  const avgTop = useMemo(() => meanPositionPercent(dist), [dist]);

  if (dist.bins.length === 0) {
    return (
      <div className="score-dist">
        <div className="score-dist-empty">「{dimLabel}」没有分数可分布</div>
      </div>
    );
  }

  const top = dist.bins[0].hi;
  const bottom = dist.bins[dist.bins.length - 1].lo;
  const headText = pickedRange
    ? `${fmt2(pickedRange.lo)}–${fmt2(pickedRange.hi)}`
    : `${fmt2(bottom)}–${fmt2(top)}`;

  return (
    <div className="score-dist">
      <div className="score-dist-head">
        <span className={pickedRange ? 'score-dist-range picked' : 'score-dist-range'}>{headText}</span>
        <span className="score-dist-count">{dist.total}部</span>
      </div>

      <div className="score-dist-plot">
        {dist.bins.map((bin) => {
          const active = !!pickedRange
            && Math.abs(pickedRange.lo - bin.lo) < 1e-6
            && Math.abs(pickedRange.hi - bin.hi) < 1e-6;
          // 最小 6% 保证只有 1 条的档也看得见，否则会被峰值压成一条缝
          const width = bin.count > 0
            ? Math.max(6, (bin.count / dist.peak) * 100)
            : 0;
          return (
            <div
              key={bin.lo}
              className={`score-dist-row${active ? ' active' : ''}`}
              title={`${fmt2(bin.lo)} – ${fmt2(bin.hi)}：${bin.count} 部`}
              onClick={() => onPickRange({ lo: bin.lo, hi: bin.hi })}
            >
              <div
                className={`score-dist-bar${bin.count === 0 ? ' empty' : ''}`}
                style={{ width: `${width}%` }}
              />
            </div>
          );
        })}

        {/* 平均分线：虚线压在条上，标签贴在右侧 */}
        <div className="score-dist-avg" style={{ top: `${avgTop}%` }}>
          <span>均 {fmt2(dist.mean)}</span>
        </div>
      </div>
    </div>
  );
};

export default ScoreDistribution;
