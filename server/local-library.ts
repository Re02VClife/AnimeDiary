/**
 * server/local-library — 本地番剧库：扫描存储地址、识别番剧、绑定、流式播放
 *
 * 数据落在 `{DATA_DIR}/local-library.json`，**不碰 Excel**：
 * 「这部番的文件夹在哪」是这台机器的路径，不属于评分数据，
 * 写进 Excel 会让表格换台机器就带一堆失效路径。
 *
 * 识别方案（核心）：Kazumi 的目录名是 `{Bangumi subjectId}_{来源站}`，
 * 例如 `799_giriGiriLove`。所以识别不是"猜名字"，而是**拿 ID 直接查 Bangumi**：
 * `GET https://api.bgm.tv/v0/subjects/799` → 中文名 / 日文名 / 封面 / 集数 / 放送日。
 * 实测 E:\kazhumi Anime 下 10 个目录 9 个有内容，ID 全部命中（第 10 个是空目录）。
 *
 * 请求走调用方注入的 fetchImpl：Electron 传的是 `net.fetch`，
 * 会遵守系统代理 —— Node 全局 fetch 不读系统代理，打包后直连 api.bgm.tv 会超时。
 */
import fs from 'fs';
import path from 'path';
import {
  LOCAL_LIBRARY_VERSION,
  buildEpisodes,
  emptyLibrary,
  guessTitleFromDirName,
  isVideoFile,
  parseKazumiDirName,
} from '../core/local-library';
import type {
  LocalBinding,
  LocalFolder,
  LocalLibraryFile,
  LocalMeta,
  LocalSource,
} from '../core/local-library';
import type { FetchLike } from './media-sources';
import { createProxyAwareFetch } from './proxy-fetch';

const BANGUMI_API = 'https://api.bgm.tv';
const LIBRARY_FILE = 'local-library.json';
/** Bangumi 要求带可识别的 UA，缺失会 403（与 media-sources 的 UA 池保持一致的风格） */
const UA = 'AnimeDiary/1.0 (https://github.com/anime-diary; personal anime scoring app)';

/** 单个番剧目录最多走几层（Kazumi 是 2 层；自己整理的库常见 1~3 层） */
const MAX_DEPTH = 3;
/** 单个番剧目录最多看多少个文件（防止误把整块盘当番剧目录扫） */
const MAX_FILES = 3000;
/** 元数据缓存 7 天：番名/封面基本不变，过期后重扫会刷新 */
const META_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface LocalLibraryOptions {
  DATA_DIR: string;
  fetchImpl?: FetchLike;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 串行节流：Bangumi 对匿名请求有速率限制，十几个目录并发会直接 429。
 * 350ms 间隔 + 缓存，全量重扫一屏目录也就几秒。
 */
function createThrottle(minIntervalMs: number) {
  let queue: Promise<unknown> = Promise.resolve();
  let nextAllowed = 0;
  return function acquire(): Promise<void> {
    const task = queue.then(async () => {
      const wait = Math.max(0, nextAllowed - Date.now());
      if (wait > 0) await sleep(wait);
      nextAllowed = Date.now() + minIntervalMs;
    });
    queue = task.catch(() => undefined);
    return task;
  };
}

/** Windows 下路径比较不区分大小写 */
function normalizeForCompare(p: string): string {
  return path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
}

/** b 是否就是 a，或在 a 里面（用于「只允许访问配置过的存储地址」） */
function isInside(parent: string, child: string): boolean {
  const p = normalizeForCompare(parent);
  const c = normalizeForCompare(child);
  return c === p || c.startsWith(p + path.sep) || c.startsWith(p + '/');
}

export function createLocalLibrary({ DATA_DIR, fetchImpl }: LocalLibraryOptions) {
  const FILE = path.join(DATA_DIR, LIBRARY_FILE);
  const bangumiThrottle = createThrottle(350);
  /**
   * 网络出口：生产由 api-server 注入 net.fetch（Chromium 网络栈，走系统代理）；
   * dev 模式没有注入，此时用 proxy-fetch 读系统代理 —— 全局 fetch 不读代理，
   * 而 api.bgm.tv 在境内会被 DNS 污染，直连必然超时。
   */
  const httpFetch: FetchLike = fetchImpl ?? createProxyAwareFetch();

  // ── 落盘 ────────────────────────────────────────────────

  function read(): LocalLibraryFile {
    try {
      if (!fs.existsSync(FILE)) return emptyLibrary();
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
      if (!raw || typeof raw !== 'object') return emptyLibrary();
      return {
        version: LOCAL_LIBRARY_VERSION,
        sources: Array.isArray(raw.sources) ? raw.sources : [],
        bindings: raw.bindings && typeof raw.bindings === 'object' ? raw.bindings : {},
        metaCache: raw.metaCache && typeof raw.metaCache === 'object' ? raw.metaCache : {},
        updatedAt: String(raw.updatedAt || new Date(0).toISOString()),
      };
    } catch {
      // 文件损坏不该让整个「本地」面板打不开，退回空库由下次保存覆盖
      return emptyLibrary();
    }
  }

  function write(next: LocalLibraryFile): LocalLibraryFile {
    const payload: LocalLibraryFile = {
      ...next,
      version: LOCAL_LIBRARY_VERSION,
      updatedAt: new Date().toISOString(),
    };
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${FILE}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8');
      fs.renameSync(tmp, FILE);
    } catch (e) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
      throw e;
    }
    return payload;
  }

  // ── 存储地址管理 ─────────────────────────────────────────

  function listSources(): LocalSource[] {
    return read().sources;
  }

  /** 加一个存储地址；已经加过（同一路径）就直接返回现有记录 */
  function addSource(rawPath: string): { ok: boolean; source?: LocalSource; error?: string } {
    const input = String(rawPath || '').trim().replace(/^["']|["']$/g, '');
    if (!input) return { ok: false, error: '路径为空' };
    const resolved = path.resolve(input);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      return { ok: false, error: '这个路径不存在' };
    }
    if (!stat.isDirectory()) return { ok: false, error: '这不是文件夹（要填放番剧的目录）' };

    const file = read();
    const exists = file.sources.find((s) => normalizeForCompare(s.path) === normalizeForCompare(resolved));
    if (exists) return { ok: true, source: exists };

    const source: LocalSource = {
      path: resolved,
      label: path.basename(resolved) || resolved,
      addedAt: new Date().toISOString(),
    };
    file.sources.push(source);
    write(file);
    return { ok: true, source };
  }

  /** 删除存储地址；同时清掉指向这个地址下目录的绑定，避免留下死链接 */
  function removeSource(rawPath: string): { ok: boolean; removed: number; error?: string } {
    const target = normalizeForCompare(rawPath);
    const file = read();
    const before = file.sources.length;
    file.sources = file.sources.filter((s) => normalizeForCompare(s.path) !== target);
    const removed = before - file.sources.length;
    if (removed === 0) return { ok: false, removed: 0, error: '没有这个存储地址' };

    // 被删地址下的目录不再合法，从绑定里摘掉；摘空的绑定直接删除
    const stillValid = (dirPath: string) => file.sources.some((s) => isInside(s.path, dirPath));
    for (const key of Object.keys(file.bindings)) {
      const binding = file.bindings[key];
      const kept = (binding.dirPaths || []).filter((d) => stillValid(d));
      if (kept.length === 0) {
        delete file.bindings[key];
      } else if (kept.length !== binding.dirPaths.length) {
        file.bindings[key] = { ...binding, dirPaths: kept };
      }
    }
    write(file);
    return { ok: true, removed };
  }

  // ── 扫描 ─────────────────────────────────────────────────

  /**
   * 递归收集视频文件（相对番剧目录的路径）。
   * 深度和数量都设上限：如果用户误把 `E:\` 当存储地址，这里不能真的去遍历整块盘。
   */
  function collectVideos(rootDir: string): Array<{ relPath: string; fileName: string; size: number }> {
    const out: Array<{ relPath: string; fileName: string; size: number }> = [];

    const walk = (dir: string, depth: number, relBase: string) => {
      if (out.length >= MAX_FILES) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return; // 权限不足 / 正在被删 —— 跳过这一支
      }
      for (const entry of entries) {
        if (out.length >= MAX_FILES) return;
        const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (depth < MAX_DEPTH) walk(path.join(dir, entry.name), depth + 1, rel);
        } else if (entry.isFile() && isVideoFile(entry.name)) {
          let size = 0;
          try { size = fs.statSync(path.join(dir, entry.name)).size; } catch { /* 拿不到大小不影响播放 */ }
          out.push({ relPath: rel, fileName: entry.name, size });
        }
      }
    };

    walk(rootDir, 0, '');
    return out;
  }

  /** 扫一个存储地址下的一级子目录，每个子目录视作一部番 */
  function scanSource(source: LocalSource): LocalFolder[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(source.path, { withFileTypes: true });
    } catch {
      return [];
    }

    const folders: LocalFolder[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = path.join(source.path, entry.name);
      const videos = collectVideos(dirPath);
      const episodes = buildEpisodes(videos);
      // 空目录（Kazumi 下载失败/被清理）直接跳过，列表里不留死条目
      if (episodes.length === 0) continue;

      const parsed = parseKazumiDirName(entry.name);
      folders.push({
        dirPath,
        dirName: entry.name,
        sourcePath: source.path,
        bangumiId: parsed?.bangumiId,
        siteTag: parsed?.siteTag,
        episodes,
        guessedTitle: guessTitleFromDirName(entry.name),
        identify: { state: 'unidentified', reason: parsed ? '还没识别' : '目录名里没有 Bangumi ID' },
      });
    }
    return folders;
  }

  function scanAll(): LocalFolder[] {
    const file = read();
    const folders: LocalFolder[] = [];
    for (const source of file.sources) folders.push(...scanSource(source));

    // 补缓存里的元数据：命中缓存立刻变成已识别，没缓存的是待识别
    for (const folder of folders) {
      if (!folder.bangumiId) continue;
      const cached = file.metaCache[String(folder.bangumiId)];
      if (cached?.meta) {
        folder.meta = cached.meta;
        folder.identify = { state: 'ok' };
      }
    }
    return folders;
  }

  // ── Bangumi 识别 ─────────────────────────────────────────

  async function fetchSubject(id: number): Promise<LocalMeta | null> {
    await bangumiThrottle();
    const resp = await httpFetch(`${BANGUMI_API}/v0/subjects/${id}`, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json',
        'Accept-Language': 'zh-CN,zh;q=0.9,ja;q=0.8',
      },
    });
    if (!resp.ok) {
      if (resp.status === 404) return null; // ID 不存在：不是网络问题
      throw new Error(`Bangumi HTTP ${resp.status}`);
    }
    const json = (await resp.json()) as any;
    if (!json || typeof json !== 'object') return null;

    const images = json.images || {};
    return {
      name: String(json.name || '').trim(),
      nameCn: String(json.name_cn || '').trim() || undefined,
      posterUrl: String(images.large || images.common || images.medium || '').trim() || undefined,
      totalEpisodes: Number(json.total_episodes || json.eps || 0) || undefined,
      airDate: String(json.date || '').trim() || undefined,
      score: Number(json.rating?.score) || undefined,
    };
  }

  /**
   * 补齐元数据（带磁盘缓存）。
   * 返回补过 meta 的目录列表；失败的目录保留 `identify.state='failed'`,
   * 让设置页能把它们单独列出来，而不是静默消失。
   */
  async function identify(folders: LocalFolder[], force = false): Promise<LocalFolder[]> {
    const file = read();
    let dirty = false;

    for (const folder of folders) {
      if (!folder.bangumiId) continue;
      if (folder.meta && !force) continue; // scanAll 已经从缓存里填过

      const cacheKey = String(folder.bangumiId);
      const cached = file.metaCache[cacheKey];
      const fresh =
        cached?.meta &&
        !force &&
        Date.now() - new Date(cached.fetchedAt).getTime() < META_TTL_MS;

      if (fresh) {
        folder.meta = cached.meta;
        folder.identify = { state: 'ok' };
        continue;
      }

      try {
        const meta = await fetchSubject(folder.bangumiId);
        if (meta && (meta.name || meta.nameCn)) {
          folder.meta = meta;
          folder.identify = { state: 'ok' };
          file.metaCache[cacheKey] = { meta, fetchedAt: new Date().toISOString() };
          dirty = true;
        } else {
          // 404：ID 在 Bangumi 上查不到（多半是目录名被改过），交给标题兜底
          folder.identify = { state: 'unidentified', reason: `Bangumi 上没有 ${folder.bangumiId} 号条目` };
        }
      } catch (e) {
        folder.identify = {
          state: 'failed',
          reason: e instanceof Error ? e.message : '识别失败',
        };
      }
    }

    if (dirty) write(file);
    return folders;
  }

  // ── 绑定 ─────────────────────────────────────────────────

  function getBindings(): Record<string, LocalBinding> {
    return read().bindings;
  }

  /** 设置一部番的绑定目录（传空数组等于解绑） */
  function setBinding(key: string, dirPaths: string[]): Record<string, LocalBinding> {
    const file = read();
    const valid = (dirPaths || []).filter((d) => typeof d === 'string' && d.trim());
    if (valid.length === 0) {
      delete file.bindings[key];
    } else {
      const prev = file.bindings[key];
      file.bindings[key] = {
        dirPaths: valid,
        boundAt: prev?.boundAt ?? new Date().toISOString(),
        lastEpisode: prev?.lastEpisode,
      };
    }
    return write(file).bindings;
  }

  /** 记住看到第几集（卡片上的播放键据此续播） */
  function setProgress(key: string, lastEpisode: number): LocalBinding | null {
    const file = read();
    const binding = file.bindings[key];
    if (!binding) return null;
    binding.lastEpisode = lastEpisode;
    write(file);
    return binding;
  }

  // ── 播放 ─────────────────────────────────────────────────

  /**
   * 把 (目录, 相对路径) 解析成真实文件，并验证它确实在某个**已配置**的存储地址里。
   *
   * 两道校验缺一不可：
   *   1. dir 必须在某个 source 之下 —— 否则这个接口就成了任意路径读取器；
   *   2. rel 解析后必须还在 dir 之内 —— 防 `../../` 跳出番剧目录。
   */
  function resolveEpisode(dir: string, rel: string): { filePath: string } | { error: string; status: number } {
    const file = read();
    const dirPath = path.resolve(String(dir || ''));
    if (!dirPath) return { error: '缺少 dir', status: 400 };

    const allowed = file.sources.some((s) => isInside(s.path, dirPath));
    if (!allowed) return { error: '这个目录不在已导入的存储地址里', status: 403 };
    if (!isInside(dirPath, path.resolve(dirPath, String(rel || '')))) {
      return { error: '非法路径', status: 400 };
    }

    const filePath = path.resolve(dirPath, String(rel || ''));
    if (!isVideoFile(filePath)) return { error: '不是视频文件', status: 400 };

    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return { error: '不是文件', status: 400 };
    } catch {
      return { error: '文件不存在（可能已被移动或删除）', status: 404 };
    }
    return { filePath };
  }

  /**
   * 把一个文件以 Range 流写进响应。
   * 必须支持 206：不给 Range 的话 `<video>` 拖进度条只能从头播。
   * Content-Type 按扩展名给：mkv 标成 video/mp4 会让 Chromium 直接放弃解码。
   */
  function streamFile(req: any, res: any, filePath: string): void {
    const ext = path.extname(filePath).toLowerCase();
    const mime =
      ext === '.mp4' || ext === '.m4v' ? 'video/mp4'
        : ext === '.webm' ? 'video/webm'
          : ext === '.mkv' ? 'video/x-matroska'
            : ext === '.ts' || ext === '.m2ts' ? 'video/mp2t'
              : ext === '.mov' ? 'video/quicktime'
                : ext === '.avi' ? 'video/x-msvideo'
                  : ext === '.flv' ? 'video/x-flv'
                    : 'application/octet-stream';

    const size = fs.statSync(filePath).size;
    res.setHeader('Content-Type', mime);
    res.setHeader('Accept-Ranges', 'bytes');
    // 本地文件被外部改动时不要让浏览器缓存旧内容
    res.setHeader('Cache-Control', 'no-cache');

    const range = req.headers.range;
    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(String(range));
      const start = match && match[1] ? Number(match[1]) : 0;
      const end = match && match[2] ? Number(match[2]) : size - 1;
      if (!match || start > end || start >= size) {
        res.statusCode = 416;
        res.setHeader('Content-Range', `bytes */${size}`);
        res.end();
        return;
      }
      const stop = Math.min(end, size - 1);
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${stop}/${size}`);
      res.setHeader('Content-Length', stop - start + 1);
      fs.createReadStream(filePath, { start, end: stop }).pipe(res);
      return;
    }

    res.setHeader('Content-Length', size);
    fs.createReadStream(filePath).pipe(res);
  }

  return {
    read,
    write,
    listSources,
    addSource,
    removeSource,
    scanAll,
    identify,
    getBindings,
    setBinding,
    setProgress,
    resolveEpisode,
    streamFile,
    /** 测试与调试用 */
    _paths: { FILE },
  };
}

export type LocalLibrary = ReturnType<typeof createLocalLibrary>;
