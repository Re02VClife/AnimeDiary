import { useState, useEffect, useCallback, useRef } from 'react';
import { Popconfirm } from 'antd';
import { DeleteOutlined } from '@ant-design/icons';
import type { AnimeEntry, Dimension } from '../types';
import { loadPosterPositions } from '../../features/anime-data/storage-service';
import { getTemplate, getPosterObjectPosition } from '../../features/anime-data/template-service';
import { searchPoster } from '../../features/anime-data/excel-service';
import { formatReleaseDateCn } from '../../core/date';
import { formatScore } from '../../core/math';
import { useCutoutIndex } from '../../features/image-management/use-cutout-index';
import { applyCutout, fallbackPosterUrl } from '../../features/image-management/cutout-service';

interface AnimeGridProps {
  animeList: AnimeEntry[];
  onAnimeClick: (anime: AnimeEntry) => void;
  activeDim?: string;
  onDeleteFromWatching?: (animeId: string) => void;
  batchMode?: boolean;
  selectedBatchAnime?: string[];
  onBatchAnimeChange?: (ids: string[]) => void;
  /** 当前激活模板的维度列表（用于维度标签查找） */
  templateDims?: Dimension[];
}

const AnimeGrid: React.FC<AnimeGridProps> = ({
  animeList, onAnimeClick, activeDim, onDeleteFromWatching,
  batchMode, selectedBatchAnime, onBatchAnimeChange,
  templateDims,
}) => {
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  /** 已有去底立绘的目录集合；卡片据此决定用原图还是 cover-nobg.png */
  const cutoutNames = useCutoutIndex();

  /**
   * 卡片海报自动补图（仅本次会话的内存，**不写库、不写 Excel**）
   *
   * 为什么卡片也补图：Excel 里没存海报的条目以前只能显示占位块，而详情面板却会实时搜给你看，
   * 于是出现「点开有图、卡片没图」。这里让卡片滚到视口时也搜一次，但结果只放在内存：
   * 搜错了不会污染数据（你可以在详情里删掉并拉黑），搜对了点「保存封面」才会真正持久化。
   */
  const [autoPosters, setAutoPosters] = useState<Record<string, string>>({});
  const gridRef = useRef<HTMLDivElement>(null);
  const queueRef = useRef<{ id: string; alias: string; title: string }[]>([]);
  const runningRef = useRef(false);
  const queuedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    setPositions(loadPosterPositions());
  }, [animeList]);

  /** 动态计算条目的加权总评（根据条目自身模板的维度和权重） */
  const calcOverall = useCallback((entry: AnimeEntry): number => {
    const allDims = getTemplate(entry.templateId).dimensions
      .filter((d) => d.key !== 'overall');
    if (allDims.length === 0) return 0;

    const hasWeights = allDims.some((d) => d.weight > 0);
    const effectiveDims = hasWeights
      ? allDims.filter((d) => d.weight > 0)
      : allDims.map((d) => ({ ...d, weight: 1 / allDims.length }));

    let tw = 0, ws = 0;
    for (const d of effectiveDims) {
      const s = entry.scores.find((sc) => sc.dimensionKey === d.key)?.score ?? 0;
      if (s > 0) { ws += s * d.weight; tw += d.weight; }
    }
    return tw > 0 ? ws / tw : 0;
  }, []);

  /** 串行消费搜索队列：避免一次滚动就并发几十个请求把 AniList 打挂 */
  const drainQueue = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    while (queueRef.current.length > 0) {
      const job = queueRef.current.shift()!;
      try {
        const r = await searchPoster(job.alias, job.title);
        if (r.posterUrl) {
          setAutoPosters((prev) => (prev[job.id] ? prev : { ...prev, [job.id]: r.posterUrl }));
        }
      } catch {
        /* 单条失败无所谓，保持占位块 */
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    runningRef.current = false;
  }, []);

  /** 卡片进入视口时排队搜索一次 */
  useEffect(() => {
    const root = gridRef.current;
    if (!root || typeof IntersectionObserver === 'undefined') return undefined;
    const targets = Array.from(root.querySelectorAll<HTMLElement>('[data-need-poster="1"]'));
    if (targets.length === 0) return undefined;

    const io = new IntersectionObserver(
      (entries) => {
        let added = false;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const el = entry.target as HTMLElement;
          io.unobserve(el);
          const id = el.dataset.animeId || '';
          if (!id || queuedRef.current.has(id)) continue;
          queuedRef.current.add(id);
          queueRef.current.push({ id, alias: el.dataset.alias || '', title: el.dataset.title || '' });
          added = true;
        }
        if (added) void drainQueue();
      },
      { rootMargin: '300px' },
    );
    targets.forEach((t) => io.observe(t));
    return () => io.disconnect();
  }, [animeList, drainQueue]);

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
        <div style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 8 }}>搜索添加你喜欢的番剧吧～</div>
      </div>
    );
  }

  return (
    <div className="anime-grid" ref={gridRef}>
      {animeList.map((anime) => {
        // 当前维度分数
        let dimScore: string | null = null;
        if (activeDim === 'overall') {
          const ov = calcOverall(anime);
          if (ov > 0) dimScore = `总评 ${formatScore(ov)}`;
        } else if (activeDim === 'bgm' && anime.bangumiScore) {
          dimScore = `BGM ${formatScore(anime.bangumiScore)}`;
        } else if (activeDim) {
          const s = anime.scores.find((sc) => sc.dimensionKey === activeDim);
          const label = (templateDims || []).find((d) => d.key === activeDim)?.label || activeDim;
          if (s && s.score > 0) dimScore = `${label} ${formatScore(s.score)}`;
        }

        const isSelected = batchMode && selectedBatchAnime?.includes(anime.id);
        const autoUrl = autoPosters[anime.id];
        /**
         * 已保存的海报优先用去底版（若该角色已有 cover-nobg.png）。
         * 只对已持久化的 posterUrl 生效 —— 自动搜到的临时图没有对应目录。
         */
        const savedPoster = anime.posterUrl ? applyCutout(anime.posterUrl, cutoutNames) : '';
        const posterUrl = savedPoster || autoUrl || '';
        /** 是否来自"自动搜索"（用于角标提示，且用于触发懒加载） */
        const isAuto = !anime.posterUrl && !!autoUrl;
        const needPoster = !anime.posterUrl;
        /**
         * 海报裁剪位置：条目级拖拽位置优先，否则用所属模板的默认焦点。
         * 角色立绘是全身竖图（实测宽高比 0.35，脸在最上方），而卡片容器是 3/4=0.75，
         * object-fit:cover + 居中会裁掉顶部约 26% —— 脸正好被裁掉。
         * 角色模板把焦点设成 '50% 0%' 后，卡片上能看到头和上半身。
         */
        const posterObjPos = getPosterObjectPosition(anime.templateId, positions[anime.id]);
        /** 容器比例也跟随模板（番剧模板是 3/4，与 CSS 默认一致；角色模板是 1/2） */
        const posterAspect = getTemplate(anime.templateId).layoutConfig?.posterAspectRatio;

        return (
          <div
            key={anime.id}
            className="anime-card"
            style={isSelected ? { borderColor: 'var(--brand-primary)', boxShadow: '0 0 12px rgba(251,114,153,0.3)' } : undefined}
            onClick={() => batchMode ? toggleAnimeSelect(anime.id) : onAnimeClick(anime)}
          >
            {/* 海报区 */}
            <div className="poster-wrap" style={posterAspect ? { aspectRatio: posterAspect } : undefined}>
              {/* 批量选择复选框 */}
              {batchMode && (
                <div style={{
                  position: 'absolute', top: 8, left: 8, zIndex: 5,
                  width: 22, height: 22, borderRadius: 4,
                  background: isSelected ? 'var(--brand-primary)' : 'rgba(0,0,0,0.4)',
                  border: `2px solid ${isSelected ? 'var(--brand-primary)' : 'var(--text-muted)'}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: '#fff', fontSize: 13, fontWeight: 700,
                  transition: 'all 0.15s',
                }}>
                  {isSelected ? '✓' : ''}
                </div>
              )}
              {posterUrl ? (
                <img src={posterUrl} alt={anime.title} loading="lazy"
                  data-poster-anime-id={anime.id}
                  style={posterObjPos ? { objectPosition: posterObjPos } : undefined}
                  onError={(e) => {
                    const img = e.currentTarget;
                    // 兜底：本地图缺失时先退回同目录的原图，而不是直接只剩占位符。
                    // 海报 URL 可能指向已失效的派生文件（例如被改名的去底图）。
                    const fallback = img.dataset.fallback !== '1' ? fallbackPosterUrl(img.getAttribute('src') || '') : null;
                    if (fallback) {
                      img.dataset.fallback = '1';
                      img.src = fallback;
                      return;
                    }
                    img.style.display = 'none';
                    img.parentElement!.querySelector('.poster-placeholder')?.classList.remove('hidden');
                  }}
                />
              ) : null}
              {/* 无海报（或尚未搜到）时占位；同时挂上懒加载标记 */}
              <div
                className={`poster-placeholder${posterUrl ? ' hidden' : ''}`}
                data-need-poster={needPoster ? '1' : undefined}
                data-anime-id={needPoster ? anime.id : undefined}
                data-title={needPoster ? anime.title : undefined}
                data-alias={needPoster ? (anime.searchAlias || '') : undefined}
              >
                🎬
              </div>
              {/* 自动搜到的图给个小角标，避免误以为是自己保存的 */}
              {isAuto && <div className="poster-auto-badge">自动</div>}

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
            <div
              className={`card-info${posterUrl ? ' has-poster-bg' : ''}`}
              style={posterUrl ? { '--poster-url': `url(${posterUrl})` } as React.CSSProperties : undefined}
            >
              <div className="card-title" title={anime.title}>{anime.title}</div>
              <div className="card-meta">
                <span>{anime.releaseDate ? formatReleaseDateCn(anime.releaseDate) : '未知'}</span>
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
