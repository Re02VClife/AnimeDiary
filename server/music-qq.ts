/**
 * server/music-qq — QQ 音乐（只读）客户端：歌单 / 歌曲详情 / 搜索 / 播放地址
 *
 * 为什么全是「抓页面 + 打公开接口」而不是官方 SDK：
 *   QQ 音乐没有面向个人的开放 API，社区能用的只有两条路，且都有代价：
 *
 *   1. **页面 SSR**：歌单页 / 歌曲详情页把整份数据内联在 `window.__INITIAL_DATA__` 里。
 *      免登录、字段齐全（曲名 / 歌手 / 专辑 / 时长 / 封面 / subtitle 出处 / 是否 VIP），
 *      实测 177 首的「动漫」歌单一次就能拉全。缺点是页面改版就失效 —— 所以解析
 *      全放在 core/music-links.ts，坏了只改那一处，且有单测兜着。
 *   2. **musicu.fcg**：vkey 取播放地址、smartbox 取搜索联想。
 *      注意 `music.search.SearchCgiService` 现在**匿名调用返回空列表**（实测），
 *      能用的只有 smartbox_new.fcg，所以搜索只给「少量精确结果」，不指望它翻页。
 *
 * 播放能力的边界（实测，别指望更多）：
 *   - 免费曲：vkey 返回 purl，补上 `Referer: https://y.qq.com/` 就能拉流（128k m4a）。
 *   - VIP 曲：vkey 返回 `result 104003` + 空 purl。这是版权校验，不是 bug，
 *     应用里不做绕过，直接引导用户去 QQ 音乐客户端/网页播放。
 *
 * 网络出口刻意**不用注入的 fetchImpl**：那条链路的最小契约里没有 `body`
 * 流式读取（见 FetchLike），而音频代理必须边下边转；且 QQ 音乐是国内域名，
 * Node 全局 fetch 直连即可，不涉及系统代理。与 character-voice.ts 同样的取舍。
 */
import fs from 'fs';
import path from 'path';
import {
  DEFAULT_PLAYLIST_URL,
  MUSIC_STORE_VERSION,
  dedupeTracks,
  emptyMusicStore,
  parsePlaylistPage,
  parseSongDetailPage,
  playlistIdFromSource,
  playlistPageUrl,
  songMidFromUrl,
  toTrack,
  MAX_BINDINGS_PER_ANIME,
} from '../core/music-links';
import type {
  MusicBinding,
  MusicPlaylist,
  MusicStoreFile,
  MusicTrack,
} from '../core/music-links';
import { maskUin, parseQqCookie } from '../core/qq-cookie';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const REFERER = 'https://y.qq.com/';
const MUSICU_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
const SMARTBOX_URL = 'https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg';

/** 歌单缓存 6 小时（歌单变动不频繁，但用户手动刷新要能立刻生效） */
const PLAYLIST_TTL_MS = 6 * 60 * 60 * 1000;
/** 单曲信息缓存 7 天（歌名不会变） */
const SONG_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** vkey 有效期很短（实测几分钟），缓存 5 分钟就够省掉重复请求 */
const VKEY_TTL_MS = 5 * 60 * 1000;

/** 随机 guid：vkey 接口要求带一个「设备号」，随便给个稳定的数字即可 */
const GUID = String(10_000_000 + Math.floor(Math.random() * 90_000_000));

interface CacheFile {
  version: number;
  playlists: Record<string, MusicPlaylist>;
  songs: Record<string, { track: MusicTrack; fetchedAt: number }>;
}

export interface MusicClientOptions {
  /** 数据目录（dev = 仓库根，prod = 文档/AnimeDiary） */
  DATA_DIR: string;
}

export interface PlayUrlResult {
  playable: boolean;
  vip: boolean;
  reason?: string;
}

/** 登录态：Cookie 存在 DATA_DIR/music-login.json，只在本机使用 */
export interface MusicLoginStatus {
  loggedIn: boolean;
  /** 打码后的 uin，给界面显示用 */
  uinMasked?: string;
  updatedAt?: string;
}

export interface MusicClient {
  /** 拉歌单（source 省略时用默认歌单）；force=true 跳过缓存 */
  playlist(source?: string, force?: boolean): Promise<MusicPlaylist>;
  /** 从链接 / 纯 mid 解析单曲 */
  resolveSong(input: string): Promise<MusicTrack>;
  /** 搜索（smartbox，匿名，结果较少） */
  search(keyword: string): Promise<MusicTrack[]>;
  /** 试算能不能在应用内播 */
  playUrl(mid: string): Promise<PlayUrlResult>;
  /** 拿可直接拉流的地址；VIP 曲返回 null */
  streamUrl(mid: string): Promise<string | null>;
  /** 读绑定文件（不存在/损坏都返回空结构，不让整个面板挂掉） */
  readStore(): MusicStoreFile;
  /** 原子写绑定文件 */
  writeStore(next: MusicStoreFile): MusicStoreFile;
  /** 保存浏览器粘来的 Cookie（VIP 曲子靠它才能拿到播放地址） */
  login(cookieText: string): MusicLoginStatus;
  /** 清掉登录态 */
  logout(): MusicLoginStatus;
  /** 当前登录态（不含 Cookie 本身） */
  loginStatus(): MusicLoginStatus;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function ensureDir(dir: string): void {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 已存在 */ }
}

/** 原子写：先写 .tmp 再 rename，避免进程被杀时留下半截 JSON */
function writeJsonAtomic(file: string, data: unknown): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

/** 只允许 QQ 音乐的地址被当作音源，避免这条路由变成任意 URL 中转 */
function isTencentAudioHost(url: string): boolean {
  try {
    const { hostname, protocol } = new URL(url);
    if (protocol !== 'http:' && protocol !== 'https:') return false;
    return /(^|\.)(qqmusic\.qq\.com|qq\.com|qpic\.cn|gtimg\.cn|tencentmusic\.com)$/.test(hostname);
  } catch {
    return false;
  }
}

export function createMusicClient({ DATA_DIR }: MusicClientOptions): MusicClient {
  const storeFile = path.join(DATA_DIR, 'music-links.json');
  const cacheFile = path.join(DATA_DIR, 'music_cache.json');
  const loginFile = path.join(DATA_DIR, 'music-login.json');

  let cache: CacheFile = readJson<CacheFile>(cacheFile, { version: 1, playlists: {}, songs: {} });
  if (!cache.playlists) cache.playlists = {};
  if (!cache.songs) cache.songs = {};

  /**
   * 登录态（用户从浏览器粘来的 Cookie）。
   * 只落本机、只用于 vkey 请求；不进任何响应体，界面只看到打码的 uin。
   */
  let login: { cookie: string; uin: string; updatedAt: string } | null =
    (() => {
      const raw = readJson<any>(loginFile, null);
      if (!raw || typeof raw.cookie !== 'string' || !raw.cookie) return null;
      return {
        cookie: String(raw.cookie),
        uin: String(raw.uin ?? '').replace(/\D/g, ''),
        updatedAt: String(raw.updatedAt ?? ''),
      };
    })();

  /** vkey 只用内存缓存：它本来几分钟就失效，没必要落盘 */
  const vkeyCache = new Map<string, { url: string | null; expiresAt: number; vip: boolean }>();

  function persistCache(): void {
    try { writeJsonAtomic(cacheFile, cache); } catch { /* 缓存写失败不影响主流程 */ }
  }

  function loginStatus(): MusicLoginStatus {
    if (!login) return { loggedIn: false };
    return { loggedIn: true, uinMasked: maskUin(login.uin), updatedAt: login.updatedAt };
  }

  function loginWithCookie(cookieText: string): MusicLoginStatus {
    // 解析失败会抛 QqCookieError，由路由转成 400
    const parsed = parseQqCookie(cookieText);
    login = { cookie: parsed.cookie, uin: parsed.uin, updatedAt: new Date().toISOString() };
    writeJsonAtomic(loginFile, login);
    // 匿名与登录态拿到的 purl 不同，缓存必须整体作废
    vkeyCache.clear();
    return loginStatus();
  }

  function logout(): MusicLoginStatus {
    login = null;
    try { fs.rmSync(loginFile, { force: true }); } catch { /* 文件本来就没有 */ }
    vkeyCache.clear();
    return { loggedIn: false };
  }

  function pickSip(sip: unknown): string {
    if (Array.isArray(sip)) {
      const https = sip.find((s) => typeof s === 'string' && s.startsWith('https://'));
      if (https) return https;
      const any = sip.find((s) => typeof s === 'string' && /^https?:\/\//.test(s));
      if (any) return any;
    }
    return 'https://aqqmusic.tc.qq.com/';
  }

  async function fetchHtml(url: string): Promise<{ html: string; finalUrl: string }> {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'zh-CN,zh;q=0.9,ja;q=0.8',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
    });
    if (!resp.ok) {
      throw new Error(`QQ 音乐返回 ${resp.status}（${url}）`);
    }
    return { html: await resp.text(), finalUrl: resp.url || url };
  }

  async function resolvePlaylistId(source: string): Promise<{ id: string; sourceUrl: string; html?: string }> {
    const direct = playlistIdFromSource(source);
    if (direct) return { id: direct, sourceUrl: playlistPageUrl(direct) };

    // 短链没有 id，只能跳一次看落地页；顺手把 HTML 带回去，避免马上再请求一次
    const { html, finalUrl } = await fetchHtml(source);
    const parsed = parsePlaylistPage(html);
    if (parsed) return { id: parsed.id, sourceUrl: finalUrl, html };
    const fromUrl = playlistIdFromSource(finalUrl);
    if (fromUrl) return { id: fromUrl, sourceUrl: finalUrl, html };
    throw new Error('没认出歌单：把 QQ 音乐「分享歌单」的链接或歌单页地址贴进来');
  }

  /**
   * 拉整份曲目。
   *
   * 只靠歌单页的 SSR 只有 **前 10 首**（2026-11 实测：177 首的歌单，页面只内联 10 首，
   * 剩下的由前端异步补）。所以正路走 `music.srfDissInfo.aiDissInfo`：
   * 免登录、100 首一页、带 `hasmore`，且**保留了 subtitle**（推荐排序全靠它）。
   * 页面 SSR 退居二线：只用来认短链，以及接口挂了时的兜底。
   */
  async function fetchPlaylistSongs(id: string): Promise<{
    tracks: MusicTrack[];
    total: number;
    title: string;
    desc?: string;
    coverUrl?: string;
  }> {
    const numericId = Number(id);
    if (!Number.isFinite(numericId) || numericId <= 0) throw new Error('歌单 id 不是数字');

    const tracks: MusicTrack[] = [];
    let total = 0;
    let title = '';
    let desc = '';
    let coverUrl = '';

    for (let page = 0; page < 30; page++) {
      const body = {
        req_0: {
          module: 'music.srfDissInfo.aiDissInfo',
          method: 'uniform_get_Dissinfo',
          param: {
            disstid: numericId,
            enc_host_uin: '',
            tag: 1,
            userinfo: 1,
            song_begin: page * 100,
            song_num: 100,
          },
        },
        comm: { uin: 0, format: 'json', ct: 24, cv: 0 },
      };
      const resp = await fetch(MUSICU_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA, Referer: REFERER },
        body: JSON.stringify(body),
      });
      const json: any = await resp.json().catch(() => null);
      const data = json?.req_0?.data;
      if (!data) throw new Error('歌单接口没返回数据');

      if (page === 0) {
        const dirinfo = data.dirinfo ?? {};
        title = String(dirinfo.title ?? '').trim();
        desc = String(dirinfo.desc ?? '').trim();
        coverUrl = String(dirinfo.picurl ?? '').trim();
        const count = Number(dirinfo.songnum ?? data.total_song_num ?? 0);
        total = Number.isFinite(count) && count > 0 ? count : 0;
      }

      const list: any[] = Array.isArray(data.songlist) ? data.songlist : [];
      tracks.push(...list.map(toTrack).filter((t): t is MusicTrack => !!t));
      if (list.length === 0) break;
      // hasmore 的形态不稳（true / 1 / "true" 都见过），再叠一层「不满一页就结束」的判断
      const hasMore = data.hasmore === true || data.hasmore === 1
        || data.hasmore === 'true' || data.hasmore === '1';
      if (!hasMore && list.length < 100) break;
      if (total > 0 && tracks.length >= total) break;
    }

    return {
      tracks,
      total: total || tracks.length,
      title,
      desc: desc || undefined,
      coverUrl: coverUrl ? `https://${coverUrl.replace(/^https?:\/\//, '')}` : undefined,
    };
  }

  async function playlist(source = DEFAULT_PLAYLIST_URL, force = false): Promise<MusicPlaylist> {
    const target = source.trim() || DEFAULT_PLAYLIST_URL;

    // 已缓存且未过期：直接用（短链也一样，按解析后的 id 缓存）
    const directId = playlistIdFromSource(target);
    if (!force && directId) {
      const hit = cache.playlists[directId];
      if (hit && Date.now() - hit.fetchedAt < PLAYLIST_TTL_MS) return hit;
    }

    let id = directId ?? '';
    let sourceUrl = id ? playlistPageUrl(id) : '';
    let prefetchedHtml: string | undefined;
    if (!id) {
      // 短链没有 id，只能跳一次看落地页
      const resolved = await resolvePlaylistId(target);
      id = resolved.id;
      sourceUrl = resolved.sourceUrl;
      prefetchedHtml = resolved.html;
    }

    const hit = cache.playlists[id];
    if (!force && hit && Date.now() - hit.fetchedAt < PLAYLIST_TTL_MS) {
      return hit;
    }

    let tracks: MusicTrack[] = [];
    let total = 0;
    let title = '';
    let desc: string | undefined;
    let coverUrl: string | undefined;

    try {
      const api = await fetchPlaylistSongs(id);
      tracks = api.tracks;
      total = api.total;
      title = api.title;
      desc = api.desc;
      coverUrl = api.coverUrl;
    } catch { /* 接口挂了还有 SSR 兜底 */ }

    if (tracks.length === 0) {
      const html = prefetchedHtml ?? (await fetchHtml(sourceUrl)).html;
      const parsed = parsePlaylistPage(html);
      if (!parsed) {
        // 页面结构变了或歌单被删：宁可回退到旧缓存，也别让面板直接空掉
        if (hit) return hit;
        throw new Error('歌单解析失败（QQ 音乐可能改版了，或这个歌单已失效）');
      }
      tracks = parsed.tracks;
      total = parsed.songCount;
      title = title || parsed.title;
      desc = desc ?? parsed.desc;
      coverUrl = coverUrl ?? parsed.coverUrl;
    }

    const result: MusicPlaylist = {
      id,
      title: title || `歌单 ${id}`,
      desc,
      coverUrl,
      songCount: total || tracks.length,
      tracks,
      fetchedAt: Date.now(),
      sourceUrl,
    };
    cache.playlists[id] = result;
    persistCache();
    return result;
  }

  async function resolveSong(input: string): Promise<MusicTrack> {
    const mid = songMidFromUrl(input);
    if (!mid) throw new Error('没认出歌曲：支持 y.qq.com 的歌曲页链接或 songmid 本身');

    const cached = cache.songs[mid];
    if (cached && Date.now() - cached.fetchedAt < SONG_TTL_MS) return cached.track;

    const { html } = await fetchHtml(`https://y.qq.com/n/ryqq/songDetail/${mid}`);
    const track = parseSongDetailPage(html, mid);
    if (!track) throw new Error('歌曲页解析失败（QQ 音乐可能改版了）');

    cache.songs[mid] = { track, fetchedAt: Date.now() };
    persistCache();
    return track;
  }

  async function search(keyword: string): Promise<MusicTrack[]> {
    const key = keyword.trim();
    if (!key) return [];
    const url = `${SMARTBOX_URL}?key=${encodeURIComponent(key)}&format=json&g_tk=5381`
      + '&loginUin=0&hostUin=0&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0';
    const resp = await fetch(url, { headers: { 'User-Agent': UA, Referer: REFERER } });
    if (!resp.ok) throw new Error(`搜索失败：${resp.status}`);
    const json: any = await resp.json().catch(() => null);
    const list: any[] = Array.isArray(json?.data?.song?.itemlist) ? json.data.song.itemlist : [];
    return dedupeTracks(list.map((item) => ({
      mid: String(item?.mid ?? ''),
      name: String(item?.name ?? '').trim(),
      singer: String(item?.singer ?? '').trim(),
      album: '',
    })).filter((t) => /^[0-9A-Za-z]{8,20}$/.test(t.mid) && t.name));
  }

  /**
   * 向 vkey 要一首歌的播放地址。
   * 返回 null = 拿不到（VIP / 下架 / 地区限制），调用方据此引导用户去 QQ 音乐。
   */
  async function fetchVkey(mid: string): Promise<{ url: string | null; vip: boolean }> {
    const cached = vkeyCache.get(mid);
    if (cached && cached.expiresAt > Date.now()) {
      return { url: cached.url, vip: cached.vip };
    }

    const uinParam = login?.uin || '0';
    const body = {
      req_0: {
        module: 'vkey.GetVkeyServer',
        method: 'CgiGetVkey',
        param: {
          guid: GUID,
          songmid: [mid],
          songtype: [0],
          uin: uinParam,
          loginflag: 1,
          platform: '20',
        },
      },
      comm: { uin: login?.uin ? Number(login.uin) : 0, format: 'json', ct: 24, cv: 0 },
    };

    let url: string | null = null;
    let vip = false;
    try {
      const resp = await fetch(MUSICU_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': UA,
          Referer: REFERER,
          ...(login ? { Cookie: login.cookie } : {}),
        },
        body: JSON.stringify(body),
      });
      const json: any = await resp.json().catch(() => null);
      const info = json?.req_0?.data?.midurlinfo?.[0] ?? {};
      const purl = typeof info.purl === 'string' ? info.purl : '';
      if (purl) {
        const sip = pickSip(json?.req_0?.data?.sip);
        url = `${sip.replace(/\/?$/, '/')}${purl}`;
      } else {
        // result 104003 = 需要登录/会员；其余也一律当「拿不到」
        vip = Number(info.result) === 104003 || Number(info.result) === 1040030;
      }
    } catch {
      url = null;
    }

    if (!url) vip = true;
    vkeyCache.set(mid, { url, vip, expiresAt: Date.now() + (url ? VKEY_TTL_MS : 60_000) });
    return { url, vip };
  }

  async function playUrl(mid: string): Promise<PlayUrlResult> {
    if (!/^[0-9A-Za-z]{8,20}$/.test(mid)) return { playable: false, vip: false, reason: 'songmid 不合法' };
    const { url, vip } = await fetchVkey(mid);
    if (url) return { playable: true, vip: false };
    return {
      playable: false,
      vip,
      reason: vip
        ? (login
          ? '登录态可能过期了（QQ 音乐 Cookie 一般几周失效），重新粘一次试试'
          : '这首是会员曲：在「换歌单」旁点「登录」，粘一次 Cookie 就能在应用内播')
        : '暂时拿不到播放地址',
    };
  }

  async function streamUrl(mid: string): Promise<string | null> {
    if (!/^[0-9A-Za-z]{8,20}$/.test(mid)) return null;
    // 等 vkey 追上时稍等一秒，避免前端刚点播放就 404
    for (let attempt = 0; attempt < 2; attempt++) {
      const { url } = await fetchVkey(mid);
      if (url && isTencentAudioHost(url)) return url;
      if (attempt === 0) await sleep(200);
    }
    return null;
  }

  function readStore(): MusicStoreFile {
    const raw = readJson<any>(storeFile, null);
    const empty = emptyMusicStore();
    if (!raw || typeof raw !== 'object') return empty;

    const bindings: Record<string, MusicBinding[]> = {};
    const source = raw.bindings && typeof raw.bindings === 'object' ? raw.bindings : {};
    for (const [key, value] of Object.entries(source)) {
      if (!Array.isArray(value)) continue;
      const list = value
        .map((item: any): MusicBinding | null => {
          const mid = String(item?.mid ?? '');
          if (!/^[0-9A-Za-z]{8,20}$/.test(mid)) return null;
          return {
            mid,
            name: String(item?.name ?? '未知曲目'),
            singer: String(item?.singer ?? ''),
            album: String(item?.album ?? ''),
            subtitle: item?.subtitle ? String(item.subtitle) : undefined,
            coverUrl: item?.coverUrl ? String(item.coverUrl) : undefined,
            interval: Number(item?.interval) > 0 ? Number(item.interval) : undefined,
            vip: item?.vip === true ? true : undefined,
            boundAt: String(item?.boundAt ?? new Date().toISOString()),
          };
        })
        .filter((x: MusicBinding | null): x is MusicBinding => !!x)
        .slice(0, MAX_BINDINGS_PER_ANIME);
      if (list.length > 0) bindings[key] = list;
    }

    const playlistUrl = typeof raw?.settings?.playlistUrl === 'string' && raw.settings.playlistUrl.trim()
      ? raw.settings.playlistUrl.trim()
      : DEFAULT_PLAYLIST_URL;

    return {
      version: MUSIC_STORE_VERSION,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : empty.updatedAt,
      settings: { playlistUrl },
      bindings,
    };
  }

  function writeStore(next: MusicStoreFile): MusicStoreFile {
    // 服务端再收一遍口子：前端传来的东西不可信
    const safe: MusicStoreFile = {
      version: MUSIC_STORE_VERSION,
      updatedAt: new Date().toISOString(),
      settings: {
        playlistUrl: String(next?.settings?.playlistUrl || DEFAULT_PLAYLIST_URL).trim().slice(0, 500)
          || DEFAULT_PLAYLIST_URL,
      },
      bindings: {},
    };
    const incoming = next?.bindings && typeof next.bindings === 'object' ? next.bindings : {};
    for (const [key, value] of Object.entries(incoming)) {
      if (!Array.isArray(value) || !key) continue;
      const list = value
        .filter((item: any) => item && /^[0-9A-Za-z]{8,20}$/.test(String(item.mid ?? '')))
        .map((item: any): MusicBinding => ({
          mid: String(item.mid),
          name: String(item.name ?? '未知曲目').slice(0, 200),
          singer: String(item.singer ?? '').slice(0, 200),
          album: String(item.album ?? '').slice(0, 200),
          subtitle: item.subtitle ? String(item.subtitle).slice(0, 300) : undefined,
          coverUrl: item.coverUrl ? String(item.coverUrl).slice(0, 500) : undefined,
          interval: Number(item.interval) > 0 ? Number(item.interval) : undefined,
          vip: item.vip === true ? true : undefined,
          boundAt: String(item.boundAt || new Date().toISOString()).slice(0, 40),
        }))
        .slice(0, MAX_BINDINGS_PER_ANIME);
      if (list.length > 0) safe.bindings[key.slice(0, 200)] = list;
    }

    writeJsonAtomic(storeFile, safe);
    return safe;
  }

  return {
    playlist, resolveSong, search, playUrl, streamUrl, readStore, writeStore,
    login: loginWithCookie, logout, loginStatus,
  };
}
