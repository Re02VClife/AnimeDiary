/**
 * features/local-library/LocalPlayerModal — 应用内选集播放器
 *
 * 为什么能直接在应用里播：Kazumi 下的是 **H.264 High + AAC 的 mp4**
 * （实测 E:\kazhumi Anime 的 799 / 50331 都是 1920×1080 / h264 / HE-AAC），
 * 这正是 Electron 自带的 Chromium 原生能解的格式，不需要外部播放器。
 * 万一遇到 mkv / HEVC，`<video>` 会触发 onError，这里给出「用系统播放器打开」的退路。
 *
 * 进度分两层存：
 *   - 秒级进度 → localStorage（local-service.ts），只为续播；
 *   - 看到第几集 → 服务端 local-library.json，卡片上的播放键据此继续。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Button, Tooltip, Empty } from 'antd';
import { LeftOutlined, RightOutlined, ReloadOutlined, FolderOpenOutlined } from '@ant-design/icons';
import type { AnimeEntry } from '../../types';
import { animeKeyFor } from '../../../core/music-links';
import { episodeLabel, formatEpisodeNumber } from '../../../core/local-library';
import { useLocalEpisodes, lastEpisodeForKey, rememberEpisode } from './local-store';
import {
  streamUrl,
  loadProgress,
  saveProgressTime,
  clearProgress,
  isEpisodeFinished,
} from './local-service';
import type { PlayableEpisode } from './local-match';

interface LocalPlayerModalProps {
  open: boolean;
  /** 要播的番；null 表示还没选 */
  anime: AnimeEntry | null;
  onClose: () => void;
  /** 从卡片播放键进来时可能指定集号（默认续播上次那集） */
  initialEpisode?: number;
}

/** 进度保存节流：每 3 秒写一次 localStorage，而不是每 timeupdate 都写 */
const SAVE_INTERVAL_MS = 3000;

const LocalPlayerModal: React.FC<LocalPlayerModalProps> = ({ open, anime, onClose, initialEpisode }) => {
  /** 只有打开时才订阅集数（关着的时候别让卡片重渲染） */
  const episodes = useLocalEpisodes(open ? anime : null);
  const key = anime ? animeKeyFor(anime) : '';

  /** 存集号而不是对象：episodes 重新加载时当前集还能自动跟上 */
  const [currentNumber, setCurrentNumber] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const lastSavedRef = useRef(0);

  const current: PlayableEpisode | null = useMemo(() => {
    if (!episodes || episodes.length === 0) return null;
    return episodes.find((e) => e.number === currentNumber) ?? episodes[0];
  }, [episodes, currentNumber]);

  const currentIndex = episodes && current ? episodes.findIndex((e) => e.number === current.number) : -1;

  /** 每次打开：决定从哪一集开始 —— 卡片传入 > 上次记录 > 第一集 */
  useEffect(() => {
    if (!open) {
      setCurrentNumber(null);
      setError(null);
      return;
    }
    if (!episodes || episodes.length === 0) return;
    if (currentNumber !== null && episodes.some((e) => e.number === currentNumber)) return;
    const remembered = lastEpisodeForKey(key);
    const target =
      (initialEpisode !== undefined ? episodes.find((e) => e.number === initialEpisode) : undefined)
      ?? (remembered !== undefined ? episodes.find((e) => e.number === remembered) : undefined)
      ?? episodes[0];
    setCurrentNumber(target.number);
    // currentNumber 只在这里被「纠正」，不参与依赖，否则每换一集就重置回第一集
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, episodes, key, initialEpisode]);

  /**
   * 切集时记到服务端，卡片上的播放键下次就能继续。
   * 依赖用 activeNumber（原始值）而不是 current（对象）——
   * 后者在每次重算集数时都是新引用，会让 effect 反复触发。
   */
  const activeNumber = current?.number ?? null;
  useEffect(() => {
    if (!open || activeNumber === null || !key) return;
    rememberEpisode(key, activeNumber);
  }, [open, activeNumber, key]);

  /** 换集：清掉错误提示 */
  useEffect(() => {
    setError(null);
    lastSavedRef.current = 0;
  }, [current?.relPath]);

  /** 元数据就绪：恢复上次看到的位置（看完了就从头播） */
  const handleLoadedMetadata = useCallback(() => {
    setError(null);
    const video = videoRef.current;
    if (!video || !current) return;
    const saved = loadProgress(current.dirPath, current.relPath);
    if (saved && !isEpisodeFinished(saved) && saved.time > 3 && saved.time < (video.duration || Infinity) - 3) {
      video.currentTime = saved.time;
    }
    // 别动 lastSavedRef：它记的是「上次保存的墙上时间」，不是媒体时长
  }, [current]);

  /** 边播边存（节流） */
  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video || !current) return;
    const now = Date.now();
    if (now - lastSavedRef.current < SAVE_INTERVAL_MS) return;
    lastSavedRef.current = now;
    saveProgressTime(current.dirPath, current.relPath, video.currentTime, video.duration);
    // 看完了就把这一集的临时进度清掉，下次重看从 0 开始
    if (isEpisodeFinished({ time: video.currentTime, duration: video.duration, updatedAt: '' })) {
      clearProgress(current.dirPath, current.relPath);
    }
  }, [current]);

  /** 播完自动跳下一集 */
  const handleEnded = useCallback(() => {
    if (!episodes || !current) return;
    const index = episodes.findIndex((e) => e.number === current.number);
    const next = episodes[index + 1];
    if (next) {
      setCurrentNumber(next.number);
      return;
    }
    // 最后一集：清掉进度，别让人下次点进来停在片尾
    clearProgress(current.dirPath, current.relPath);
  }, [episodes, current]);

  const goStep = useCallback((delta: number) => {
    if (!episodes || !current) return;
    const index = episodes.findIndex((e) => e.number === current.number);
    const next = episodes[index + delta];
    if (next) setCurrentNumber(next.number);
  }, [episodes, current]);

  /** 内置播放器解不了这个格式（mkv / HEVC）时的退路：交给系统播放器 */
  const openExternal = useCallback(() => {
    if (!current) return;
    // 用 <a download> 之外的简单方式：让系统按关联程序打开本地文件
    const url = streamUrl(current.dirPath, current.relPath);
    window.open(url, '_blank');
  }, [current]);

  // 键盘左右切集（只在播放器打开且焦点不在输入框时）
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'ArrowRight' && episodes && episodes.length > 1) {
        e.preventDefault();
        goStep(1);
      } else if (e.key === 'ArrowLeft' && episodes && episodes.length > 1) {
        e.preventDefault();
        goStep(-1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, episodes, goStep]);

  const title = anime?.title || '本地播放';

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={1120}
      destroyOnHidden
      className="local-player-modal"
      title={
        <div className="local-player-title">
          <span className="local-player-title-main">{title}</span>
          {current && (
            <span className="local-player-title-sub">
              {episodeLabel(current.number)}
              <span className="local-player-file">{current.fileName}</span>
            </span>
          )}
        </div>
      }
    >
      {!episodes || episodes.length === 0 ? (
        <Empty
          description="这部番还没有绑定本地文件"
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          style={{ padding: '40px 0' }}
        />
      ) : (
        <div className="local-player-body">
          <div className="local-player-stage">
            {current && (
              <video
                key={current.relPath}
                ref={videoRef}
                className="local-player-video"
                src={streamUrl(current.dirPath, current.relPath)}
                controls
                autoPlay
                preload="metadata"
                onLoadedMetadata={handleLoadedMetadata}
                onTimeUpdate={handleTimeUpdate}
                onEnded={handleEnded}
                onError={() => setError('这个格式内置播放器解不了（多为 mkv / HEVC），可以用系统播放器打开。')}
              />
            )}
            {error && (
              <div className="local-player-error">
                <div>{error}</div>
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <Button size="small" icon={<FolderOpenOutlined />} onClick={openExternal}>
                    用系统播放器打开
                  </Button>
                  <Button
                    size="small"
                    icon={<ReloadOutlined />}
                    onClick={() => {
                      setError(null);
                      videoRef.current?.load();
                    }}
                  >
                    重试
                  </Button>
                </div>
              </div>
            )}

            <div className="local-player-bar">
              <Tooltip title="上一集（←）">
                <Button
                  size="small"
                  icon={<LeftOutlined />}
                  disabled={currentIndex <= 0}
                  onClick={() => goStep(-1)}
                />
              </Tooltip>
              <span className="local-player-pos">
                {currentIndex >= 0 ? `${currentIndex + 1} / ${episodes.length}` : ''}
              </span>
              <Tooltip title="下一集（→）">
                <Button
                  size="small"
                  icon={<RightOutlined />}
                  disabled={currentIndex < 0 || currentIndex >= episodes.length - 1}
                  onClick={() => goStep(1)}
                />
              </Tooltip>
              <span className="local-player-path" title={current?.dirPath}>
                {current?.dirPath}
              </span>
            </div>
          </div>

          {/* 选集：宽屏时竖排在右，窄屏时折到视频下方 */}
          <div className="local-player-episodes" role="listbox" aria-label="选集">
            <div className="local-player-episodes-head">
              共 {episodes.length} 集
            </div>
            <div className="local-player-episodes-grid">
              {episodes.map((ep) => {
                const active = current?.number === ep.number;
                return (
                  <button
                    key={`${ep.dirPath}::${ep.relPath}`}
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={`local-episode-btn${active ? ' is-active' : ''}`}
                    title={`${episodeLabel(ep.number)} · ${ep.fileName}`}
                    onClick={() => setCurrentNumber(ep.number)}
                  >
                    {formatEpisodeNumber(ep.number)}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
};

export default LocalPlayerModal;
