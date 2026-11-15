/**
 * core/local-library — 本地番剧库的纯逻辑（不碰 fs、不发网络请求）
 *
 * 为什么要专门处理「目录名」：
 * Kazumi 把下载的番剧存成
 *
 *   <存储地址>/799_giriGiriLove/1/video.mp4
 *   <存储地址>/799_giriGiriLove/2/video.mp4
 *   ...
 *
 * 三个关键事实（实测 E:\kazhumi Anime 的 10 个目录全部吻合）：
 *   1. 目录名是 `{Bangumi subjectId}_{来源站}` —— 前面的数字**就是 Bangumi 番剧 ID**。
 *      拿它查 https://api.bgm.tv/v0/subjects/{id} 能直接拿到中日文名、封面、集数，
 *      所以「不知道是哪部番」这件事根本不用猜。
 *   2. 番剧目录下的子目录是**集号**（纯数字），文件统一叫 video.mp4。
 *      子目录不保证从 1 开始、也不保证连续（实测 50331 是 14~21），
 *      所以集数列表只能按磁盘上真实存在的文件生成，不能拿 Bangumi 的集数去推算。
 *   3. 空目录是常态（下载失败/被清理），扫描时要跳过，否则列表里全是死条目。
 *
 * 这里只放能单测的纯函数；文件系统与 Bangumi 请求都在 server/local-library.ts。
 */

/** 视频扩展名（尽量宽：用户可能从别处拷来 mkv/avi） */
const VIDEO_EXT = /\.(mp4|mkv|webm|avi|mov|m4v|ts|m2ts|flv|wmv|rmvb)$/i;

/**
 * HLS / DASH 分片：不是独立视频，而是**一集的一部分**。
 *
 * Kazumi 这类下载器把一集存成 `1/seg_00000.ts … 1/seg_00327.ts` + `playlist.m3u8`，
 * 每片几百 KB 到几 MB、几秒钟。如果按扩展名把它们当视频收进来，
 * 一部 6 集的番会变成 1774 个「集」，拉片分析只会对其中 7 秒的一个分片做分析
 * —— 这是实测踩到的坑（学生会也有洞！ 554779）。
 *
 * 正确用法是先用 `ffmpeg -i playlist.m3u8 -c copy out.mp4` 合并成整集；
 * 这里只负责**不要把分片当成集**，不替用户做合并（那是破坏性的写操作）。
 */
const HLS_SEGMENT = /^seg_?\d+\.(ts|m4s)$/i;

/** 一个「存储地址」（用户导入的根目录） */
export interface LocalSource {
  /** 绝对路径，如 E:\kazhumi Anime */
  path: string;
  /** 显示名，默认取目录名 */
  label: string;
  addedAt: string;
}

/** 单集 */
export interface LocalEpisode {
  /** 集号；解析不出来时退化为「第几个文件」 */
  number: number;
  /** 相对番剧目录的路径，如 `14/video.mp4` 或 `01.mp4` */
  relPath: string;
  /** 文件名（悬停提示用） */
  fileName: string;
  /** 字节数 */
  size: number;
}

/** Bangumi 元数据（缓存后离线也能显示） */
export interface LocalMeta {
  /** 原名（多为日文） */
  name: string;
  /** 中文名 */
  nameCn?: string;
  posterUrl?: string;
  /** Bangumi 标注的总集数 */
  totalEpisodes?: number;
  /** 放送日期 YYYY-MM-DD */
  airDate?: string;
  /** Bangumi 评分 */
  score?: number;
}

export type IdentifyState = 'ok' | 'unidentified' | 'failed';

/** 扫描出来的一个番剧目录 */
export interface LocalFolder {
  /** 番剧目录绝对路径 */
  dirPath: string;
  /** 目录名，如 `799_giriGiriLove` */
  dirName: string;
  /** 它所属的存储地址 */
  sourcePath: string;
  /** 从目录名解析出的 Bangumi subject id（Kazumi 结构才有） */
  bangumiId?: number;
  /** 目录名里 `_` 后面的来源站标记 */
  siteTag?: string;
  /** 磁盘上真实存在的集（已按集号排序） */
  episodes: LocalEpisode[];
  /** 没识别出来时用来兜底的标题 */
  guessedTitle: string;
  meta?: LocalMeta;
  identify: { state: IdentifyState; reason?: string };
}

/** 一部番 ↔ 本地目录的绑定 */
export interface LocalBinding {
  /** 绑定的番剧目录（同一部番可能从多个来源站各下了一份） */
  dirPaths: string[];
  boundAt: string;
  /** 上次看到第几集（卡片播放键直接续播用） */
  lastEpisode?: number;
}

/** 落盘结构 */
export interface LocalLibraryFile {
  version: 1;
  sources: LocalSource[];
  /** key = animeKeyFor(番剧)，与音乐绑定同一套「模板::标题」身份 */
  bindings: Record<string, LocalBinding>;
  /** Bangumi 元数据缓存，避免每次扫描都打一遍接口 */
  metaCache: Record<string, { meta: LocalMeta; fetchedAt: string }>;
  updatedAt: string;
}

export const LOCAL_LIBRARY_VERSION = 1 as const;

export function emptyLibrary(): LocalLibraryFile {
  return {
    version: LOCAL_LIBRARY_VERSION,
    sources: [],
    bindings: {},
    metaCache: {},
    updatedAt: new Date(0).toISOString(),
  };
}

export function isVideoFile(fileName: string): boolean {
  // HLS 分片先挡掉：它们是同一集的一部分，收进来会让"集数"变成几百
  if (HLS_SEGMENT.test(fileName)) return false;
  return VIDEO_EXT.test(fileName);
}

/**
 * 解析 Kazumi 的番剧目录名 `{subjectId}_{来源站}`。
 *
 * 只认「开头是纯数字 + 下划线」这一种；`葬送的芙莉莲` 这类普通目录名返回 null，
 * 由调用方退回「按目录名当标题」的模糊匹配。
 */
export function parseKazumiDirName(dirName: string): { bangumiId: number; siteTag: string } | null {
  const m = /^(\d{1,9})_(.+)$/.exec(dirName.trim());
  if (!m) return null;
  const id = Number(m[1]);
  // 0 和超长数字都不是合法的 subject id（Bangumi 目前是 1~7 位）
  if (!Number.isInteger(id) || id <= 0) return null;
  return { bangumiId: id, siteTag: m[2] };
}

/**
 * 从一段文字里抠集号。
 *
 * 顺序很重要：先去掉 `1080p` `x264` 这类噪声，否则 `[Sub] Title - 03 [1080p]` 会先命中 1080。
 * 认出这几种常见写法：纯数字（Kazumi 的子目录名）、`- 03`、`E03`/`EP03`、`第03话`、`[03]`。
 */
export function parseEpisodeNumber(text: string): number | null {
  const raw = (text || '').trim();
  if (!raw) return null;

  // 纯数字目录名：Kazumi 的主形态，最可靠
  if (/^\d{1,4}$/.test(raw)) return Number(raw);

  // 去噪：分辨率、编码、常见压制标记
  const cleaned = raw
    .replace(/\[[^\]]*\]|\([^)]*\)|【[^】]*】/g, ' ') // 方/圆/【】整块通常是组名、码率、字幕语言
    .replace(/\b\d{3,4}[pi]\b/gi, ' ') // 1080p / 720i
    .replace(/\b(4k|8k|uhd|x26[45]|h26[45]|hevc|avc|aac|flac|10bit|8bit|60fps)\b/gi, ' ');

  // 明确带标记的集号优先
  const marked = [
    /(?:^|[\s\-_—–])E(?:P)?\.?\s*(\d{1,4})\b/i, // - E03 / EP03
    /第\s*(\d{1,4})\s*[话話集回]/,
    /(?:^|[\s\-_—–])(\d{1,4})\s*[话話集回]/,
    /(?:^|[\s\-_—–])\[(\d{1,4})\](?=\s*$)/,
    /(?:^|[\s\-_—–])(\d{1,4})(?=\s*(?:$|\.\w+$|[\s\-_—–]|v\d))/i,
  ];
  for (const re of marked) {
    const m = re.exec(cleaned);
    if (m) {
      const n = Number(m[1]);
      if (n > 0 && n < 10000) return n;
    }
  }

  // 最后的兜底：整串里唯一的孤立数字
  const loose = cleaned.match(/(?:^|[^\d])(\d{1,4})(?![\d])/g);
  if (loose && loose.length === 1) {
    const n = Number(loose[0].replace(/[^\d]/g, ''));
    if (n > 0 && n < 10000) return n;
  }
  return null;
}

/**
 * 自然排序：`1,2,3,10,11` 而不是 `1,10,11,2`。
 * 直接字符串排序会让第 10 集排在第 2 集前面，选集条会乱成一团。
 */
export function naturalCompare(a: string, b: string): number {
  const ax = a.match(/(\d+|\D+)/g) ?? [a];
  const bx = b.match(/(\d+|\D+)/g) ?? [b];
  const len = Math.min(ax.length, bx.length);
  for (let i = 0; i < len; i++) {
    const x = ax[i];
    const y = bx[i];
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return ax.length - bx.length;
}

/**
 * 目录名 → 兜底标题。
 * `799_giriGiriLove` 去掉前缀后其实只剩来源站名，不能当番名，
 * 所以对 Kazumi 结构**不给标题**（等 Bangumi 元数据），只有普通目录名才用。
 */
export function guessTitleFromDirName(dirName: string): string {
  const parsed = parseKazumiDirName(dirName);
  if (parsed) return ''; // 交给 Bangumi 识别，别拿 "giriGiriLove" 当番名
  return dirName.replace(/[\[\]【】]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * 把扫描到的「文件列表」组装成集数列表。
 *
 * 规则：
 *   - 有子目录且视频在子目录里（Kazumi）：集号取子目录名；
 *   - 视频直接躺在一级目录（自己整理的库）：集号取文件名；
 *   - 同一集号出现多个文件（比如同时有 01.mp4 和 01.ass）只保留视频，重复时保留大的那个。
 */
export function buildEpisodes(entries: Array<{ relPath: string; fileName: string; size: number }>): LocalEpisode[] {
  const byNumber = new Map<number, LocalEpisode>();
  let fallback = 0;

  for (const entry of entries) {
    if (!isVideoFile(entry.fileName)) continue;
    const parts = entry.relPath.split('/');
    // 优先用「离文件最近的那层目录」当集号：Kazumi 是 <集号>/video.mp4
    const dirCandidate = parts.length > 1 ? parts[parts.length - 2] : '';
    const number =
      parseEpisodeNumber(dirCandidate) ??
      parseEpisodeNumber(entry.fileName.replace(/\.[^.]+$/, '')) ??
      ++fallback;

    const episode: LocalEpisode = {
      number,
      relPath: entry.relPath,
      fileName: entry.fileName,
      size: entry.size,
    };
    const existing = byNumber.get(number);
    // 同集号冲突：留体积大的那个（正片 vs 花絮/样片）
    if (!existing || episode.size > existing.size) byNumber.set(number, episode);
  }

  return Array.from(byNumber.values()).sort((a, b) => a.number - b.number);
}

/** 集数展示文案：不是整数（如 1.5 的总集篇）就原样显示 */
export function formatEpisodeNumber(n: number): string {
  return Number.isFinite(n) ? String(n) : '—';
}

/** 播放地址的集标题：`第 14 集` */
export function episodeLabel(n: number): string {
  return `第 ${formatEpisodeNumber(n)} 集`;
}

/** 目录名是否存在重复来源（同一 subjectId 多个站）—— 用于设置页提示 */
export function groupByBangumiId(folders: LocalFolder[]): Map<number, LocalFolder[]> {
  const map = new Map<number, LocalFolder[]>();
  for (const folder of folders) {
    if (!folder.bangumiId) continue;
    const list = map.get(folder.bangumiId) ?? [];
    list.push(folder);
    map.set(folder.bangumiId, list);
  }
  return map;
}
