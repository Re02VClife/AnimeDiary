/**
 * features/music/PlayerBar — 底部悬浮播放条
 *
 * 做成悬浮胶囊而不是贴着窗口底的 dock：App 的 .main-content 是独立滚动容器，
 * 加 dock 要同时改布局和滚动高度，而这里只需要「关掉候选框还能继续听」。
 * z-index 压在 Modal(1000) 下面，打开详情/候选框时不会盖住弹窗。
 */
import React from 'react';
import { Button, Tooltip } from 'antd';
import {
  CloseOutlined, ExportOutlined, PauseCircleFilled, PlayCircleFilled, SoundOutlined,
} from '@ant-design/icons';
import { formatTrackDuration } from '../../core/music-links';
import { openInQQ, seekTo, stopPlayback, togglePlay, useMusicPlayer } from './music-store';

const PlayerBar: React.FC = () => {
  const player = useMusicPlayer();
  const track = player.track;
  if (!track) return null;

  const total = player.duration > 0 ? player.duration : (track.interval ?? 0);
  const ratio = total > 0 ? Math.min(1, Math.max(0, player.progress / total)) : 0;

  return (
    <div
      data-music-player="bar"
      style={{
        position: 'fixed',
        left: '50%',
        bottom: 16,
        transform: 'translateX(-50%)',
        width: 'min(680px, calc(100vw - 48px))',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 12px',
        borderRadius: 999,
        background: 'var(--bg-secondary)',
        backdropFilter: 'saturate(1.1) blur(18px)',
        border: '1px solid color-mix(in srgb, var(--brand-primary) 26%, var(--border-primary))',
        boxShadow: '0 10px 32px rgba(0, 0, 0, 0.45)',
        zIndex: 900,
      }}
    >
      <div
        style={{
          width: 34, height: 34, borderRadius: '50%', flexShrink: 0,
          background: track.coverUrl
            ? `center / cover no-repeat url(${JSON.stringify(track.coverUrl)})`
            : 'var(--bg-quaternary)',
          border: '1px solid var(--border-primary)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--text-muted)',
        }}
      >
        {!track.coverUrl && <SoundOutlined />}
      </div>

      <Button
        size="small"
        type="text"
        onClick={togglePlay}
        loading={player.loading}
        title={player.playing ? '暂停' : '播放'}
        icon={player.playing ? <PauseCircleFilled /> : <PlayCircleFilled />}
        style={{ color: 'var(--brand-primary)', fontSize: 18, flexShrink: 0 }}
      />

      <div style={{ minWidth: 0, maxWidth: 210, flexShrink: 1 }}>
        <div style={{
          fontSize: 12, fontWeight: 600, color: 'var(--text-primary)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {track.name}
        </div>
        <div style={{
          fontSize: 10, color: 'var(--text-muted)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {track.singer || '未知歌手'}
        </div>
      </div>

      <span style={{ fontSize: 10, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
        {formatTrackDuration(player.progress)}
      </span>

      <div
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          seekTo((e.clientX - rect.left) / rect.width);
        }}
        title="点击跳转"
        style={{
          flex: 1, height: 4, borderRadius: 2, cursor: 'pointer',
          background: 'var(--border-primary)', overflow: 'hidden', minWidth: 60,
        }}
      >
        <div style={{
          width: `${ratio * 100}%`, height: '100%',
          background: 'var(--brand-primary)', borderRadius: 2,
          transition: 'width 0.12s linear',
        }} />
      </div>

      <span style={{ fontSize: 10, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
        {formatTrackDuration(total)}
      </span>

      <Tooltip title="在 QQ 音乐打开">
        <Button size="small" type="text" icon={<ExportOutlined />} onClick={() => openInQQ(track)} />
      </Tooltip>
      <Tooltip title="关闭播放条">
        <Button size="small" type="text" icon={<CloseOutlined />} onClick={stopPlayback} />
      </Tooltip>
    </div>
  );
};

export default PlayerBar;
