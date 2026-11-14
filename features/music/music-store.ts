/**
 * features/music/music-store — 全局播放器 + 绑定表（模块级单例，不走 Context）
 *
 * 为什么不塞进 AnimeContext：播放进度每秒变 4 次，进了全局 reducer 会把
 * 网格、侧栏、详情面板全部重渲染一遍。这里用两条独立的订阅通道：
 *   - bindings 通道：绑定/解绑时变（很少）
 *   - player   通道：播放状态时变（很频繁，只有播放条和候选框的「正在播放」标记听）
 *
 * 音频元素也放在这里而不是组件里：候选框关掉、详情面板关掉之后播放不能断。
 */
import { useSyncExternalStore } from 'react';
import type { MusicBinding, MusicTrack } from '../../core/music-links';
import { MAX_BINDINGS_PER_ANIME, songPageUrl } from '../../core/music-links';
import {
  checkPlayable, clearMusicLogin, fetchMusicLogin, loadMusicStore, musicStreamUrl,
  saveMusicLogin, saveMusicStore,
} from './music-service';
import type { MusicLoginStatus } from './music-service';

export interface MusicPlayerState {
  track: MusicTrack | null;
  playing: boolean;
  loading: boolean;
  /** 当前播放秒数 */
  progress: number;
  /** 总时长（秒），拿不到元数据时先用歌单里的 interval 顶着 */
  duration: number;
  error: string | null;
}

export interface MusicBindingsState {
  map: Record<string, MusicBinding[]>;
  settings: { playlistUrl: string };
  /** QQ 音乐登录态（VIP 曲子靠它拿播放地址） */
  login: MusicLoginStatus;
  loaded: boolean;
  saving: boolean;
}

// ── 订阅基础设施 ─────────────────────────────────────────

const bindingsListeners = new Set<() => void>();
const playerListeners = new Set<() => void>();

let bindingsState: MusicBindingsState = {
  map: {},
  settings: { playlistUrl: '' },
  login: { loggedIn: false },
  loaded: false,
  saving: false,
};

let playerState: MusicPlayerState = {
  track: null,
  playing: false,
  loading: false,
  progress: 0,
  duration: 0,
  error: null,
};

let loadPromise: Promise<void> | null = null;

function setBindings(patch: Partial<MusicBindingsState>): void {
  bindingsState = { ...bindingsState, ...patch };
  bindingsListeners.forEach((fn) => fn());
}

function setPlayer(patch: Partial<MusicPlayerState>): void {
  playerState = { ...playerState, ...patch };
  playerListeners.forEach((fn) => fn());
}

function subscribeBindings(fn: () => void): () => void {
  bindingsListeners.add(fn);
  return () => { bindingsListeners.delete(fn); };
}

function subscribePlayer(fn: () => void): () => void {
  playerListeners.add(fn);
  return () => { playerListeners.delete(fn); };
}

/** 只关心「哪部番绑了哪些歌」的地方用它（网格角标），不会跟着播放进度重渲染 */
export function useMusicBindings(): MusicBindingsState {
  return useSyncExternalStore(subscribeBindings, () => bindingsState);
}

/** 播放条 / 候选框用它 */
export function useMusicPlayer(): MusicPlayerState {
  return useSyncExternalStore(subscribePlayer, () => playerState);
}

// ── 音频元素 ─────────────────────────────────────────────

let audio: HTMLAudioElement | null = null;

function getAudio(): HTMLAudioElement | null {
  if (typeof Audio === 'undefined') return null;
  if (audio) return audio;
  audio = new Audio();
  audio.preload = 'metadata';

  audio.addEventListener('playing', () => setPlayer({ playing: true, loading: false }));
  audio.addEventListener('pause', () => setPlayer({ playing: false }));
  audio.addEventListener('waiting', () => setPlayer({ loading: true }));
  audio.addEventListener('canplay', () => setPlayer({ loading: false }));
  audio.addEventListener('ended', () => setPlayer({ playing: false, progress: 0 }));
  audio.addEventListener('timeupdate', () => {
    setPlayer({
      progress: audio?.currentTime ?? 0,
      duration: Number.isFinite(audio?.duration) && (audio?.duration ?? 0) > 0
        ? (audio?.duration as number)
        : playerState.duration,
    });
  });
  audio.addEventListener('error', () => {
    setPlayer({ playing: false, loading: false, error: '音源加载失败（可能过期了，再点一次试试）' });
  });
  return audio;
}

// ── 绑定表 ───────────────────────────────────────────────

/** 首次用到时加载；失败也不阻塞 UI（面板里给个重试入口） */
export function ensureMusicBindings(): Promise<void> {
  if (bindingsState.loaded) return Promise.resolve();
  if (loadPromise) return loadPromise;
  loadPromise = Promise.all([loadMusicStore(), fetchMusicLogin().catch(() => ({ loggedIn: false }))])
    .then(([store, login]) => {
      setBindings({
        map: store.bindings ?? {},
        settings: store.settings ?? { playlistUrl: '' },
        login,
        loaded: true,
      });
    })
    .catch(() => {
      // 服务端不可用时也要让界面可用：绑定表当空，用户至少能播
      setBindings({ loaded: true });
    })
    .finally(() => { loadPromise = null; });
  return loadPromise;
}

/** 保存 Cookie 后刷新登录态；失败时抛出可读原因 */
export async function saveLogin(cookie: string): Promise<MusicLoginStatus> {
  const login = await saveMusicLogin(cookie);
  setBindings({ login });
  return login;
}

/** 一键登录窗口已经由服务端落盘，这里只把状态同步回界面 */
export async function refreshLogin(): Promise<MusicLoginStatus> {
  const login = await fetchMusicLogin();
  setBindings({ login });
  return login;
}

export async function logoutLogin(): Promise<void> {
  const login = await clearMusicLogin();
  setBindings({ login });
}

export function currentLogin(): MusicLoginStatus {
  return bindingsState.login;
}

async function persist(nextMap: Record<string, MusicBinding[]>, nextSettings = bindingsState.settings) {
  const prev = bindingsState.map;
  setBindings({ map: nextMap, saving: true });
  try {
    const saved = await saveMusicStore({ settings: nextSettings, bindings: nextMap });
    setBindings({ map: saved.bindings ?? nextMap, settings: saved.settings ?? nextSettings, saving: false });
  } catch {
    setBindings({ map: prev, saving: false });
    throw new Error('绑定保存失败（本地服务没起来？）');
  }
}

export function bindingsForKey(map: Record<string, MusicBinding[]>, key: string): MusicBinding[] {
  return map[key] ?? [];
}

/** 绑定一首歌；同一 mid 不重复加 */
export async function bindTrack(key: string, track: MusicTrack): Promise<void> {
  if (!key) throw new Error('这部番还没有标题，无法绑定');
  await ensureMusicBindings();
  const current = bindingsState.map[key] ?? [];
  if (current.some((item) => item.mid === track.mid)) return;
  const next: MusicBinding[] = [
    ...current,
    { ...track, boundAt: new Date().toISOString() },
  ].slice(0, MAX_BINDINGS_PER_ANIME);
  await persist({ ...bindingsState.map, [key]: next });
}

/** 解绑 */
export async function unbindTrack(key: string, mid: string): Promise<void> {
  const current = bindingsState.map[key] ?? [];
  const next = current.filter((item) => item.mid !== mid);
  const map = { ...bindingsState.map };
  if (next.length === 0) delete map[key];
  else map[key] = next;
  await persist(map);
}

/** 换歌单来源（短链 / 歌单页 / 纯数字 id 都行） */
export async function updatePlaylistSource(source: string): Promise<void> {
  await ensureMusicBindings();
  await persist(bindingsState.map, { playlistUrl: source.trim() });
}

// ── 播放 ─────────────────────────────────────────────────

/**
 * 在 QQ 音乐里打开（Electron 里会被转成系统浏览器 / 客户端）。
 * 返回 false = 被浏览器拦了新窗口（调用方要给出可点的备用入口）。
 */
export function openInQQ(track: MusicTrack): boolean {
  try {
    const win = window.open(songPageUrl(track.mid), '_blank', 'noopener,noreferrer');
    return !!win;
  } catch {
    return false;
  }
}

/**
 * 播放一首歌。
 *
 * 先问服务端拿不拿得到播放地址：拿得到就挂到 <audio> 上（代理流），
 * 拿不到（VIP 曲）就按需求「跳转并播放」—— 直接打开 QQ 音乐对应页。
 *
 * ⚠️ 歌单里已知 `vip` 的曲子要在**第一个 await 之前**跳转：浏览器只在用户手势的
 * 同一拍允许 window.open，等 checkPlayable 回来再跳会被当成弹窗拦掉。
 */
export async function playTrack(track: MusicTrack): Promise<void> {
  const el = getAudio();
  if (!el) return;

  // 点的是正在播的那首 → 当暂停/继续
  if (playerState.track?.mid === track.mid && el.src) {
    togglePlay();
    return;
  }

  // 已知会员曲、又没登录：在用户手势的同一拍直接跳，保住 window.open 的授权。
  // 登录过就不走这支——由下面的 playable 探测决定，能拿到 purl 就在应用内播。
  if (track.vip && !bindingsState.login.loggedIn) {
    const opened = openInQQ(track);
    setPlayer({
      track: null,
      loading: false,
      playing: false,
      error: opened
        ? `「${track.name}」是会员曲：粘一次 Cookie（候选框里的「登录」）就能在应用内播，这次先在 QQ 音乐打开`
        : `「${track.name}」是会员曲：点候选框里的「登录」粘一次 Cookie，就能在应用内播`,
    });
    return;
  }

  setPlayer({
    track,
    loading: true,
    playing: false,
    progress: 0,
    duration: track.interval ?? 0,
    error: null,
  });

  try {
    const result = await checkPlayable(track.mid);
    if (!result.playable) {
      /**
       * 未知会员状态的曲子（搜索结果没有 vip 标记）走到这里：
       * 尽力跳一次；被浏览器拦了就把话说明白，别留一条点了没反应的空播放条。
       */
      const opened = openInQQ(track);
      setPlayer({
        track: null,
        loading: false,
        playing: false,
        error: opened
          ? `${result.reason ?? '拿不到播放地址'}（已跳转）`
          : `${result.reason ?? '拿不到播放地址'}（点行尾的 ↗ 去 QQ 音乐）`,
      });
      return;
    }
    el.src = musicStreamUrl(track.mid);
    el.load();
    await el.play();
    setPlayer({ playing: true, loading: false });
  } catch (e) {
    setPlayer({
      loading: false,
      playing: false,
      error: e instanceof Error ? e.message : '播放失败',
    });
  }
}

export function togglePlay(): void {
  const el = getAudio();
  if (!el || !playerState.track) return;
  if (el.paused) {
    void el.play().catch(() => {
      setPlayer({ playing: false, error: '浏览器拦下了自动播放，再点一次播放键' });
    });
  } else {
    el.pause();
  }
}

/** 0~1 的进度 */
export function seekTo(ratio: number): void {
  const el = getAudio();
  if (!el) return;
  const total = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : playerState.duration;
  if (!total) return;
  el.currentTime = Math.max(0, Math.min(1, ratio)) * total;
}

export function stopPlayback(): void {
  const el = getAudio();
  if (el) {
    el.pause();
    el.removeAttribute('src');
    el.load();
  }
  setPlayer({ track: null, playing: false, loading: false, progress: 0, duration: 0, error: null });
}

export function clearPlayerError(): void {
  if (playerState.error) setPlayer({ error: null });
}
