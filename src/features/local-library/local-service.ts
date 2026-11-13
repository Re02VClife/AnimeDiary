/**
 * features/local-library/local-service — 「本地番剧库」的 HTTP 客户端
 *
 * 所有路径与扫描结果都在服务端（server/local-library.ts），前端只拿 JSON。
 * 视频播放也走同一个 /api（而不是 file://）：dev 模式页面是 http://localhost:5173，
 * 浏览器不会把 file:// 当同源资源交给 <video>；走 /api 才有 Range 与白名单校验。
 */
import type { LocalBinding, LocalFolder, LocalSource } from '../../../core/local-library';

export interface LibraryPayload {
  sources: LocalSource[];
  folders: LocalFolder[];
  bindings: Record<string, LocalBinding>;
}

async function readJson<T>(resp: Response): Promise<T> {
  const text = await resp.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(text.slice(0, 200) || `HTTP ${resp.status}`);
  }
}

export async function fetchLibrary(opts: { identify?: boolean; force?: boolean } = {}): Promise<LibraryPayload> {
  const params = new URLSearchParams();
  if (opts.identify) params.set('identify', '1');
  if (opts.force) params.set('force', '1');
  const qs = params.toString();
  const resp = await fetch(`/api/local/library${qs ? `?${qs}` : ''}`);
  if (!resp.ok) {
    const body = await readJson<{ error?: string }>(resp).catch(() => ({ error: `HTTP ${resp.status}` }));
    throw new Error(body.error || `扫描失败（HTTP ${resp.status}）`);
  }
  return readJson<LibraryPayload>(resp);
}

export async function addSource(path: string): Promise<{ ok: boolean; sources: LocalSource[]; error?: string }> {
  const resp = await fetch('/api/local/sources', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'add', path }),
  });
  return readJson(resp);
}

export async function removeSource(path: string): Promise<{ ok: boolean; sources: LocalSource[]; error?: string }> {
  const resp = await fetch('/api/local/sources', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'remove', path }),
  });
  return readJson(resp);
}

export async function saveBinding(key: string, dirPaths: string[]): Promise<Record<string, LocalBinding>> {
  const resp = await fetch('/api/local/bind', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, dirPaths }),
  });
  const body = await readJson<{ bindings?: Record<string, LocalBinding>; error?: string }>(resp);
  if (!resp.ok) throw new Error(body.error || `保存绑定失败（HTTP ${resp.status}）`);
  return body.bindings ?? {};
}

/** 记住看到第几集；失败不打断播放，所以调用方可以 fire-and-forget */
export async function saveProgress(key: string, episode: number): Promise<void> {
  await fetch('/api/local/progress', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, episode }),
  }).catch(() => undefined);
}

/** 视频流地址（<video src> 直接用） */
export function streamUrl(dir: string, rel: string): string {
  return `/api/local/stream?dir=${encodeURIComponent(dir)}&rel=${encodeURIComponent(rel)}`;
}

// ── 播放进度（本地记忆，秒级）─────────────────────────────
//
// 只存在 localStorage 里：进度是「观感」不是「数据」，没必要写服务端 JSON，
// 更不该进 Excel。key 用 目录+相对路径，文件被换掉不会串到别的集上。

const PROGRESS_PREFIX = 'anime_diary_local_progress:';

export interface EpisodeProgress {
  /** 已播秒数 */
  time: number;
  /** 总时长（秒），用于算「看完了没有」 */
  duration: number;
  updatedAt: string;
}

function progressKey(dir: string, rel: string): string {
  return `${PROGRESS_PREFIX}${dir}::${rel}`;
}

export function loadProgress(dir: string, rel: string): EpisodeProgress | null {
  try {
    const raw = window.localStorage.getItem(progressKey(dir, rel));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as EpisodeProgress;
    return Number.isFinite(parsed?.time) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveProgressTime(dir: string, rel: string, time: number, duration: number): void {
  if (!Number.isFinite(time) || time < 1) return;
  try {
    window.localStorage.setItem(
      progressKey(dir, rel),
      JSON.stringify({ time, duration: Number.isFinite(duration) ? duration : 0, updatedAt: new Date().toISOString() }),
    );
  } catch {
    /* 存不进去只影响下次续播 */
  }
}

export function clearProgress(dir: string, rel: string): void {
  try {
    window.localStorage.removeItem(progressKey(dir, rel));
  } catch {
    /* ignore */
  }
}

/**
 * 「看完了」判定：总时长已知就要求过了 92%，否则按已播 20 分钟算。
 * 片尾曲通常在 90% 之后，卡在 92% 能避开"片尾没看完就被当没看"。
 */
export function isEpisodeFinished(progress: EpisodeProgress | null): boolean {
  if (!progress) return false;
  if (progress.duration > 0) return progress.time / progress.duration >= 0.92;
  return progress.time >= 20 * 60;
}
