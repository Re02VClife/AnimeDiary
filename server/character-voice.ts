/**
 * server/character-voice — 抓取「角色原声台词」并拼成 ≥30 秒音频
 *
 * 链路：B 站搜索（WBI 签名）→ 取视频的 DASH 音频流 → 下载 →
 *       ffmpeg silencedetect 找人声段 → 跳过开场音乐取人声密集的一段 →
 *       atrim + concat 拼成单条 mp3 → 落到 {DATA_DIR}/audio/{角色名}/
 *
 * 三条实测出来的硬约束：
 *   1. **必须带 buvid3 cookie**：不带时搜索接口直接 412（Precondition Failed），
 *      所以会话要先打 /x/frontend/finger/spi 换一个匿名 buvid。
 *   2. **wbi 签名必须算**：`/x/web-interface/wbi/search/type` 缺 w_rid 返回 -403。
 *      签名用的 img_key/sub_key 来自 /x/nav，且 img_key 会轮换，不能写死。
 *   3. **音频流要带 Referer**：bilivideo.com 有防盗链，缺 Referer 一律 403。
 *
 * 这里刻意不走 createFetch()（electron/net-fetch 的最小 Response 契约），
 * 因为这条链路需要读 Set-Cookie 维持会话、并且要自定义 Referer ——
 * 那是 fetchImpl 的契约里没有的东西。B 站是国内域名，Node 全局 fetch 直连即可。
 */
import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseSilenceDetect, pickSpeechSpans, sanitizeVoiceName } from '../core/voice-clips';
import type { SpeechSpan } from '../core/voice-clips';
import { parseBiliDuration, rankVoiceCandidates } from '../core/voice-search';
import type { VoiceCandidate } from '../core/voice-search';

const BILI_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/131.0.0.0 Safari/537.36';
const BILI_REFERER = 'https://www.bilibili.com/';

/** 默认目标时长：用户要求「至少 30 秒」，留 5 秒余量避免刚好卡线 */
export const DEFAULT_TARGET_SECONDS = 35;

/** 单次下载上限，防止选到 10 小时「全语音合集」把内存吃掉 */
const MAX_AUDIO_BYTES = 80 * 1024 * 1024;

/** wbi 混淆表（B 站前端固定常量） */
const MIXIN_KEY_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

/** wbi key 缓存时长：img_key 会轮换，但不会秒变，半小时刷新一次足够 */
const WBI_TTL_MS = 30 * 60 * 1000;

export interface VoiceSource {
  bvid: string;
  title: string;
  author: string;
  pageUrl: string;
}

export interface VoiceInfo {
  character: string;
  fileName: string;
  /** 前端播放用的 URL */
  url: string;
  seconds: number;
  /** 拼了哪几段原视频（秒），用于排查「怎么混进了奇怪的东西」 */
  spans: Array<[number, number]>;
  source: VoiceSource;
  builtAt: string;
}

export interface VoiceBuildOptions {
  bvid: string;
  characterName: string;
  targetSeconds?: number;
}

export interface FfmpegStatus {
  ok: boolean;
  path: string | null;
  version: string | null;
  /** 给界面的可执行提示（没装 ffmpeg 时显示） */
  hint: string;
}

export interface VoiceClient {
  ffmpegStatus(): FfmpegStatus;
  search(characterName: string, keyword?: string, workTitles?: string[]): Promise<VoiceCandidate[]>;
  build(options: VoiceBuildOptions): Promise<VoiceInfo>;
  read(characterName: string): VoiceInfo | null;
  remove(characterName: string): boolean;
}

export interface VoiceClientOptions {
  /** 数据根目录；音频落在 {DATA_DIR}/audio/ 下 */
  DATA_DIR: string;
  /** 可注入的 fetch（测试用），缺省用 Node 全局 fetch */
  fetchImpl?: (url: string, init?: any) => Promise<any>;
}

// ── ffmpeg ──

/**
 * 找 ffmpeg。优先环境变量（打包版里用户可能装在 PATH 外），
 * 其次 PATH 里的 ffmpeg / ffmpeg.exe。
 */
export function resolveFfmpeg(): FfmpegStatus {
  const candidates = [process.env.ANIMEDIARY_FFMPEG, 'ffmpeg', 'ffmpeg.exe']
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0);

  for (const exe of candidates) {
    try {
      const result = spawnSync(exe, ['-version'], {
        encoding: 'utf8',
        timeout: 8000,
        windowsHide: true,
      });
      if (result.status === 0) {
        const firstLine = String(result.stdout || '').split('\n')[0]?.trim() ?? '';
        return { ok: true, path: exe, version: firstLine || null, hint: '' };
      }
    } catch {
      // 找不到就试下一个；ENOENT 在这里是常态，不是错误
    }
  }

  return {
    ok: false,
    path: null,
    version: null,
    hint: '没有找到 ffmpeg。装一个（winget install Gyan.FFmpeg / brew install ffmpeg）'
      + '并确保它在 PATH 里，或者设置环境变量 ANIMEDIARY_FFMPEG 指向可执行文件。',
  };
}

/** 跑一次 ffmpeg，把 stderr 原样返回（silencedetect 的输出都在 stderr） */
function runFfmpeg(args: string[], timeoutMs: number): { ok: boolean; stderr: string } {
  const status = resolveFfmpeg();
  if (!status.ok) throw new Error(status.hint);
  const result = spawnSync(status.path!, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  const stderr = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (result.error) throw result.error;
  return { ok: result.status === 0, stderr };
}

/** 检测人声区间。noise/d 的取值见 HANDOVER：-35dB 能滤掉 BGM 尾音，0.6s 不会切断句读 */
function detectSpeech(srcPath: string): SpeechSpan[] {
  const { stderr } = runFfmpeg(
    ['-hide_banner', '-i', srcPath, '-af', 'silencedetect=noise=-35dB:d=0.6', '-f', 'null', '-'],
    180000,
  );
  return parseSilenceDetect(stderr).spans;
}

/** 两段音频在拼接处会爆一下（波形被硬切），每段两端各做 12ms 淡入淡出 */
const FADE_SECONDS = 0.012;

function buildConcatFilter(spans: SpeechSpan[]): string {
  const fixed = (n: number) => n.toFixed(3);
  const trimOf = (span: SpeechSpan, index: number) => {
    const length = span.end - span.start;
    const fade = length > FADE_SECONDS * 3
      ? `,afade=t=in:st=0:d=${FADE_SECONDS},afade=t=out:st=${fixed(length - FADE_SECONDS)}:d=${FADE_SECONDS}`
      : '';
    return `atrim=start=${fixed(span.start)}:end=${fixed(span.end)},asetpts=PTS-STARTPTS${fade}`;
  };

  if (spans.length === 1) {
    return `[0:a]${trimOf(spans[0], 0)}[out]`;
  }

  // 同一个输入流被多次 atrim 引用时必须先 asplit，否则 ffmpeg 报 "Stream specifier matches no streams"
  const split = `[0:a]asplit=${spans.length}${spans.map((_, i) => `[a${i}]`).join('')}`;
  const trims = spans.map((span, i) => `[a${i}]${trimOf(span, i)}[s${i}]`).join(';');
  const concat = `${spans.map((_, i) => `[s${i}]`).join('')}concat=n=${spans.length}:v=0:a=1[out]`;
  return `${split};${trims};${concat}`;
}

/** 把选中的段拼成一条单声道 mp3。40kbps 下 35 秒约 175KB，语音完全够 */
function concatToMp3(srcPath: string, spans: SpeechSpan[], outPath: string): void {
  const { ok, stderr } = runFfmpeg(
    [
      '-hide_banner', '-y',
      '-i', srcPath,
      '-filter_complex', buildConcatFilter(spans),
      '-map', '[out]',
      '-ac', '1', '-ar', '24000', '-b:a', '40k',
      outPath,
    ],
    180000,
  );
  if (!ok) {
    const tail = stderr.split('\n').filter((l) => l.trim()).slice(-6).join('\n');
    throw new Error(`音频拼接失败：\n${tail}`);
  }
}

/** 读出输出文件的真实时长，避免界面显示「说了 35 秒」实际只有 12 秒 */
function probeDuration(filePath: string): number {
  try {
    const { stderr } = runFfmpeg(['-hide_banner', '-i', filePath, '-f', 'null', '-'], 30000);
    const match = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(stderr);
    if (!match) return 0;
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  } catch {
    return 0;
  }
}

// ── B 站会话 ──

interface BiliSession {
  cookies: Map<string, string>;
  imgKey: string;
  subKey: string;
  fetchedAt: number;
}

function md5(text: string): string {
  return crypto.createHash('md5').update(text).digest('hex');
}

/** img_key + sub_key → 32 位 mixing key（B 站 wbi 算法的第一步） */
export function mixinKey(imgKey: string, subKey: string): string {
  const raw = `${imgKey}${subKey}`;
  return MIXIN_KEY_TAB.map((i) => raw[i] ?? '').join('').slice(0, 32);
}

/** 给 query 加 wts 并算 w_rid（B 站 wbi 算法的第二步） */
export function signWbiQuery(
  params: Record<string, string | number>,
  imgKey: string,
  subKey: string,
): string {
  const withTs: Record<string, string | number> = { ...params, wts: Math.round(Date.now() / 1000) };
  const query = Object.keys(withTs)
    .sort()
    .map((key) => {
      const value = String(withTs[key]).replace(/[!'()*]/g, '');
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    })
    .join('&');
  return `${query}&w_rid=${md5(query + mixinKey(imgKey, subKey))}`;
}

function cookieHeader(jar: Map<string, string>): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

/** 读 Set-Cookie。undici 有 getSetCookie()，别的实现只能退化到拼好的字符串 */
function absorbCookies(headers: any, jar: Map<string, string>): void {
  let list: string[] = [];
  if (typeof headers?.getSetCookie === 'function') {
    list = headers.getSetCookie();
  } else {
    const raw = headers?.get?.('set-cookie');
    if (typeof raw === 'string' && raw) {
      // 逗号也可能出现在 Expires 里，只在「, 名字=」的位置切
      list = raw.split(/,(?=\s*[\w.-]+=)/);
    }
  }
  for (const item of list) {
    const first = String(item).split(';')[0];
    const eq = first.indexOf('=');
    if (eq > 0) jar.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
  }
}

async function biliGet(
  doFetch: (url: string, init?: any) => Promise<any>,
  session: BiliSession,
  url: string,
  timeoutMs = 20000,
): Promise<any> {
  const headers: Record<string, string> = {
    'User-Agent': BILI_UA,
    'Referer': BILI_REFERER,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  };
  if (session.cookies.size > 0) headers['Cookie'] = cookieHeader(session.cookies);

  const res = await doFetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  absorbCookies(res?.headers, session.cookies);
  if (!res.ok) throw new Error(`B 站接口返回 HTTP ${res.status}`);
  return res.json();
}

/**
 * 建会话：先换匿名 buvid（不带就 412），再取 wbi key（不签名就 -403）。
 */
async function createSession(
  doFetch: (url: string, init?: any) => Promise<any>,
): Promise<BiliSession> {
  const session: BiliSession = { cookies: new Map(), imgKey: '', subKey: '', fetchedAt: 0 };

  try {
    const spi = await biliGet(doFetch, session, 'https://api.bilibili.com/x/frontend/finger/spi');
    if (spi?.data?.b_3) session.cookies.set('buvid3', String(spi.data.b_3));
    if (spi?.data?.b_4) session.cookies.set('buvid4', String(spi.data.b_4));
  } catch {
    // 拿不到 buvid 也可能碰巧能搜（服务端宽松时），继续往下走
  }

  const nav = await biliGet(doFetch, session, 'https://api.bilibili.com/x/web-interface/nav');
  const pickKey = (url: unknown) => {
    const text = String(url ?? '');
    return text.slice(text.lastIndexOf('/') + 1).split('.')[0];
  };
  session.imgKey = pickKey(nav?.data?.wbi_img?.img_url);
  session.subKey = pickKey(nav?.data?.wbi_img?.sub_url);
  session.fetchedAt = Date.now();

  if (!session.imgKey || !session.subKey) {
    throw new Error('拿不到 B 站的 wbi 签名密钥（/x/web-interface/nav 没返回 wbi_img）');
  }
  return session;
}

/** 视频详情 → 音频流地址。取码率最低的一路：语音用不上高码率，也省下载时间 */
async function resolveAudioStream(
  doFetch: (url: string, init?: any) => Promise<any>,
  session: BiliSession,
  bvid: string,
): Promise<{ streamUrl: string; title: string; author: string; duration: number; cid: number }> {
  const view = await biliGet(
    doFetch,
    session,
    `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
  );
  if (view?.code !== 0 || !view?.data) {
    throw new Error(`取视频信息失败：${view?.message || view?.code || '未知错误'}`);
  }
  const data = view.data;
  const cid = data.cid ?? data.pages?.[0]?.cid;
  if (!cid) throw new Error('这个视频拿不到 cid（可能是番剧/课程，走的是另一套接口）');

  const play = await biliGet(
    doFetch,
    session,
    `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}`
      + `&cid=${cid}&qn=64&fnval=16&fourk=0`,
  );
  const audios: any[] = Array.isArray(play?.data?.dash?.audio) ? play.data.dash.audio : [];
  if (audios.length === 0) {
    const reason = play?.message || (play?.code ? `code ${play.code}` : '没有音频流');
    throw new Error(`拿不到音频流（${reason}）。大会员/付费视频需要登录，换一个视频源试试。`);
  }
  const best = audios.reduce((min, cur) => (cur.bandwidth < min.bandwidth ? cur : min), audios[0]);
  const streamUrl = String(best.baseUrl || best.base_url || '');
  if (!streamUrl) throw new Error('音频流地址为空');

  return {
    streamUrl,
    title: String(data.title ?? ''),
    author: String(data.owner?.name ?? ''),
    duration: Number(data.duration ?? 0),
    cid,
  };
}

// ── 主实现 ──

export function createVoiceClient(options: VoiceClientOptions): VoiceClient {
  const AUDIO_DIR = path.join(options.DATA_DIR, 'audio');
  const doFetch: (url: string, init?: any) => Promise<any> =
    options.fetchImpl ?? ((url, init) => (globalThis as any).fetch(url, init));

  let cached: BiliSession | null = null;
  /** 同一时刻只允许一个 ffmpeg 拼接：并发跑会把 CPU 吃满，而且界面本来也是单个角色在生成 */
  let building = false;

  async function session(): Promise<BiliSession> {
    if (cached && Date.now() - cached.fetchedAt < WBI_TTL_MS) return cached;
    cached = await createSession(doFetch);
    return cached;
  }

  function dirOf(characterName: string): { dir: string; safe: string } {
    const safe = sanitizeVoiceName(characterName);
    return { dir: path.join(AUDIO_DIR, safe), safe };
  }

  return {
    ffmpegStatus: resolveFfmpeg,

    async search(
      characterName: string,
      keyword?: string,
      workTitles: string[] = [],
    ): Promise<VoiceCandidate[]> {
      const role = String(characterName ?? '').trim();
      if (!role) throw new Error('缺少角色名');
      // 带上作品名搜：同名角色太多（蕾娜 / 伊蕾娜 / 女神蕾娜），
      // 只搜角色名会混进完全无关的作品
      const primaryWork = workTitles.map((w) => String(w ?? '').trim()).find((w) => w.length > 0);
      const query = String(keyword ?? '').trim()
        || (primaryWork ? `${role} ${primaryWork} 语音` : `${role} 语音`);

      const current = await session();
      const signed = signWbiQuery(
        { search_type: 'video', keyword: query, page: 1 },
        current.imgKey,
        current.subKey,
      );
      const json = await biliGet(
        doFetch,
        current,
        `https://api.bilibili.com/x/web-interface/wbi/search/type?${signed}`,
      );
      if (json?.code !== 0) {
        throw new Error(`B 站搜索失败：${json?.message || json?.code || '未知错误'}`);
      }

      const raw: any[] = Array.isArray(json?.data?.result) ? json.data.result : [];
      const mapped: VoiceCandidate[] = raw
        .filter((item) => item && item.bvid)
        .map((item) => ({
          bvid: String(item.bvid),
          // 搜索结果的标题带 <em class="keyword"> 高亮标签
          title: String(item.title ?? '').replace(/<[^>]+>/g, ''),
          durationSeconds: parseBiliDuration(item.duration),
          play: Number(item.play ?? 0) || 0,
          author: String(item.author ?? ''),
          coverUrl: item.pic ? `https:${String(item.pic).replace(/^https?:/, '')}` : null,
          pageUrl: `https://www.bilibili.com/video/${item.bvid}`,
          score: 0,
        }));

      return rankVoiceCandidates(mapped, role, workTitles);
    },

    async build({ bvid, characterName, targetSeconds }: VoiceBuildOptions): Promise<VoiceInfo> {
      if (!bvid || !/^BV[0-9A-Za-z]{6,}$/i.test(bvid)) throw new Error('视频 ID 非法');
      const role = String(characterName ?? '').trim();
      if (!role) throw new Error('缺少角色名');
      if (building) throw new Error('正在生成另一个角色的语音，等它完成再试');
      if (!resolveFfmpeg().ok) throw new Error(resolveFfmpeg().hint);

      building = true;
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'animediary-voice-'));
      try {
        const current = await session();
        const meta = await resolveAudioStream(doFetch, current, bvid);

        // 音频流带防盗链，必须自己补 Referer
        const audioRes = await doFetch(meta.streamUrl, {
          headers: { 'User-Agent': BILI_UA, 'Referer': BILI_REFERER },
          signal: AbortSignal.timeout(120000),
        });
        if (!audioRes.ok) throw new Error(`下载音频失败：HTTP ${audioRes.status}（可能被防盗链拦了）`);
        const buffer = Buffer.from(await audioRes.arrayBuffer());
        if (buffer.length === 0) throw new Error('下载到的音频是空的');
        if (buffer.length > MAX_AUDIO_BYTES) {
          throw new Error(`音频有 ${(buffer.length / 1048576).toFixed(1)}MB，超过 80MB 上限，换一个短一点的视频`);
        }

        const srcPath = path.join(tmpDir, 'source.m4a');
        fs.writeFileSync(srcPath, buffer);

        const spans = detectSpeech(srcPath);
        const picked = pickSpeechSpans(spans, targetSeconds ?? DEFAULT_TARGET_SECONDS);
        if (picked.spans.length === 0) {
          throw new Error('这个视频里没检测到可用的人声段（可能是纯音乐/纯字幕），换一个视频源');
        }

        const outPath = path.join(tmpDir, 'voice.mp3');
        concatToMp3(srcPath, picked.spans, outPath);

        const { dir } = dirOf(role);
        fs.mkdirSync(dir, { recursive: true });
        const fileName = 'voice.mp3';
        fs.copyFileSync(outPath, path.join(dir, fileName));

        const seconds = probeDuration(path.join(dir, fileName)) || picked.totalSeconds;
        const info: VoiceInfo = {
          character: role,
          fileName,
          url: `/api/character/voice/file?character=${encodeURIComponent(role)}`,
          seconds: Number(seconds.toFixed(2)),
          spans: picked.spans.map((s) => [Number(s.start.toFixed(2)), Number(s.end.toFixed(2))]),
          source: {
            bvid,
            title: meta.title,
            author: meta.author,
            pageUrl: `https://www.bilibili.com/video/${bvid}`,
          },
          builtAt: new Date().toISOString(),
        };
        fs.writeFileSync(path.join(dir, 'voice.json'), JSON.stringify(info, null, 2), 'utf-8');

        if (!picked.sufficient && seconds < 30) {
          // 不抛错：短一点也比没有强，但要让调用方知道「没到 30 秒」
          info.source.title = `${info.source.title}（源里只找到 ${picked.totalSeconds.toFixed(0)} 秒人声）`;
        }
        return info;
      } finally {
        building = false;
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // 临时目录删不掉不影响结果，下次启动会被系统清理
        }
      }
    },

    read(characterName: string): VoiceInfo | null {
      const { dir } = dirOf(characterName);
      const metaPath = path.join(dir, 'voice.json');
      const audioPath = path.join(dir, 'voice.mp3');
      if (!fs.existsSync(metaPath) || !fs.existsSync(audioPath)) return null;
      try {
        return JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as VoiceInfo;
      } catch {
        return null;
      }
    },

    remove(characterName: string): boolean {
      const { dir } = dirOf(characterName);
      if (!fs.existsSync(dir)) return false;
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    },
  };
}
