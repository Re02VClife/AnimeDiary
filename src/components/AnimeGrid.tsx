import { useState, useEffect, useCallback } from 'react';
import { Popconfirm } from 'antd';
import { DeleteOutlined } from '@ant-design/icons';
import type { AnimeEntry } from '../types';
import { loadPosterPositions } from '../services/storageService';

interface AnimeGridProps {
  animeList: AnimeEntry[];
  onAnimeClick: (anime: AnimeEntry) => void;
  activeDim?: string;
  onDeleteFromWatching?: (animeId: string) => void;
  batchMode?: boolean;
  selectedBatchAnime?: string[];
  onBatchAnimeChange?: (ids: string[]) => void;
}

const DIM_LABELS: Record<string, string> = {
  audio: '音声', production: '制作', animation: '作画', immersion: '沉浸',
  plot: '剧情', character: '人设', depth: '深度', vibe: '电波', bgm: 'BGM',
};

const AnimeGrid: React.FC<AnimeGridProps> = ({
  animeList, onAnimeClick, activeDim, onDeleteFromWatching,
  batchMode, selectedBatchAnime, onBatchAnimeChange,
}) => {
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});

  useEffect(() => {
    setPositions(loadPosterPositions());
  }, [animeList]);

  /** 批量模式下切换番剧选中 */
  const toggleAnimeSelect = useCallback((id: string) => {
    if (!onBatchAnimeChange) return;
    const sel = selectedBatchAnime || [];
    onBatchAnimeChange(sel.includes(id) ? sel.filter((i) => i !== id) : [...sel, id]);
  }, [selectedBatchAnime, onBatchAnimeChange]);

  if (animeList.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-icon" style={{ fontSize: 64, opacity: 0.5, marginBottom: 16 }}>🎬</div>
        <div className="empty-text">这里还没有番剧</div>
        <div style={{ color: '#484f58', fontSize: 13, marginTop: 8 }}>搜索添加你喜欢的番剧吧～</div>
      </div>
    );
  }

  return (
    <div className="anime-grid">
      {animeList.map((anime) => {
        // 当前维度分数
        let dimScore: string | null = null;
        if (activeDim === 'bgm' && anime.bangumiScore) {
          dimScore = `BGM ${anime.bangumiScore}`;
        } else if (activeDim) {
          const s = anime.scores.find((sc) => sc.dimensionKey === activeDim);
          if (s && s.score > 0) dimScore = `${DIM_LABELS[activeDim] || activeDim} ${s.score.toFixed(activeDim === 'vibe' ? 2 : 1)}`;
        }

        const isSelected = batchMode && selectedBatchAnime?.includes(anime.id);

        return (
          <div
            key={anime.id}
            className="anime-card"
            style={isSelected ? { borderColor: '#fb7299', boxShadow: '0 0 12px rgba(251,114,153,0.3)' } : undefined}
            onClick={() => batchMode ? toggleAnimeSelect(anime.id) : onAnimeClick(anime)}
          >
            {/* 海报区 */}
            <div className="poster-wrap">
              {/* 批量选择复选框 */}
              {batchMode && (
                <div style={{
                  position: 'absolute', top: 8, left: 8, zIndex: 5,
                  width: 22, height: 22, borderRadius: 4,
                  background: isSelected ? '#fb7299' : 'rgba(0,0,0,0.6)',
                  border: `2px solid ${isSelected ? '#fb7299' : '#484f58'}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: '#fff', fontSize: 13, fontWeight: 700,
                  transition: 'all 0.15s',
                }}>
                  {isSelected ? '✓' : ''}
                </div>
              )}
              {anime.posterUrl ? (
                <img src={anime.posterUrl} alt={anime.title} loading="lazy"
                  style={positions[anime.id] ? { objectPosition: `${positions[anime.id].x}% ${positions[anime.id].y}%` } : undefined}
                  onError={(e) => {
                    e.currentTarget.style.display = 'none';
                    e.currentTarget.parentElement!.querySelector('.poster-placeholder')?.classList.remove('hidden');
                  }}
                />
              ) : null}
              <div className={`poster-placeholder${anime.posterUrl ? ' hidden' : ''}`}>🎬</div>

              {/* 在看删除按钮 */}
              {onDeleteFromWatching && (
                <Popconfirm
                  title="确定移除？" description="不会同步删除 Excel 中的数据"
                  onConfirm={(e) => { e?.stopPropagation(); onDeleteFromWatching(anime.id); }}
                  onCancel={(e) => e?.stopPropagation()}
                  okText="移除" cancelText="取消"
                >
                  <div className="card-delete-btn" onClick={(e) => e.stopPropagation()} title="从列表中移除">
                    <DeleteOutlined style={{ fontSize: 14 }} />
                  </div>
                </Popconfirm>
              )}
            </div>

            {/* 信息区 */}
            <div className="card-info">
              <div className="card-title" title={anime.title}>{anime.title}</div>
              <div className="card-meta">
                <span>{anime.releaseDate || '未知'}</span>
                {dimScore ? (
                  <span className="dim-score">{dimScore}</span>
                ) : anime.bangumiScore ? (
                  <span className="dim-score">BGM {anime.bangumiScore}</span>
                ) : null}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default AnimeGrid;
