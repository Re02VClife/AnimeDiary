/**
 * core/music-links — 番剧 ↔ QQ 音乐绑定的纯逻辑（无网络、无 React、无 fs）
 *
 * 三件事都在这里，因为它们都只在「解析出来的字符串」上做判断，最容易测：
 *
 *   1. 解析 QQ 音乐页面里内联的 `window.__INITIAL_DATA__`
 *      —— 歌单页和歌曲详情页都是 SSR 的，数据直接怼在 HTML 里，
 *         不用登录、不用调 API 就能拿到曲名/歌手/专辑/出处。
 *         坑：那坨 JSON 里带**裸 `undefined` 字面量**（`"title_hilight":undefined`），
 *         标准 JSON.parse 会直接抛，必须先做一次安全替换。
 *   2. 从各种形态的链接里认出 songmid / 歌单 id
 *      —— y.qq.com 的 URL 前后改过好几版（/n/ryqq、/n/ryqq_v2、/n/yqq/song/*.html），
 *         用户还会直接粘 c6.y.qq.com 的短链（短链只能靠跳转后才知道内容）。
 *   3. 把歌单里的曲子按「这首番」排序
 *      —— QQ 音乐给每首歌都标了 subtitle（「《化物语》TV动画第10集片头曲」），
 *         这是现成的、比歌名匹配可靠得多的线索。177 首的歌单不排序没法用。
 */

/** 一首歌的展示快照。绑定时整条存下来，歌单以后改了也不影响已绑的卡。 */
export interface MusicTrack {
  /** QQ 音乐 songmid（10~16 位大小写字母数字） */
  mid: string;
  name: string;
  /** 多歌手用 ' / ' 连接 */
  singer: string;
  album: string;
  /** QQ 音乐标的出处，如「《莉兹与青鸟》电影配乐」 */
  subtitle?: string;
  coverUrl?: string;
  /** 时长（秒） */
  interval?: number;
  /** 需要会员才能播完整版 —— 免费曲才能走本地代理播放 */
  vip?: boolean;
}

/** 解析后的歌单 */
export interface MusicPlaylist {
  id: string;
  title: string;
  desc?: string;
  coverUrl?: string;
  /** 歌单声称的曲目数（可能大于实际解析到的条数：下架/版权缺失） */
  songCount: number;
  tracks: MusicTrack[];
  /** 抓取时间（毫秒） */
  fetchedAt: number;
  /** 实际请求到的地址（短链跳转后） */
  sourceUrl?: string;
}

/** 绑定到某部番的一条记录 */
export interface MusicBinding extends MusicTrack {
  /** ISO 时间 */
  boundAt: string;
}

/** 本地存储（music-links.json）的结构 */
export interface MusicSettings {
  /** 歌单来源：可以是短链、歌单页 URL 或纯数字 id */
  playlistUrl: string;
}

export interface MusicStoreFile {
  version: number;
  updatedAt: string;
  settings: MusicSettings;
  /** key 见 animeKeyFor()，value 是该番绑定的曲目 */
  bindings: Record<string, MusicBinding[]>;
}

/** 默认歌单就是用户自己那份「动漫」歌单（177 首） */
export const DEFAULT_PLAYLIST_URL = 'https://c6.y.qq.com/base/fcgi-bin/u?__=AmDkRqhzq7FQ';

/** 单条目最多绑几首，防手滑点出一百条 */
export const MAX_BINDINGS_PER_ANIME = 24;

/** 存盘文件版本，改结构时 +1 */
export const MUSIC_STORE_VERSION = 1;

/** 空存储（首次运行 / 文件损坏时的兜底） */
export function emptyMusicStore(): MusicStoreFile {
  return {
    version: MUSIC_STORE_VERSION,
    updatedAt: new Date(0).toISOString(),
    settings: { playlistUrl: DEFAULT_PLAYLIST_URL },
    bindings: {},
  };
}

// ── 小工具 ───────────────────────────────────────────────

function str(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

/** HTML 实体只处理最常见的几个：面板里全是中文歌名，别引入解析器 */
function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * 把 `//y.qq.com/music/photo_new/xxx.jpg` 补成 https。
 * 歌单页里封面字段是 `//` 开头的协议相对地址，直接塞进 <img> 在 file:// 下会裂。
 */
function normalizeCoverUrl(raw: unknown): string | undefined {
  const url = str(raw);
  if (!url) return undefined;
  if (url.startsWith('//')) return `https:${url}`;
  if (/^https?:\/\//i.test(url)) return url;
  return undefined;
}

// ── 1. __INITIAL_DATA__ 提取 ─────────────────────────────

/**
 * 把对象字面量里的裸 `undefined` 换成 `null`（字符串内部不动）。
 *
 * 只认「前后是 JSON 结构符」的情况：`:undefined`、`,undefined`、`[undefined`，
 * 后面跟着 `,` / `}` / `]`。这样歌名里真的出现 "undefined" 也不会被改。
 */
export function replaceBareUndefined(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  const prevSignificant = () => {
    for (let i = out.length - 1; i >= 0; i--) {
      const ch = out[i];
      if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') continue;
      return ch;
    }
    return '';
  };
  const nextSignificant = (from: number) => {
    for (let i = from; i < text.length; i++) {
      const ch = text[i];
      if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') continue;
      return ch;
    }
    return '';
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (text.startsWith('undefined', i)) {
      const before = prevSignificant();
      const after = nextSignificant(i + 'undefined'.length);
      const beforeOk = before === '' || before === ':' || before === ',' || before === '[' || before === '{';
      const afterOk = after === ',' || after === '}' || after === ']' || after === '';
      if (beforeOk && afterOk) {
        out += 'null';
        i += 'undefined'.length - 1;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

/**
 * 从 HTML 里抠出 `window.__INITIAL_DATA__ = {...}` 并解析。
 *
 * 用花括号配平而不是非贪婪正则：歌单对象里嵌着几十层带 `};` 的字符串，
 * 正则一定会截断在奇怪的位置。
 */
export function extractInitialData(html: string): any | null {
  if (!html) return null;
  const marker = html.indexOf('__INITIAL_DATA__');
  if (marker < 0) return null;
  const start = html.indexOf('{', marker);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end < 0) return null;

  const raw = html.slice(start, end);
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return JSON.parse(replaceBareUndefined(raw));
    } catch {
      return null;
    }
  }
}

// ── 2. 页面解析 ──────────────────────────────────────────

/** 歌单曲目 → MusicTrack；字段缺失/畸形直接丢弃（歌单里偶尔混进「已下架」占位） */
export function toTrack(raw: any): MusicTrack | null {
  if (!raw || typeof raw !== 'object') return null;
  const mid = str(raw.mid ?? raw.songmid ?? raw.songMid);
  // songmid 是 10~16 位的 base62；不合法的一律当脏数据
  if (!/^[0-9A-Za-z]{8,20}$/.test(mid)) return null;

  const name = str(raw.name ?? raw.title ?? raw.songname);
  if (!name) return null;

  const singerList = Array.isArray(raw.singer)
    ? raw.singer
    : Array.isArray(raw.singers) ? raw.singers : [];
  const singer = singerList
    .map((s: any) => str(s?.name ?? s?.title ?? s))
    .filter(Boolean)
    .join(' / ') || str(raw.singer);

  const intervalRaw = Number(raw.interval ?? raw.duration ?? 0);
  const interval = Number.isFinite(intervalRaw) && intervalRaw > 0 ? intervalRaw : undefined;

  const pay = raw.pay ?? raw.payInfo;
  const vip = raw.isVip === true || raw.isvip === true
    || Number(pay?.payplay ?? pay?.pay_play ?? 0) === 1;

  // 歌单接口不带封面地址，只给 album.mid —— 按 QQ 音乐的固定图床规律拼一张
  const albumMid = str(raw.album?.mid ?? raw.albummid ?? raw.albumMid);
  const coverUrl = normalizeCoverUrl(raw.coverUrl ?? raw.album?.coverUrl ?? raw.picurl)
    ?? (albumMid ? `https://y.qq.com/music/photo_new/T002R300x300M000${albumMid}.jpg` : undefined);

  return {
    mid,
    name,
    singer,
    album: str(raw.album?.name ?? raw.albumname ?? raw.albumName ?? raw.album?.title),
    subtitle: str(raw.subtitle) || undefined,
    coverUrl,
    interval,
    vip: vip || undefined,
  };
}

/** 歌单页 → MusicPlaylist。解析失败返回 null，由调用方给「链接可能变了」的提示。 */
export function parsePlaylistPage(html: string): MusicPlaylist | null {
  const data = extractInitialData(html);
  const detail = data?.detail;
  if (!detail || typeof detail !== 'object') return null;

  /**
   * 曲目数组的位置随页面版本变过：实测 2026-11 的歌单页（ryqq_v2）把 `songList`
   * 放在**顶层**，和 `detail` 平级；旧版/详情接口里则嵌在 detail 下。
   * 两边都认，别指着某一个位置。
   */
  const candidates = [data.songList, data.songlist, detail.songList, detail.songlist];
  const list: any[] = candidates.find((x) => Array.isArray(x)) ?? [];

  const tracks = list.map(toTrack).filter((t): t is MusicTrack => !!t);
  const id = str(detail.id ?? detail.disstid ?? data.id);
  if (!id) return null;

  const songCountRaw = Number(
    detail.songnum ?? data.totalNum ?? detail.songCount ?? detail.track_count ?? tracks.length,
  );
  return {
    id,
    title: str(detail.title) || `歌单 ${id}`,
    desc: str(detail.desc) || undefined,
    coverUrl: normalizeCoverUrl(detail.picurl),
    songCount: Number.isFinite(songCountRaw) ? songCountRaw : tracks.length,
    tracks,
    fetchedAt: Date.now(),
  };
}

/**
 * 歌曲详情页 → MusicTrack。
 * 详情页的 `detail.id` 是数字内部 id，**没有 songmid**，所以 mid 由 URL 带进来。
 */
export function parseSongDetailPage(html: string, fallbackMid = ''): MusicTrack | null {
  const data = extractInitialData(html);
  const detail = data?.detail;
  if (!detail || typeof detail !== 'object') return null;

  const mid = str(detail.mid) || fallbackMid;
  if (!/^[0-9A-Za-z]{8,20}$/.test(mid)) return null;

  const name = str(detail.title ?? detail.name ?? detail.songname);
  if (!name) return null;

  const singerList = Array.isArray(detail.singer) ? detail.singer : [];
  const singer = singerList.map((s: any) => str(s?.name)).filter(Boolean).join(' / ');

  return {
    mid,
    name,
    singer,
    album: str(detail.albumName ?? detail.album?.name ?? detail.albumname),
    subtitle: str(detail.subtitle) || undefined,
    coverUrl: normalizeCoverUrl(detail.picurl),
    interval: Number(detail.interval) > 0 ? Number(detail.interval) : undefined,
  };
}

// ── 3. 链接识别 ──────────────────────────────────────────

/**
 * 从用户粘贴的文本里认出 songmid。
 * 支持的形态：纯 mid、songDetail/{mid}、/n/yqq/song/{mid}.html、?songmid=xxx。
 */
export function songMidFromUrl(input: string): string | null {
  const text = str(input);
  if (!text) return null;
  if (/^[0-9A-Za-z]{10,20}$/.test(text)) return text;

  const patterns = [
    /songDetail\/([0-9A-Za-z]{8,20})/,
    /\/song\/([0-9A-Za-z]{8,20})\.html/,
    /[?&]songmid=([0-9A-Za-z]{8,20})/i,
    /songmid\/([0-9A-Za-z]{8,20})/i,
    /\/song\/([0-9A-Za-z]{8,20})(?:[?#/]|$)/,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return m[1];
  }
  return null;
}

/** 从链接/纯数字里认出歌单 id（c6 短链认不出，返回 null，调用方走跳转后解析）。 */
export function playlistIdFromSource(input: string): string | null {
  const text = str(input);
  if (!text) return null;
  if (/^\d{5,20}$/.test(text)) return text;
  const patterns = [
    /playlist\/(\d{5,20})/,
    /[?&](?:id|disstid)=(\d{5,20})/i,
    /\/taoge\/(\d{5,20})/,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return m[1];
  }
  return null;
}

/** 播放页地址（VIP 曲目在这里跳转播放） */
export function songPageUrl(mid: string): string {
  return `https://y.qq.com/n/ryqq/songDetail/${encodeURIComponent(mid)}`;
}

/** 歌单页地址 */
export function playlistPageUrl(id: string): string {
  return `https://y.qq.com/n/ryqq_v2/playlist/${encodeURIComponent(id)}`;
}

// ── 4. 绑定 key 与推荐打分 ───────────────────────────────

/**
 * 绑定归属的 key。
 *
 * 刻意不用 `entry.id`（那只等于 `excel-行号`）：Excel 里插一行，所有后续条目的
 * id 全变，绑定会集体错位到隔壁番剧上。标题 + 模板才是这个条目的「身份」，
 * 代价是改标题会丢绑定 —— 比串到别人的歌单上可接受得多。
 */
export function animeKeyFor(entry: { title?: string; templateId?: string } | null | undefined): string {
  const title = str(entry?.title).replace(/\s+/g, ' ').toLowerCase();
  const template = str(entry?.templateId) || 'default';
  return `${template}::${title}`;
}

/** 去掉书名号/标点，用于「番名是否出现在 subtitle 里」的判断 */
export function normalizeForMatch(input: string): string {
  return str(input)
    .replace(/[《》「」『』【】\[\]()（）〈〉<>]/g, ' ')
    .replace(/[~〜・:：!！?？,，.。、\-—–_/\\|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * 番名的检索变体：中文名、日文名、检索别名（Excel 里常写成「中文 / 原名 / 简称」）。
 * 太短的（单字）不参与匹配，否则「刀」「恋」这种会把半张歌单都算命中。
 */
export function titleVariants(entry: {
  title?: string; titleJa?: string; searchAlias?: string;
} | null | undefined): string[] {
  if (!entry) return [];
  const bucket = [
    str(entry.title),
    str(entry.titleJa),
    ...str(entry.searchAlias).split(/[/／|、,，]/),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of bucket) {
    const normalized = normalizeForMatch(raw);
    if (normalized.length < 2) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

/**
 * 给一首歌算「跟这部番有多相关」。
 *
 * 依据优先级：subtitle（QQ 音乐官方标的出处）> 专辑名 > 歌名。
 * 只用于排序，不做自动写入 —— 歌单里同名作品的翻唱/同人太多，
 * 最终还是要人点一下。
 */
export function scoreTrackForAnime(
  track: MusicTrack,
  variants: string[],
): number {
  if (variants.length === 0) return 0;
  const subtitle = normalizeForMatch(track.subtitle || '');
  const album = normalizeForMatch(track.album || '');
  const name = normalizeForMatch(track.name || '');

  let score = 0;
  for (const variant of variants) {
    if (subtitle.includes(variant)) {
      // 出处命中是最强信号；番名越长越不可能是巧合
      score = Math.max(score, 100 + Math.min(30, variant.length * 2));
      continue;
    }
    if (album.includes(variant)) {
      score = Math.max(score, 60 + Math.min(20, variant.length * 2));
      continue;
    }
    if (name.includes(variant)) {
      score = Math.max(score, 30);
    }
  }
  return score;
}

/** 按相关度排序（只保留有信号的），limit 默认 24 条够填满一屏 */
export function rankTracksForAnime(
  tracks: MusicTrack[],
  entry: { title?: string; titleJa?: string; searchAlias?: string } | null | undefined,
  limit = 24,
): MusicTrack[] {
  const variants = titleVariants(entry);
  if (variants.length === 0) return [];
  return tracks
    .map((track) => ({ track, score: scoreTrackForAnime(track, variants) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, limit))
    .map((item) => item.track);
}

/** 秒 → m:ss */
export function formatTrackDuration(seconds: number | undefined): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return '--:--';
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** 列表里给「同类曲目」去重（同 mid 只留一条） */
export function dedupeTracks(tracks: MusicTrack[]): MusicTrack[] {
  const seen = new Set<string>();
  const out: MusicTrack[] = [];
  for (const track of tracks) {
    if (!track?.mid || seen.has(track.mid)) continue;
    seen.add(track.mid);
    out.push(track);
  }
  return out;
}
