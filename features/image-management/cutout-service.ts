/**
 * 角色立绘去白底：前端服务层。
 *
 * 分工：
 *   core/white-background.ts  纯像素算法（不依赖 DOM，可单测）
 *   本文件                     Canvas 解码/编码 + 与服务端存取
 *   server/api-routes.ts       /api/images/cutout/{save,delete,index}
 *
 * 去底结果落成与 cover.jpg **并列**的 cover-nobg.png，不改 Excel、不覆盖原图。
 * 卡片渲染时只判断「这个目录有没有 cover-nobg.png」决定用哪张，
 * 所以整套功能可以随文件随时增删，没有任何数据被改写。
 */
import {
  removeWhiteBackground,
  describeCutoutQuality,
  type RemoveBackgroundOptions,
  type RemoveBackgroundStats,
} from '../../core/white-background';

/** 去底产物的固定文件名，必须与服务端 CUTOUT_FILE_NAME 一致 */
export const CUTOUT_FILE_NAME = 'cover-nobg.png';

export interface CutoutResult {
  dataUrl: string;
  width: number;
  height: number;
  stats: RemoveBackgroundStats;
  /** 中文质量提示；空数组 = 处理得很干净 */
  hints: string[];
}

// ── 索引缓存 ──
// 卡片网格里每张卡都要判断「有没有去底图」，逐张发请求会打爆服务端，
// 所以启动时拉一次全量索引常驻内存，保存/撤销后主动失效。

let indexCache: Set<string> | null = null;
let inflight: Promise<Set<string>> | null = null;
const listeners = new Set<() => void>();

/** 拉取「哪些目录已有去底图」。默认走缓存；force 用于强制刷新 */
export async function loadCutoutIndex(force = false): Promise<Set<string>> {
  if (!force && indexCache) return indexCache;
  if (!force && inflight) return inflight;
  inflight = (async () => {
    try {
      const resp = await fetch('/api/images/cutout/index');
      const data = await resp.json();
      indexCache = new Set<string>(Array.isArray(data?.names) ? data.names : []);
    } catch {
      // 服务端不可达时退化成「没有任何去底图」，界面显示原图即可，不该报错
      indexCache = new Set<string>();
    } finally {
      inflight = null;
    }
    return indexCache;
  })();
  return inflight;
}

/** 读同步缓存（可能尚未加载完，此时返回空集合） */
export function getCachedCutoutIndex(): Set<string> {
  return indexCache ?? new Set<string>();
}

/** 保存/撤销后调用：清缓存并通知已挂载的界面重新渲染 */
export function invalidateCutoutIndex(): void {
  indexCache = null;
  for (const l of listeners) l();
}

export function subscribeCutoutIndex(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// ── URL 判定与替换 ──

const IMAGE_FILE_RE = /\/api\/images\/file\?anime=([^&]+)&file=([^&]+)/;
const COVER_FILE_RE = /^cover\.(jpe?g|png|webp)$/i;

/** 从本地图片 URL 里取出目录名（= 保存时的角色名/番剧名）；非本地图片返回 null */
export function imageDirFromUrl(url: string): string | null {
  const m = url.match(IMAGE_FILE_RE);
  return m ? decodeURIComponent(m[1]) : null;
}

/** 与服务端一致的目录名规则（Windows 非法字符替换为 _） */
export function toImageDirName(title: string): string {
  return title.replace(/[\\/:*?"<>|]/g, '_').trim();
}

/**
 * 该条目的去底图应该写进哪个目录。
 *
 * 必须跟**海报实际所在的目录**一致，不能用标题 —— 实测「蕾娜」的海报
 * 存在 `86 不存在的战区 part1/cover.jpg` 下，若按标题写进 `蕾娜/`，
 * 卡片渲染时按 URL 里的目录名查索引就永远查不到，去底图白做。
 */
export function cutoutDirFor(posterUrl: string, title: string): string {
  return imageDirFromUrl(posterUrl) || toImageDirName(title);
}

/**
 * 该海报若有去底版则替换成去底版。
 *
 * 两条保护：目录必须真的在索引里；原文件必须正好是 cover.*，
 * 否则会把用户自己截图当海报的情况（{名}_1.png）也换掉。
 */
export function applyCutout(posterUrl: string, cutoutNames: Set<string>): string {
  if (!posterUrl) return posterUrl;
  const m = posterUrl.match(IMAGE_FILE_RE);
  if (!m) return posterUrl;
  const dir = decodeURIComponent(m[1]);
  const file = decodeURIComponent(m[2]);
  if (!cutoutNames.has(dir)) return posterUrl;
  if (!COVER_FILE_RE.test(file)) return posterUrl;
  return `/api/images/file?anime=${encodeURIComponent(dir)}&file=${encodeURIComponent(CUTOUT_FILE_NAME)}`;
}

// ── 处理与存取 ──

function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('立绘加载失败，可能文件已被移动或删除'));
    img.src = url;
  });
}

/**
 * 用 Canvas 跑一遍去底，返回 PNG data URL。
 *
 * 不设 img.crossOrigin：本项目的海报都是本地 /api/images/file 同源地址，
 * 设了反而会让不支持 CORS 的外链加载失败。外链图会因画布污染在
 * toDataURL 处抛错，这里翻译成人话提示用户先本地化。
 */
export async function createCutout(
  posterUrl: string,
  options?: RemoveBackgroundOptions,
): Promise<CutoutResult> {
  const img = await loadImageElement(posterUrl);
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  if (!width || !height) throw new Error('立绘尺寸异常，无法处理');

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('当前环境不支持 Canvas，无法去底');
  ctx.drawImage(img, 0, 0);

  const imageData = ctx.getImageData(0, 0, width, height);
  const stats = removeWhiteBackground(imageData, options);
  ctx.putImageData(imageData, 0, 0);

  let dataUrl: string;
  try {
    dataUrl = canvas.toDataURL('image/png');
  } catch {
    throw new Error('该海报是外部链接，浏览器不允许读取像素；请先把海报保存到本地再去底');
  }
  return { dataUrl, width, height, stats, hints: describeCutoutQuality(stats) };
}

/** 保存去底图，返回可直接用于 <img> 的本地 URL。dirName 用 cutoutDirFor 求得 */
export async function saveCutout(dirName: string, dataUrl: string): Promise<string> {
  const resp = await fetch('/api/images/cutout/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ animeTitle: dirName, dataUrl }),
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok || !data || !data.success) {
    throw new Error((data && data.error) || `保存失败 HTTP ${resp.status}`);
  }
  invalidateCutoutIndex();
  return data.url as string;
}

/** 撤销去底（只删派生的 PNG，原图不动） */
export async function removeCutout(dirName: string): Promise<void> {
  const resp = await fetch('/api/images/cutout/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ animeTitle: dirName }),
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok || !data || !data.success) {
    throw new Error((data && data.error) || `撤销失败 HTTP ${resp.status}`);
  }
  invalidateCutoutIndex();
}

// ── AI 抠图（服务端 isnet-anime 推理）──
//
// 与洪泛的分工：洪泛在渲染进程用 Canvas 算，快（0.1s/张）但对
// 「背景不是一整片白」的图无能为力；AI 在主进程做原生推理（约 0.5s/张），
// 实景背景、拼贴图、装饰边框都能处理。两条路的结果文件完全一样，
// 可以混着用，也可以随时互相覆盖。

export type CutoutEngine = 'flood' | 'ai';

export interface AiCutoutStatus {
  ready: boolean;
  modelFile: string;
  modelMB: number;
  modelPath: string;
  runtimeReady: boolean;
  runtimePath: string;
  error?: string;
}

export interface AiCutoutResult {
  /** 暂存文件的预览 URL（已带时间戳，避免命中 24h 缓存） */
  url: string;
  width: number;
  height: number;
  bytes: number;
  inferenceMs: number;
  transparentRatio: number;
  opaqueRatio: number;
}

/** 预览 URL 加时间戳：/api/images/file 带 24h 缓存，暂存文件每次都是新内容 */
function withCacheBust(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`;
}

export async function loadAiStatus(): Promise<AiCutoutStatus | null> {
  try {
    const resp = await fetch('/api/images/cutout/ai-status');
    if (!resp.ok) return null;
    return (await resp.json()) as AiCutoutStatus;
  } catch {
    // 服务端不可达就当作不可用，界面自动退回洪泛，不该弹错
    return null;
  }
}

/**
 * 让服务端跑一次 AI 抠图。
 * 结果落在 cover-nobg.preview.png 而不是正式文件 —— 保持「先看再应用」，
 * 未确认的结果不会出现在卡片上。
 */
export async function aiCutout(dirName: string, fileName: string): Promise<AiCutoutResult> {
  const resp = await fetch('/api/images/cutout/ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ animeTitle: dirName, fileName }),
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok || !data || !data.success) {
    throw new Error((data && data.error) || `AI 抠图失败 HTTP ${resp.status}`);
  }
  return {
    url: withCacheBust(String(data.url)),
    width: Number(data.width),
    height: Number(data.height),
    bytes: Number(data.bytes),
    inferenceMs: Number(data.inferenceMs),
    transparentRatio: Number(data.transparentRatio),
    opaqueRatio: Number(data.opaqueRatio),
  };
}

/** 暂存结果转正 / 丢弃（转正只是同目录改名，不重新推理） */
export async function applyAiCutout(dirName: string, action: 'apply' | 'discard'): Promise<void> {
  const resp = await fetch('/api/images/cutout/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ animeTitle: dirName, action }),
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok || !data || !data.success) {
    throw new Error((data && data.error) || `操作失败 HTTP ${resp.status}`);
  }
  invalidateCutoutIndex();
}

/**
 * AI 结果的质量提示。
 * AI 极少给出「没抠掉」的结果，所以判据与洪泛不同：只看透明面积是否异常小。
 */
export function describeAiQuality(r: AiCutoutResult): string[] {
  return r.transparentRatio < 0.05
    ? [`只移除了 ${(r.transparentRatio * 100).toFixed(1)}% 的背景，建议对照原图确认`]
    : [];
}
