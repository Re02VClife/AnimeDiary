/**
 * features/music/music-service — 前端侧的 QQ 音乐接口封装
 *
 * 全部走相对 `/api/music/*`（dev 由 Vite 插件、prod 由 Electron 本地服务承接），
 * 前端不直接连腾讯 —— 否则 CORS 和防盗链两道墙都过不去。
 */
import type {
  MusicPlaylist,
  MusicStoreFile,
  MusicTrack,
} from '../../core/music-links';
import { DEFAULT_PLAYLIST_URL, emptyMusicStore } from '../../core/music-links';

export type { MusicPlaylist, MusicTrack, MusicStoreFile };

async function readJson<T>(resp: Response): Promise<T> {
  const text = await resp.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!resp.ok) {
    const message = data?.error || data?.reason || text || `请求失败（${resp.status}）`;
    throw new Error(String(message).slice(0, 300));
  }
  if (!data) throw new Error('服务返回了空响应');
  return data as T;
}

/** 拉歌单；refresh=true 跳过服务端 6 小时缓存 */
export async function fetchPlaylist(source?: string, refresh = false): Promise<MusicPlaylist> {
  const qs = new URLSearchParams();
  if (source && source.trim()) qs.set('source', source.trim());
  if (refresh) qs.set('refresh', '1');
  const resp = await fetch(`/api/music/playlist?${qs.toString()}`);
  const data = await readJson<{ playlist: MusicPlaylist }>(resp);
  return data.playlist;
}

/** 搜索（结果较少，只用于「歌单里没有」的补充） */
export async function searchMusic(keyword: string): Promise<MusicTrack[]> {
  const qs = new URLSearchParams({ q: keyword });
  const resp = await fetch(`/api/music/search?${qs.toString()}`);
  const data = await readJson<{ tracks: MusicTrack[] }>(resp);
  return data.tracks ?? [];
}

/** 粘贴 QQ 音乐歌曲链接 / songmid → 曲目信息 */
export async function resolveMusicLink(input: string): Promise<MusicTrack> {
  const resp = await fetch('/api/music/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: input }),
  });
  const data = await readJson<{ track: MusicTrack }>(resp);
  return data.track;
}

export interface PlayableResult {
  playable: boolean;
  vip: boolean;
  reason?: string;
}

/** 能不能在应用内播（VIP 曲会返回 playable=false，前端据此跳 QQ 音乐） */
export async function checkPlayable(mid: string): Promise<PlayableResult> {
  const qs = new URLSearchParams({ mid });
  const resp = await fetch(`/api/music/playurl?${qs.toString()}`);
  return readJson<PlayableResult>(resp);
}

/** 音频代理地址（<audio src> 直接用） */
export function musicStreamUrl(mid: string): string {
  return `/api/music/stream?mid=${encodeURIComponent(mid)}`;
}

export interface MusicStorePayload {
  settings: { playlistUrl: string };
  bindings: Record<string, any[]>;
}

/** 读绑定表（服务端文件不存在时返回空结构） */
export async function loadMusicStore(): Promise<MusicStoreFile> {
  const resp = await fetch('/api/music/store');
  const data = await readJson<{ store: MusicStoreFile }>(resp);
  return data.store ?? emptyMusicStore();
}

/** 整份写回绑定表 */
export async function saveMusicStore(payload: MusicStorePayload): Promise<MusicStoreFile> {
  const resp = await fetch('/api/music/store', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await readJson<{ store: MusicStoreFile }>(resp);
  return data.store;
}

export { DEFAULT_PLAYLIST_URL };
