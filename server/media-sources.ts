/**
 * 番剧元数据多源获取层
 *
 * 借鉴 Kazumi（Predidit/Kazumi）的组织方式，但刻意在两点上做得更稳：
 *
 *   1. 只用**官方公开接口**，不碰任何私有签名镜像
 *        - Bangumi : api.bgm.tv (v0 搜索/详情) + next.bgm.tv (p1 详情回退)
 *        - Bilibili: api.bilibili.com（国内直连可达，作为「随时能用」的底座）
 *      Kazumi 自己的 api.kazumi.fyi 需要 CI 注入 KAZUMI_APPID/KAZUMI_KEY 做
 *      X-Signature 签名，那是它的私有凭据，本项目既无权也不该使用。
 *
 *   2. 网络出口由调用方注入（fetchImpl）
 *        - Electron 主进程传 `net.fetch` → 走 Chromium 网络栈，**自动遵守系统代理**。
 *          这是关键：Node 的全局 fetch(undici) 完全不读系统代理，所以打包后的应用
 *          以前即使开了 Clash 也连不上 api.bgm.tv（而渲染进程的 <img> 却能加载图片，
 *          两边行为不一致，非常难查）。
 *        - Vite dev 传全局 fetch 即可。
 *      于是「有可用代理就能连通国外源，没代理也照样能用国内源」。
 *
 *   3. 请求节流 + 退避重试 + 随机 UA/Accept-Language（对应 Kazumi 的
 *      async_rate_limiter.dart 与 http_headers.dart），避免被 403/429。
 */
/** 支持的数据源 */
export type MediaSource = 'bangumi' | 'bilibili';

/** 各源统一后的候选条目 */
export interface MediaCandidate {
  source: MediaSource;
  /** 源内 ID（Bangumi subject id / Bilibili season_id） */
  sourceId: string;
  /** 原始名（日文/原名） */
  title: string;
  /** 中文名（无非中文名时回落为原名） */
  titleCn: string;
  /** 别名（Bangumi infobox「别名」/ Bilibili org_title） */
  aliases: string[];
  /** 封面原始 URL —— 尚未下载到本地 */
  coverUrl: string;
  /** 评分（10 分制） */
  score: number | null;
  /** 上映年月 YYYY-MM */
  releaseDate: string | null;
  /** 总集数 */
  episodes: number | null;
  /** 制作组 / 动画制作 */
  studio: string | null;
  tags: string[];
  summary: string;
  /** 源站链接 */
  link: string;
}

/** 连通性探测结果 */
export interface ProbeResult {
  source: MediaSource;
  ok: boolean;
  latencyMs: number;
  error?: string;
}

/** 最小 Response 契约（全局 fetch 与 electron net.fetch 都满足） */
export interface ResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<any>;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

export type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<ResponseLike>;

/** 允许下载封面的图床域名后缀（防止这条新路由变成任意 URL 的 SSRF 跳板） */
export const COVER_HOST_SUFFIXES = [
  'hdslb.com', // B 站图床
  'bilibili.com',
  'bgm.tv', // lain.bgm.tv
  'anilist.co',
  'anilistcdn.com',
];

/**
 * UA 池。Bangumi 官方要求请求带可识别的 User-Agent，缺失会被 403；
 * 随机化则是为了不像脚本一样被批量识别（Kazumi 的 http_headers.dart 思路）。
 */
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'AnimeDiary/1.0 (https://github.com/anime-diary; personal anime scoring app)',
];

const ACCEPT_LANGUAGES = ['zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7', 'zh-CN,zh;q=0.9', 'ja,en;q=0.8,zh-CN;q=0.7'];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 串行节流器：保证同一数据源的相邻请求间隔不小于 minIntervalMs。
 * 所有调用方排队通过，互不插队（等价于 Kazumi 的 AsyncRateLimiter）。
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

/** 去掉 HTML 标签与实体（Bilibili 搜索结果的高亮 <em>、Bangumi 简介里的 <br> 等） */
export function stripHtml(input: unknown): string {
  if (input === null || input === undefined) return '';
  return String(input)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/** 归一化上映日期为 YYYY-MM（取不到月份时退化为 YYYY） */
export function normalizeReleaseDate(input: unknown): string | null {
  // B 站 pubtime 是 Unix 秒级时间戳
  if (typeof input === 'number' && Number.isFinite(input) && input > 1e9) {
    const d = new Date(input * 1000);
    if (!Number.isNaN(d.getTime())) {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }
  }
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  const m = raw.match(/^(\d{4})[-/.](\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}`;
  const y = raw.match(/^(\d{4})$/);
  if (y) return y[1];
  return null;
}

/** B 站图片是协议相对地址（//i0.hdslb.com/...），必须补上 https: */
function fixProtocol(url: unknown): string {
  const s = String(url ?? '').trim();
  if (!s) return '';
  if (s.startsWith('//')) return 'https:' + s;
  if (s.startsWith('http://')) return 'https://' + s.slice(7);
  return s;
}

/**
 * 取出「名字数组」。
 * B 站同一个字段在不同接口下形态不同：
 *   search/type   → styles: ['漫画改', '萌系']
 *   wbi/search/type → styles: '漫画改/萌系/音乐'（斜杠连接的字符串）
 *   pgc/view/season → styles: [{ id: 1, name: '漫画改' }, ...]
 * 三种都要能认，否则界面会显示成 [object Object] 或者干脆丢失标签。
 */
function namesOf(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v
      .map((el) => (el && typeof el === 'object' ? (el as any).name : el))
      .filter((x) => x !== null && x !== undefined && String(x).trim() !== '')
      .map((x) => String(x).trim());
  }
  // 斜杠/顿号/逗号连接的字符串
  const s = String(v ?? '').trim();
  return s ? s.split(/[/、,，]/).map((x) => x.trim()).filter(Boolean) : [];
}

/**
 * 把 fetch 的异常翻成人能看懂的原因。
 * 直连被墙时 undici 只给一句 "fetch failed"，真正的信息藏在 cause 里
 * （ENOTFOUND / ECONNRESET / UND_ERR_CONNECT_TIMEOUT …），不展开就等于没报错。
 */
export function describeError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause: any = (e as any).cause;
  const code = cause?.code || (e as any).code;
  const detail = String(cause?.message || '');
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return '请求超时';
  if (code && detail) return `${code}: ${detail}`.slice(0, 160);
  if (cause?.message) return String(cause.message).slice(0, 160);
  return e.message.slice(0, 160);
}

/**
 * Bangumi infobox 的取值。
 * 同一份数据在不同端点下形态不同：
 *   api.bgm.tv/v0 → { key: '动画制作', value: '京都动画' }
 *   next.bgm.tv/p1 → { key: '动画制作', values: [{ v: '京都动画' }] }
 * 所以两种都要认。
 */
function infoboxValue(entry: any): string {
  if (!entry) return '';
  const raw = entry.values ?? entry.value;
  if (raw === null || raw === undefined) return '';
  if (Array.isArray(raw)) {
    return raw
      .map((el) => (el && typeof el === 'object' ? el.v : el))
      .filter((v) => v !== null && v !== undefined && String(v).trim() !== '')
      .map((v) => stripHtml(v))
      .join('、');
  }
  return stripHtml(raw);
}

function pickInfobox(infobox: unknown, keys: string[]): string | null {
  if (!Array.isArray(infobox)) return null;
  for (const key of keys) {
    for (const item of infobox) {
      if (item && typeof item === 'object' && String((item as any).key ?? '').trim() === key) {
        const v = infoboxValue(item);
        if (v) return v;
      }
    }
  }
  return null;
}

function pickInfoboxList(infobox: unknown, keys: string[]): string[] {
  const v = pickInfobox(infobox, keys);
  if (!v) return [];
  return v.split(/[、,，]/).map((s) => s.trim()).filter(Boolean);
}

/** 从 B 站 staff 文本里抠出动画制作公司（形如「动画制作：京都动画」） */
function studioFromStaff(staff: unknown): string | null {
  const text = stripHtml(staff);
  if (!text) return null;
  const m = text.match(/(?:动画制作|製作|制作公司|アニメーション制作)\s*[:：]\s*([^\n\r]+)/);
  if (m) return m[1].trim();
  return null;
}

function toNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export interface MediaClientOptions {
  /** 网络出口。Electron 传 net.fetch；dev 传全局 fetch。 */
  fetchImpl?: FetchLike;
  /** 单次请求超时 */
  timeoutMs?: number;
  /** 失败重试次数（仅针对超时 / 429 / 5xx） */
  retries?: number;
}

export interface MediaClient {
  probe(source: MediaSource): Promise<ProbeResult>;
  probeAll(): Promise<ProbeResult[]>;
  /** 按源搜索候选条目 */
  search(source: MediaSource, keyword: string, limit?: number): Promise<MediaCandidate[]>;
  /** 取单条详情（补全 studio / 简介 / 上映时间 / 集数） */
  detail(source: MediaSource, sourceId: string): Promise<MediaCandidate | null>;
  /** 下载图片原始字节（走同一个网络出口） */
  fetchImage(url: string, maxBytes?: number): Promise<{ buffer: Buffer; contentType: string }>;
}

export function createMediaClient(options: MediaClientOptions = {}): MediaClient {
  // 超时/重试刻意保守：交互式搜索要等响应，15s×3 次重试会让代理抖动时
  // 一次搜索卡到 45 秒。路由层还有 9 秒的每源上限兜底（见 api-routes）。
  const timeoutMs = options.timeoutMs ?? 10000;
  const retries = options.retries ?? 1;
  const injected = options.fetchImpl;
  /** 兜底：没注入就用全局 fetch（Vite dev / Node 20+） */
  const doFetch: FetchLike = injected ?? ((url, init) => (globalThis as any).fetch(url, init));

  // Bangumi 官方建议克制使用；B 站一次搜索要打两个分类，且风控敏感，都放慢一些。
  // 批量补全动辄几百次请求，宁可慢也不要被风控（实测被 412 封过一段时间）。
  const throttles: Record<MediaSource, () => Promise<void>> = {
    bangumi: createThrottle(900),
    bilibili: createThrottle(800),
  };

  /** 带节流 / 超时 / 退避重试的底层请求 */
  async function request(
    source: MediaSource,
    url: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      noThrottle?: boolean;
      /** 覆盖默认超时（探测用短超时，避免一次探测卡掉几十秒） */
      timeoutMs?: number;
      /** 覆盖默认重试次数 */
      retries?: number;
    } = {},
  ): Promise<ResponseLike> {
    const maxRetries = init.retries ?? retries;
    const perTryTimeout = init.timeoutMs ?? timeoutMs;
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (!init.noThrottle) await throttles[source]();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), perTryTimeout);
      try {
        const headers: Record<string, string> = {
          'User-Agent': pick(USER_AGENTS),
          'Accept-Language': pick(ACCEPT_LANGUAGES),
          ...(init.headers ?? {}),
        };
        const resp = await doFetch(url, {
          method: init.method ?? 'GET',
          headers,
          body: init.body,
          signal: controller.signal,
        });
        clearTimeout(timer);
        // 429 / 5xx 才值得重试；4xx（含 Bangumi 因缺 UA 返回的 403）重试也没用
        if ((resp.status === 429 || resp.status >= 500) && attempt < maxRetries) {
          lastError = new Error(`HTTP ${resp.status}`);
          await sleep(500 * (attempt + 1));
          continue;
        }
        return resp;
      } catch (e) {
        clearTimeout(timer);
        lastError = e;
        if (attempt < maxRetries) {
          await sleep(400 * (attempt + 1));
          continue;
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async function requestJson(
    source: MediaSource,
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string; noThrottle?: boolean } = {},
  ): Promise<any> {
    const resp = await request(source, url, init);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  }

  // ── 连通性探测 ──
  // 刻意用「短超时 + 不重试」：被墙的源上，15s×3 次重试会让一次探测卡 30 秒以上，
  // 而探测的目的恰恰是尽快告诉用户「这个源现在用不了」。
  async function probe(source: MediaSource): Promise<ProbeResult> {
    const target =
      source === 'bangumi'
        ? { url: 'https://api.bgm.tv/v0/subjects/2', init: {} }
        : { url: 'https://api.bilibili.com/pgc/view/web/season?season_id=1172', init: { headers: { Referer: 'https://www.bilibili.com/' } } };
    const started = Date.now();
    try {
      const resp = await request(source, target.url, {
        ...target.init,
        noThrottle: true,
        timeoutMs: 6000,
        retries: 0,
      });
      return { source, ok: resp.ok, latencyMs: Date.now() - started, error: resp.ok ? undefined : `HTTP ${resp.status}` };
    } catch (e) {
      return { source, ok: false, latencyMs: Date.now() - started, error: describeError(e) };
    }
  }

  // ── Bangumi ──
  async function bangumiSearch(keyword: string, limit: number): Promise<MediaCandidate[]> {
    const json = await requestJson('bangumi', `https://api.bgm.tv/v0/search/subjects?limit=${limit}&offset=0`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword, filter: { type: [2] } }),
    });
    const list: any[] = Array.isArray(json?.data) ? json.data : [];
    return list.map((item) => ({
      source: 'bangumi' as const,
      sourceId: String(item.id),
      title: String(item.name ?? ''),
      titleCn: String(item.name_cn || item.name || ''),
      aliases: pickInfoboxList(item.infobox, ['别名', '別名']),
      coverUrl: String(item.images?.large || item.images?.common || ''),
      score: toNumberOrNull(item.rating?.score),
      releaseDate: normalizeReleaseDate(item.date),
      episodes: toNumberOrNull(item.eps ?? item.total_episodes),
      studio: pickInfobox(item.infobox, ['动画制作', 'アニメーション制作', '制作']),
      tags: Array.isArray(item.tags) ? item.tags.slice(0, 12).map((t: any) => String(t?.name ?? '')).filter(Boolean) : [],
      summary: stripHtml(item.summary),
      link: `https://bgm.tv/subject/${item.id}`,
    }));
  }

  async function bangumiDetail(sourceId: string): Promise<MediaCandidate | null> {
    // 主端点 v0；失败则回退 next.bgm.tv 的 p1（这就是 Kazumi 的双端点思路）
    let json: any = null;
    try {
      json = await requestJson('bangumi', `https://api.bgm.tv/v0/subjects/${encodeURIComponent(sourceId)}`);
    } catch (e) {
      // ⚠️ 超时就不要回退了。实测：代理抖动时下一次请求大概率同样超时，
      // 白等一轮的代价是让整批补全从 2 分钟变成 11 分钟（190 条 × 两次 20 秒）。
      // 回退只在「快速失败」时才有意义（例如端点返回 4xx）。
      const msg = describeError(e);
      if (msg.includes('超时')) throw new Error(msg);
      json = await requestJson('bangumi', `https://next.bgm.tv/p1/subjects/${encodeURIComponent(sourceId)}`);
    }
    if (!json || json.id === undefined) return null;
    return {
      source: 'bangumi',
      sourceId: String(json.id),
      title: String(json.name ?? ''),
      titleCn: String(json.name_cn || json.nameCN || json.name || ''),
      aliases: pickInfoboxList(json.infobox, ['别名', '別名']),
      // next.bgm.tv 只给单张 image 字段，没有 images 映射
      coverUrl: String(json.images?.large || json.images?.common || json.image || ''),
      score: toNumberOrNull(json.rating?.score),
      releaseDate: normalizeReleaseDate(json.date ?? json.airtime?.date),
      episodes: toNumberOrNull(json.eps ?? json.total_episodes),
      studio: pickInfobox(json.infobox, ['动画制作', 'アニメーション制作', '制作']),
      tags: Array.isArray(json.tags) ? json.tags.slice(0, 12).map((t: any) => String(t?.name ?? '')).filter(Boolean) : [],
      summary: stripHtml(json.summary),
      link: `https://bgm.tv/subject/${json.id}`,
    };
  }

  // ── Bilibili（国内直连，作为随时可用的底座）──
  const BILI_HEADERS = { Referer: 'https://www.bilibili.com/', Accept: 'application/json, text/plain, */*' };

  /**
   * B 站搜索走 **wbi/search/type**，而不是老的 search/type。
   *
   * 这是实测出来的结论：老的 `x/web-interface/search/type` 对非浏览器客户端
   * 几乎必返 412（换 1200ms 间隔、补 buvid3 cookie 都救不回来，而且会给整台机器
   * 招来一段时间的地域性风控）；而网站自己在用的 `x/web-interface/wbi/search/type`
   * 无需签名即可稳定返回 200。批量补全要打几百次请求，这个差别是决定性的。
   *
   * 同时查询两个分类：
   *   media_bangumi → TV 番剧
   *   media_ft      → 影视（剧场版/电影）
   * 只查前者会漏掉所有剧场版（实测命中率 7/20 → 合并后 11/20）。
   */
  /** 把 B 站搜索/详情返回的条目归一化为 MediaCandidate */
  function mapBiliItem(item: any): MediaCandidate {
    const seasonId = String(item.season_id ?? item.pgc_season_id ?? item.media_id ?? '');
    return {
      source: 'bilibili',
      sourceId: seasonId,
      title: stripHtml(item.org_title || item.original_title || item.title),
      titleCn: stripHtml(item.title),
      aliases: [stripHtml(item.org_title || ''), stripHtml(item.original_title || '')]
        .filter((x) => x && x !== stripHtml(item.title)),
      coverUrl: fixProtocol(item.cover),
      // ⚠️ 评分恒为 null：评分一律以 Bangumi 为准。
      // B 站的 9.9 分和 Bangumi 的 8.3 分是两套完全不同的评分口径
      // （B 站普遍虚高），混用会把「BGM」列写成脏数据。
      // 这里直接不返回，从源头上杜绝被误用。
      score: null,
      // wbi 结果带 pubtime，很多时候不必再打一次详情
      releaseDate: normalizeReleaseDate(item.pubtime ?? item.publish?.pub_time),
      episodes: toNumberOrNull(item.ep_size ?? item.total),
      studio: studioFromStaff(item.staff),
      tags: [...namesOf(item.styles), ...namesOf(item.areas)],
      summary: stripHtml(item.index_show || item.evaluate || item.desc),
      link: seasonId ? `https://www.bilibili.com/bangumi/play/ss${seasonId}` : '',
    };
  }

  async function queryBiliSearch(searchType: string, keyword: string): Promise<any[]> {
    const url =
      `https://api.bilibili.com/x/web-interface/wbi/search/type?search_type=${searchType}&page=1&keyword=` +
      encodeURIComponent(keyword);
    const json = await requestJson('bilibili', url, { headers: BILI_HEADERS });
    if (json?.code !== 0) throw new Error(json?.message || `B 站返回 code=${json?.code}`);
    return Array.isArray(json?.data?.result) ? json.data.result : [];
  }

  async function bilibiliSearch(keyword: string, limit: number): Promise<MediaCandidate[]> {
    const merged = new Map<string, MediaCandidate>();
    let lastError = '';

    // 先查番剧；**只有一部都没查到**时才去查影视（剧场版/电影）。
    // 大多数条目都是 TV 番剧，这样能把请求数直接减半 ——
    // 批量补全要打几百次请求，请求数就是被风控的概率。
    for (const searchType of ['media_bangumi', 'media_ft']) {
      try {
        const list = await queryBiliSearch(searchType, keyword);
        for (const item of list) {
          const c = mapBiliItem(item);
          if (c.sourceId && !merged.has(c.sourceId)) merged.set(c.sourceId, c);
        }
      } catch (e) {
        lastError = describeError(e);
      }
      if (merged.size > 0) break; // 番剧命中就不必再查影视
    }

    if (merged.size === 0 && lastError) throw new Error(lastError);
    return [...merged.values()].slice(0, limit);
  }

  async function bilibiliDetail(sourceId: string): Promise<MediaCandidate | null> {
    const url = `https://api.bilibili.com/pgc/view/web/season?season_id=${encodeURIComponent(sourceId)}`;
    const json = await requestJson('bilibili', url, { headers: BILI_HEADERS });
    const r = json?.result;
    if (!r) return null;
    // 详情接口的字段结构与搜索结果不同，但 mapBiliItem 已经把两种形态都兼容了
    return mapBiliItem(r);
  }

  async function search(source: MediaSource, keyword: string, limit = 10): Promise<MediaCandidate[]> {
    const kw = String(keyword ?? '').trim();
    if (!kw) return [];
    try {
      if (source === 'bangumi') return await bangumiSearch(kw, limit);
      return await bilibiliSearch(kw, limit);
    } catch (e) {
      throw new Error(describeError(e));
    }
  }

  async function detail(source: MediaSource, sourceId: string): Promise<MediaCandidate | null> {
    const id = String(sourceId ?? '').trim();
    if (!id) return null;
    try {
      if (source === 'bangumi') return await bangumiDetail(id);
      return await bilibiliDetail(id);
    } catch (e) {
      throw new Error(describeError(e));
    }
  }

  async function probeAll(): Promise<ProbeResult[]> {
    // 并发探测，两者互相独立（各自有节流，但探测请求 noThrottle）
    return Promise.all([probe('bangumi'), probe('bilibili')]);
  }

  const IMAGE_MAX_BYTES = 12 * 1024 * 1024;
  async function fetchImage(url: string, maxBytes = IMAGE_MAX_BYTES): Promise<{ buffer: Buffer; contentType: string }> {
    const source: MediaSource = /hdslb|bilibili/.test(url) ? 'bilibili' : 'bangumi';
    const resp = await request(source, url, { headers: { Accept: 'image/*' }, noThrottle: true }).catch((e) => {
      throw new Error(describeError(e));
    });
    if (!resp.ok) throw new Error(`下载封面失败 HTTP ${resp.status}`);
    const contentType = String(resp.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > maxBytes) throw new Error(`封面过大（${Math.round(buf.length / 1024 / 1024)}MB，上限 ${Math.round(maxBytes / 1024 / 1024)}MB）`);
    return { buffer: buf, contentType };
  }

  return { probe, probeAll, search, detail, fetchImage };
}

/** 校验 URL 主机是否属于已知图床（防 SSRF） */
export function isAllowedCoverHost(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return COVER_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith('.' + suffix));
  } catch {
    return false;
  }
}

/**
 * 是否为「公网 http(s) 地址」。
 *
 * 用于 /api/images/proxy 这类接受调用方传入 URL 的路由：
 * 原来它对 url 参数完全不校验，等于给页面开了一个可以请求任意地址
 * （含 127.0.0.1 上的本机服务、路由器后台、内网主机）的跳板。
 * 这里只拦真正危险的目标 —— 环回 / 私网 / 链路本地 / 非 FQDN 主机名，
 * 公网地址一律放行，以免限制用户使用任意图床。
 */
export function isPublicHttpUrl(rawUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return false;

  // 非 FQDN（如 router、localhost）一律拒绝：图片地址必然是域名或 IP
  if (host === 'localhost' || !host.includes('.') && !host.includes(':')) return false;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) return false;

  // IPv6 环回 / 唯一本地 / 链路本地
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return false;

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false; // 链路本地 / 云元数据 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // 运营商级 NAT
    if (a >= 224) return false; // 组播 / 保留
  }
  return true;
}
