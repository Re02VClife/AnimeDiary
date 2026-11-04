/**
 * 角色语音播放条 — 挂在角色卡详情面板的基本信息区下面
 *
 * 只在角色卡（templateId === 'character'）里渲染。没生成过就显示「生成」按钮，
 * 生成过就变成「播放/暂停 + 进度 + 换源」—— 目标是不用弹窗就能听，
 * 想换来源再点开 VoicePanel。
 */
import React, { useEffect, useRef, useState } from 'react';
import { Button, Spin, Tooltip } from 'antd';
import { PauseCircleFilled, PlayCircleFilled, ReloadOutlined, SoundOutlined } from '@ant-design/icons';
import { formatClipDuration } from '../../core/voice-clips';
import type { VoiceInfo } from './voice-service';
import { fetchVoiceInfo, voiceFileUrl } from './voice-service';
import VoicePanel from './VoicePanel';

interface CharacterVoiceBarProps {
  /** 角色名（角色卡标题）—— 同时是搜索关键词和音频目录名 */
  characterName: string;
  /** 角色所属作品（char_source，'/' 分隔），用于消歧同名角色 */
  workTitle?: string;
}

const CharacterVoiceBar: React.FC<CharacterVoiceBarProps> = ({ characterName, workTitle }) => {
  const [info, setInfo] = useState<VoiceInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [panelOpen, setPanelOpen] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // 角色名变了（在面板里翻上一张/下一张角色卡）就重新查一次
  useEffect(() => {
    let alive = true;
    setInfo(null);
    setPlaying(false);
    setCurrent(0);
    setLoading(true);
    fetchVoiceInfo(characterName)
      .then((next) => { if (alive) setInfo(next); })
      .catch(() => { /* 没有历史语音是常态 */ })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [characterName]);

  const togglePlay = () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => { /* 浏览器可能拦自动播放，忽略 */ });
    else el.pause();
  };

  const handleSeek = (event: React.MouseEvent<HTMLDivElement>) => {
    const el = audioRef.current;
    if (!el || !Number.isFinite(el.duration) || el.duration <= 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    el.currentTime = ratio * el.duration;
    setCurrent(el.currentTime);
  };

  if (loading) {
    return (
      <div style={{ height: 30, display: 'flex', alignItems: 'center', gap: 6 }}>
        <Spin size="small" />
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>查角色语音…</span>
      </div>
    );
  }

  const duration = info?.seconds ?? 0;
  const progress = duration > 0 ? Math.min(1, current / duration) : 0;

  return (
    <div style={{ marginBottom: 12 }}>
      {info ? (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '4px 8px', borderRadius: 6,
          background: 'var(--bg-quaternary)',
          border: '1px solid var(--border-primary)',
        }}>
          <audio
            ref={audioRef}
            src={voiceFileUrl(characterName, info.builtAt)}
            preload="metadata"
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => { setPlaying(false); setCurrent(0); }}
            onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
            style={{ display: 'none' }}
          />
          <Button
            size="small"
            type="text"
            title={playing ? '暂停' : '播放角色语音'}
            icon={playing ? <PauseCircleFilled /> : <PlayCircleFilled />}
            onClick={togglePlay}
            style={{ color: 'var(--brand-primary)' }}
          />
          <div
            onClick={handleSeek}
            title="点击跳转"
            style={{
              flex: 1, height: 4, borderRadius: 2, cursor: 'pointer',
              background: 'var(--border-primary)', overflow: 'hidden',
            }}
          >
            <div style={{
              width: `${progress * 100}%`, height: '100%',
              background: 'var(--brand-primary)', borderRadius: 2,
              transition: 'width 0.1s linear',
            }} />
          </div>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums', minWidth: 34 }}>
            {formatClipDuration(current)}
          </span>
          <Tooltip title={`来源：${info.source.title || info.source.bvid}（点击换一个）`}>
            <Button size="small" type="text" icon={<ReloadOutlined />} onClick={() => setPanelOpen(true)} />
          </Tooltip>
        </div>
      ) : (
        <Button
          size="small"
          block
          icon={<SoundOutlined />}
          onClick={() => setPanelOpen(true)}
          style={{
            background: 'var(--bg-quaternary)',
            borderColor: 'var(--border-primary)',
            color: 'var(--text-secondary)',
            fontSize: 11,
          }}
        >
          生成角色语音
        </Button>
      )}

      <VoicePanel
        open={panelOpen}
        characterName={characterName}
        workTitle={workTitle}
        onClose={() => setPanelOpen(false)}
        onSaved={(next) => {
          setInfo(next);
          setPlaying(false);
          setCurrent(0);
        }}
      />
    </div>
  );
};

export default CharacterVoiceBar;
