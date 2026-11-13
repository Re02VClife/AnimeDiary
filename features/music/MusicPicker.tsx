/**
 * features/music/MusicPicker — 「点一下音声，挑一首歌」的候选框
 *
 * 数据来源就是用户自己的 QQ 音乐歌单（默认那份「动漫」，177 首）。
 * 三个页签的取舍：
 *   - 本番推荐：拿 QQ 音乐标的 subtitle（「《化物语》TV动画第10集片头曲」）跟番名对，
 *     命中的排最前。这是整个功能里唯一「猜得准」的地方，优先展示。
 *   - 全部曲目：歌单原样，找不到推荐时兜底。
 *   - 搜索：歌单里没有的补充手段，接口只回少量结果，够用。
 *
 * 行点击 = 直接播（免费曲）或跳 QQ 音乐（VIP 曲）；「绑定」是单独的按钮，
 * 免得想收藏一首歌却被迫先听一遍。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Empty, Input, Modal, Popover, Segmented, Spin, Tag, Tooltip, message } from 'antd';
import {
  CustomerServiceOutlined, DeleteOutlined, ExportOutlined, LinkOutlined, PauseCircleFilled,
  PlayCircleFilled, ReloadOutlined, SoundOutlined, UserOutlined,
} from '@ant-design/icons';
import type { AnimeEntry } from '../../src/types';
import type { MusicPlaylist, MusicTrack } from '../../core/music-links';
import {
  animeKeyFor, formatTrackDuration, rankTracksForAnime,
} from '../../core/music-links';
import { fetchPlaylist, resolveMusicLink, searchMusic } from './music-service';
import {
  bindTrack, bindingsForKey, ensureMusicBindings, logoutLogin, openInQQ, playTrack,
  saveLogin, unbindTrack, updatePlaylistSource, useMusicBindings, useMusicPlayer,
} from './music-store';

interface MusicPickerProps {
  open: boolean;
  anime: AnimeEntry | null;
  onClose: () => void;
}

type TabKey = 'recommend' | 'all' | 'search';

const listStyle: React.CSSProperties = {
  maxHeight: '46vh',
  overflowY: 'auto',
  marginTop: 8,
  paddingRight: 4,
};

function coverStyle(url?: string): React.CSSProperties {
  return {
    width: 36, height: 36, borderRadius: 6, flexShrink: 0,
    background: url ? `center / cover no-repeat url(${JSON.stringify(url)})` : 'var(--bg-quaternary)',
    border: '1px solid var(--border-primary)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: 'var(--text-muted)', fontSize: 14,
  };
}

const ellipsis: React.CSSProperties = {
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};

interface TrackRowProps {
  track: MusicTrack;
  bound: boolean;
  playing: boolean;
  onPlay: () => void;
  onBind: () => void;
  onUnbind: () => void;
  /** 直接去 QQ 音乐（会员曲的保底入口，也是一次同步点击，不会被弹窗拦截） */
  onOpenQQ: () => void;
}

const TrackRow: React.FC<TrackRowProps> = ({ track, bound, playing, onPlay, onBind, onUnbind, onOpenQQ }) => (
  <div
    onClick={onPlay}
    title="点击播放（会员曲会跳转 QQ 音乐）"
    style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '6px 8px', borderRadius: 6, cursor: 'pointer',
      border: '1px solid transparent',
    }}
    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
  >
    <div style={coverStyle(track.coverUrl)}>
      {!track.coverUrl && <SoundOutlined />}
    </div>
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-primary)' }}>
        <span style={{ ...ellipsis, fontWeight: 500 }}>{track.name}</span>
        {track.vip && <Tag color="gold" style={{ marginInlineEnd: 0, lineHeight: '16px', fontSize: 10 }}>VIP</Tag>}
      </div>
      <div style={{ ...ellipsis, fontSize: 11, color: 'var(--text-muted)' }}>
        {track.singer}
        {track.subtitle ? ` · ${track.subtitle}` : track.album ? ` · ${track.album}` : ''}
      </div>
    </div>
    <span style={{ fontSize: 11, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
      {formatTrackDuration(track.interval)}
    </span>
    {playing ? (
      <PauseCircleFilled style={{ color: 'var(--brand-primary)', fontSize: 16 }} />
    ) : (
      <PlayCircleFilled style={{ color: 'var(--text-muted)', fontSize: 16 }} />
    )}
    <Tooltip title="在 QQ 音乐打开">
      <Button
        size="small"
        type="text"
        icon={<ExportOutlined />}
        onClick={(e) => { e.stopPropagation(); onOpenQQ(); }}
        style={{ color: 'var(--text-muted)' }}
      />
    </Tooltip>
    <Button
      size="small"
      type={bound ? 'text' : 'default'}
      icon={bound ? <DeleteOutlined /> : undefined}
      onClick={(e) => { e.stopPropagation(); if (bound) onUnbind(); else onBind(); }}
      style={bound ? { color: 'var(--text-muted)' } : { fontSize: 12 }}
    >
      {bound ? '已绑定' : '绑定'}
    </Button>
  </div>
);

const MusicPicker: React.FC<MusicPickerProps> = ({ open, anime, onClose }) => {
  const bindings = useMusicBindings();
  const player = useMusicPlayer();

  const [playlist, setPlaylist] = useState<MusicPlaylist | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>('recommend');

  const [keyword, setKeyword] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<MusicTrack[]>([]);
  const [linkInput, setLinkInput] = useState('');
  const [resolving, setResolving] = useState(false);
  const [sourceDraft, setSourceDraft] = useState('');
  const [sourceOpen, setSourceOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [cookieDraft, setCookieDraft] = useState('');
  const [loginSaving, setLoginSaving] = useState(false);

  const animeKey = useMemo(() => animeKeyFor(anime), [anime]);
  const boundList = bindingsForKey(bindings.map, animeKey);

  const load = useCallback(async (refresh: boolean) => {
    setLoading(true);
    setError(null);
    try {
      setPlaylist(await fetchPlaylist(undefined, refresh));
    } catch (e) {
      setError(e instanceof Error ? e.message : '歌单加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  // 打开时补一次绑定表 + 歌单；歌单只在第一次打开时拉，之后走服务端缓存
  useEffect(() => {
    if (!open) return;
    void ensureMusicBindings();
    if (!playlist && !loading) void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) {
      setTab('recommend');
      setKeyword('');
      setSearchResults([]);
      setLinkInput('');
    }
  }, [open]);

  const recommended = useMemo(
    () => (playlist && anime ? rankTracksForAnime(playlist.tracks, anime, 24) : []),
    [playlist, anime],
  );

  const handleSearch = useCallback(async (value: string) => {
    const query = value.trim();
    setKeyword(query);
    if (!query) return;
    setSearching(true);
    try {
      setSearchResults(await searchMusic(query));
    } catch (e) {
      message.error(e instanceof Error ? e.message : '搜索失败');
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  }, []);

  const handleResolve = useCallback(async () => {
    const input = linkInput.trim();
    if (!input) return;
    setResolving(true);
    try {
      const track = await resolveMusicLink(input);
      setSearchResults((prev) => [track, ...prev.filter((t) => t.mid !== track.mid)]);
      setTab('search');
      setKeyword('');
      message.success(`认出来了：${track.name}`);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '没认出这个链接');
    } finally {
      setResolving(false);
    }
  }, [linkInput]);

  const handleBind = useCallback(async (track: MusicTrack) => {
    try {
      await bindTrack(animeKey, track);
      message.success(`已绑定「${track.name}」`);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '绑定失败');
    }
  }, [animeKey]);

  const handleUnbind = useCallback(async (track: MusicTrack) => {
    try {
      await unbindTrack(animeKey, track.mid);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '解绑失败');
    }
  }, [animeKey]);

  const isPlaying = (track: MusicTrack) => player.track?.mid === track.mid && player.playing;
  const isBound = (track: MusicTrack) => boundList.some((item) => item.mid === track.mid);

  const renderRows = (tracks: MusicTrack[], emptyHint: string) => {
    if (tracks.length === 0) {
      return (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={<span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{emptyHint}</span>}
          style={{ margin: '24px 0' }}
        />
      );
    }
    return tracks.map((track) => (
      <TrackRow
        key={track.mid}
        track={track}
        bound={isBound(track)}
        playing={isPlaying(track)}
        onPlay={() => { void playTrack(track); }}
        onBind={() => { void handleBind(track); }}
        onUnbind={() => { void handleUnbind(track); }}
        onOpenQQ={() => { openInQQ(track); }}
      />
    ));
  };

  const titleNode = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <CustomerServiceOutlined style={{ color: 'var(--brand-primary)' }} />
      <span>给「{anime?.title || '这部番'}」挑首歌</span>
      {playlist && (
        <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-muted)' }}>
          歌单：{playlist.title} · {playlist.tracks.length} 首
        </span>
      )}
    </div>
  );

  return (
    <>
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={820}
      title={titleNode}
      styles={{ body: { paddingTop: 4 } }}
    >
      {/* 已绑定 */}
      {boundList.length > 0 && (
        <div style={{
          border: '1px solid var(--border-primary)',
          background: 'var(--bg-secondary)',
          borderRadius: 8, padding: '6px 8px', marginBottom: 8,
        }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
            已绑定到这张卡（{boundList.length}）
          </div>
          {boundList.map((track) => (
            <TrackRow
              key={track.mid}
              track={track}
              bound
              playing={isPlaying(track)}
              onPlay={() => { void playTrack(track); }}
              onBind={() => { /* 已绑定 */ }}
              onUnbind={() => { void handleUnbind(track); }}
              onOpenQQ={() => { openInQQ(track); }}
            />
          ))}
        </div>
      )}

      {/* 工具条 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Segmented
          size="small"
          value={tab}
          onChange={(v) => setTab(v as TabKey)}
          options={[
            { value: 'recommend', label: `本番推荐${recommended.length ? ` ${recommended.length}` : ''}` },
            { value: 'all', label: `全部曲目${playlist ? ` ${playlist.tracks.length}` : ''}` },
            { value: 'search', label: '搜索' },
          ]}
        />

        {tab === 'search' && (
          <Input.Search
            size="small"
            allowClear
            placeholder="歌名 / 歌手，回车搜索"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onSearch={(v) => { void handleSearch(v); }}
            loading={searching}
            style={{ width: 240 }}
          />
        )}

        <div style={{ flex: 1 }} />

        <Tooltip title="重新拉取歌单（默认缓存 6 小时）">
          <Button size="small" type="text" icon={<ReloadOutlined />}
            loading={loading}
            onClick={() => { void load(true); }} />
        </Tooltip>
        {playlist && (
          <Tooltip title="在 QQ 音乐里打开这个歌单">
            <Button size="small" type="text" icon={<LinkOutlined />}
              onClick={() => {
                window.open(`https://y.qq.com/n/ryqq_v2/playlist/${playlist.id}`, '_blank', 'noopener,noreferrer');
              }} />
          </Tooltip>
        )}
        <Popover
          open={sourceOpen}
          onOpenChange={(v) => { setSourceOpen(v); if (v) setSourceDraft(bindings.settings.playlistUrl || ''); }}
          trigger="click"
          title="换一个歌单"
          content={(
            <div style={{ width: 320, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                贴 QQ 音乐「分享歌单」的链接，或歌单页地址 / 纯数字 id。
                短链也行 —— 服务端会跳一次再解析。
              </div>
              <Input.TextArea
                size="small"
                autoSize={{ minRows: 2, maxRows: 3 }}
                value={sourceDraft}
                onChange={(e) => setSourceDraft(e.target.value)}
                placeholder="https://c6.y.qq.com/base/fcgi-bin/u?__=..."
              />
              <Button
                size="small"
                type="primary"
                onClick={async () => {
                  const next = sourceDraft.trim();
                  if (!next) { message.warning('先贴个链接'); return; }
                  try {
                    await updatePlaylistSource(next);
                    setSourceOpen(false);
                    await load(true);
                    message.success('歌单已切换');
                  } catch (e) {
                    message.error(e instanceof Error ? e.message : '切换失败');
                  }
                }}
              >
                保存并刷新
              </Button>
            </div>
          )}
        >
          <Button size="small" type="text" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            换歌单
          </Button>
        </Popover>
        <Tooltip title={bindings.login.loggedIn
          ? '已用你的 QQ 音乐登录态：会员曲也能在应用内播'
          : '粘一次浏览器 Cookie，会员曲就能在应用内播，不用跳网页'}>
          <Button
            size="small"
            type="text"
            icon={<UserOutlined />}
            onClick={() => { setLoginOpen(true); setCookieDraft(''); }}
            style={{
              fontSize: 12,
              color: bindings.login.loggedIn ? 'var(--brand-primary)' : 'var(--text-secondary)',
            }}
          >
            {bindings.login.loggedIn ? `已登录 ${bindings.login.uinMasked ?? ''}` : '登录'}
          </Button>
        </Tooltip>
      </div>

      {/* 内容 */}
      <div style={listStyle}>
        {loading && !playlist && (
          <div style={{ padding: 32, textAlign: 'center' }}>
            <Spin size="small" />
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>正在拉歌单…</div>
          </div>
        )}

        {error && !playlist && (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={<span style={{ fontSize: 12, color: 'var(--color-error)' }}>{error}</span>}
            style={{ margin: '24px 0' }}
          >
            <Button size="small" onClick={() => { void load(true); }}>重试</Button>
          </Empty>
        )}

        {playlist && tab === 'recommend' && (recommended.length > 0
          ? renderRows(recommended, '')
          : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  歌单里没有标明出自「{anime?.title || '这部番'}」的曲子
                </span>
              }
              style={{ margin: '24px 0' }}
            >
              <Button size="small" type="primary" onClick={() => setTab('all')}>
                去全部 {playlist.tracks.length} 首里挑
              </Button>
            </Empty>
          ))}

        {playlist && tab === 'all' && renderRows(playlist.tracks, '这个歌单是空的')}

        {tab === 'search' && (
          <>
            <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
              <Input
                size="small"
                placeholder="也可以直接粘贴 QQ 音乐歌曲链接，认出来就能绑"
                value={linkInput}
                onChange={(e) => setLinkInput(e.target.value)}
                onPressEnter={() => { void handleResolve(); }}
                prefix={<LinkOutlined style={{ color: 'var(--text-muted)' }} />}
                allowClear
              />
              <Button size="small" loading={resolving} onClick={() => { void handleResolve(); }}>
                解析
              </Button>
            </div>
            {renderRows(
              searchResults,
              keyword ? '没搜到，换个关键词试试' : '搜歌名 / 歌手，或粘贴歌曲链接',
            )}
          </>
        )}
      </div>

      {player.error && (
        <div style={{ fontSize: 11, color: 'var(--color-warning)', marginTop: 6 }}>
          {player.error}
          {player.track && (
            <Button size="small" type="link" style={{ fontSize: 11, padding: '0 4px' }}
              onClick={() => openInQQ(player.track!)}>
              在 QQ 音乐打开
            </Button>
          )}
        </div>
      )}
    </Modal>

    {/* 登录（粘 Cookie）：会员曲能不能在应用内播，取决于这一步 */}
    <Modal
      open={loginOpen}
      onCancel={() => setLoginOpen(false)}
      footer={null}
      width={560}
      title={<span><UserOutlined style={{ marginRight: 6, color: 'var(--brand-primary)' }} />QQ 音乐登录（可选）</span>}
    >
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.8 }}>
        <div style={{ marginBottom: 8 }}>
          不登录也能用：免费曲直接播，会员曲跳 QQ 音乐。
          想让会员曲<strong style={{ color: 'var(--text-primary)' }}>在应用内播</strong>，粘一次登录态即可：
        </div>
        <ol style={{ margin: '0 0 10px 18px', padding: 0 }}>
          <li>浏览器打开 <a href="https://y.qq.com" target="_blank" rel="noreferrer">y.qq.com</a> 并登录（绿钻账号）</li>
          <li>按 F12 → <b>Application / 应用</b> → Cookies → <code>https://y.qq.com</code></li>
          <li>把 <code>qm_keyst</code> 和 <code>uin</code> 两行的值复制出来，拼成 <code>uin=…; qm_keyst=…</code></li>
        </ol>
        <div style={{ marginBottom: 10, color: 'var(--text-muted)' }}>
          也可以直接在 Network 面板随便点一个 y.qq.com 的请求，整条 <code>Cookie:</code> 请求头复制过来 —— 多余的键会被丢掉。
        </div>
      </div>

      <Input.TextArea
        autoSize={{ minRows: 3, maxRows: 6 }}
        value={cookieDraft}
        onChange={(e) => setCookieDraft(e.target.value)}
        placeholder="uin=o0123456789; qm_keyst=…; qqmusic_key=…"
        style={{ fontFamily: 'monospace', fontSize: 11 }}
      />

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}>
        <Button
          size="small"
          type="primary"
          loading={loginSaving}
          onClick={async () => {
            if (!cookieDraft.trim()) { message.warning('先把 Cookie 粘进来'); return; }
            setLoginSaving(true);
            try {
              const status = await saveLogin(cookieDraft);
              message.success(`已登录${status.uinMasked ? `（${status.uinMasked}）` : ''}，会员曲现在能在应用内播了`);
              setLoginOpen(false);
            } catch (e) {
              message.error(e instanceof Error ? e.message : '保存失败');
            } finally {
              setLoginSaving(false);
            }
          }}
        >
          保存并启用
        </Button>
        {bindings.login.loggedIn && (
          <Button
            size="small"
            danger
            onClick={async () => {
              try {
                await logoutLogin();
                message.success('已退出登录，恢复成匿名播放');
              } catch (e) {
                message.error(e instanceof Error ? e.message : '退出失败');
              }
            }}
          >
            退出登录
          </Button>
        )}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {bindings.login.loggedIn
            ? `当前：${bindings.login.uinMasked ?? '已登录'}`
            : '只存在本机 music-login.json，不上传'}
        </span>
      </div>
    </Modal>
    </>
  );
};

export default MusicPicker;
