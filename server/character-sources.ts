/**
 * 角色元数据获取层（用于「角色评分卡」）
 *
 * 与 media-sources.ts（番剧元数据）并列的另一条链路，刻意保持独立：
 * 两者的端点、节流节奏、失败模式都不一样，混在一起会让番剧补全那条
 * 已经被实测调优过的路径重新承担风险。
 *
 *   1. 只用官方公开接口
 *        - Bangumi : api.bgm.tv/v0/subjects/{id}/characters   角色列表（一次拿全，含声优）
 *                    api.bgm.tv/v0/characters/{id}             角色详情（infobox 里有中文名/生日）
 *                    api.bgm.tv/v0/characters/{id}/subjects    角色的所属作品
 *                    api.bgm.tv/v0/persons/{id}                声优资料（生日/血型/身高）
 *                    api.bgm.tv/v0/search/characters           角色搜索（仅用于兜底，别用来找人，见下）
 *        - AniList : graphql.anilist.co                        只用来**补**字段，不用来找人
 *
 *   2. 角色可以挂在任意类型的作品上（用户要求）
 *        Bangumi subject type: 1=书籍 2=动画 3=音乐 4=游戏 6=三次元。
 *        实测这三类都有角色：动画 / 小说(type 1) / 游戏(type 4)。
 *        而 AniList **没有游戏**（搜「黑神话：悟空」为空），只有 ANIME/MANGA，
 *        所以游戏作品的角色只能拿 Bangumi 的字段（没有年龄/人气）。
 *
 *   3. 为什么 AniList 只能用来「补」
 *        实测 `Page.characters(search:"加藤惠")` 返回 **0 条** —— AniList 的角色搜索
 *        不认中文名。正确姿势是：Bangumi 给日文原名 → AniList 用同一个原名搜 media
 *        → 在该 media 的 characters 里按日文名匹配 → 取 dateOfBirth/age/bloodType/
 *        favourites/description。见 anilistWorkCharacters。
 *
 *   4. 成本控制：detailBudget + 命中即停
 *        角色列表**不自带中文名**（实测 has_name_cn_key = 0），中文名只能从详情
 *        infobox 拿。详情实测 2ms 但要走节流，所以只为「主角/配角 + 排名靠前」的
 *        角色抓详情，并且已记录的名字全部匹配上之后立刻停止，不再继续抓。
 */
import { describeError } from './media-sources';
import type { FetchLike } from './media-sources';
import {
  anilistMediaTypeFor,
  subjectTypeName,
  buildInfoboxMap,
  pickInfobox,
  stripMarkup,
  normalizeBirthday,
  BIRTHDAY_INFOBOX_KEYS,
  BLOOD_TYPE_INFOBOX_KEYS,
  HEIGHT_INFOBOX_KEYS,
  WEIGHT_INFOBOX_KEYS,
  BWH_INFOBOX_KEYS,
  SOURCE_INFOBOX_KEYS,
  sortCharactersByRelation,
  isImportantRelation,
  pickWorkCandidate,
  pickCharacterForName,
  resolveProfile,
  workTitleSimilarity,
  isStrongMatch,
  LOW_CONFIDENCE,
} from '../core/character';
import type {
  WorkCandidate,
  CharacterMatchField,
  CharacterProfile,
} from '../core/character';

const BANGUMI_API = 'https://api.bgm.tv';
const ANILIST_API = 'https://graphql.anilist.co';

/** Bangumi 要求可识别的 UA，缺失会 403 */
const USER_AGENT = 'AnimeDiary/1.0 (https://github.com/anime-diary; personal anime scoring app)';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 串行节流：同一数据源的相邻请求间隔不小于 minIntervalMs */
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

// ── 对外类型 ──

export interface CharacterVoiceActor {
  /** Bangumi person id（可用于再查声优详情） */
  sourceId: string;
  name: string;
  imageUrl: string | null;
  summary: string | null;
}

export interface CharacterEntry {
  /** Bangumi character id */
  sourceId: string;
  /** 原名（日文） */
  name: string;
  /** 简体中文名（来自详情 infobox；未抓详情时为 null） */
  nameCn: string | null;
  /** 主角 / 配角 / 闲角 */
  relation: string;
  /** Bangumi 人设简介（日文短文） */
  summary: string | null;
  aliases: string[];
  gender: string | null;
  /** 归一化后的 MM-DD */
  birthday: string | null;
  bloodType: string | null;
  height: string | null;
  weight: string | null;
  bwh: string | null;
  referenceUrl: string | null;
  /** 立绘（大图，用于角色卡海报） */
  imageUrl: string | null;
  /** 立绘缩略图（列表展示用） */
  imageThumbUrl: string | null;
  voiceActors: CharacterVoiceActor[];
  /** 所属作品（可能多个） */
  works: WorkCandidate[];
  /** AniList 补充字段 */
  aniListId: number | null;
  age: string | null;
  /** AniList 收藏数，作为人气参考 */
  popularity: number | null;
  /** 详细人设（AniList description 优先，回退 Bangumi summary），含来源与语言 */
  profile: CharacterProfile | null;
  /** 是否已抓过详情 —— 决定 nameCn/birthday 等字段是「确实没有」还是「还没抓」 */
  detailLoaded: boolean;
}

export interface CharacterResolveOptions {
  /** 直接给 Bangumi subject id（最可靠，省掉一次搜索） */
  subjectId?: string | number;
  /** 或者给作品名，由服务端搜索后匹配 */
  workTitle?: string;
  /**
   * 作品类型过滤。**建议一定要传**：搜「路人女主的养成方法」的前三个结果
   * 全是书籍(type 1) 而不是剧场版动画(type 2)，不过滤会把角色挂到轻小说上。
   */
  types?: number[];
  /** 只解析这些已记录的角色名；为空则按关系排序取前 detailBudget 个 */
  names?: string[];
  /** 是否用 AniList 补生日/年龄/人气/详细人设 */
  withAniList?: boolean;
  /** 最多为多少个角色抓详情 */
  detailBudget?: number;
}

export interface CharacterResolveMatch {
  /** 用户记录的名字 */
  name: string;
  /**
   * 置信度足够、可以直接写入的匹配；为 null 时表示**没有可信匹配**，
   * 此时 score/matchedOn 里保留的是「最佳候选」，仅供人工确认，不可自动写入。
   */
  character: CharacterEntry | null;
  score: number;
  matchedOn: CharacterMatchField | null;
  matchedValue: string | null;
  /** true = 只有低置信候选，需要人工确认 */
  lowConfidence: boolean;
}

export interface CharacterResolveResult {
  work: WorkCandidate | null;
  /** 作品名匹配分数；低于 LOW_CONFIDENCE 表示「可能不是我认的那部作品」 */
  workScore: number;
  workLowConfidence: boolean;
  /** 待选/已匹配的角色（按关系排序） */
  characters: CharacterEntry[];
  matches: CharacterResolveMatch[];
  stats: {
    listMs: number;
    detailCalls: number;
    anilistUsed: boolean;
    anilistMs: number;
    totalCharacters: number;
  };
  errors: string[];
}

export interface CharacterClientOptions {
  /** 网络出口。Electron 传 net.fetch（遵守系统代理），dev 传全局 fetch。 */
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  retries?: number;
}

export interface CharacterClient {
  /** 按标题搜作品（Bangumi v0 搜索），返回带 type 的候选 */
  searchWorks(keyword: string, types?: number[], limit?: number): Promise<WorkCandidate[]>;
  /** 作品的角色列表（1 次请求拿全，含立绘与声优） */
  listCharacters(subjectId: string | number): Promise<CharacterEntry[]>;
  /** 角色详情（infobox → 中文名/生日/血型/身高/体重/BWH/引用来源） */
  getCharacter(sourceId: string | number): Promise<CharacterEntry | null>;
  /** 角色出现在哪些作品里 */
  getCharacterWorks(sourceId: string | number): Promise<WorkCandidate[]>;
  /** 声优详情（生日/血型/身高/出生地/事务所） */
  getPerson(sourceId: string | number): Promise<{ sourceId: string; name: string; imageUrl: string | null; infobox: Record<string, string>; summary: string | null } | null>;
  /**
   * 角色搜索。**不要用它来给「用户记录的名字」找人** —— 同名太多
   * （「蕾娜」有 892 条），只在已知角色 id 缺失时兜底。
   */
  searchCharacters(keyword: string, limit?: number): Promise<CharacterEntry[]>;
  /** 一站式解析：作品 → 角色列表 → 匹配已记录的名字 → （可选）AniList 补字段 */
  resolve(options: CharacterResolveOptions): Promise<CharacterResolveResult>;
}

export function createCharacterClient(options: CharacterClientOptions = {}): CharacterClient {
  const timeoutMs = options.timeoutMs ?? 10000;
  const retries = options.retries ?? 1;
  const injected = options.fetchImpl;
  const doFetch: FetchLike = injected ?? ((url, init) => (globalThis as any).fetch(url, init));

  // Bangumi 实测 12 次连发无 429；但角色补全的请求量比番剧大（每个作品可能几十次详情），
  // 留 400ms 间隔（≈2.5 req/s）既不会被风控，批量也不会太慢。
  const bangumiThrottle = createThrottle(400);
  // AniList 公开接口限流较紧，且一次 GraphQL 就返回整个作品的角色，调用次数本来就少
  const anilistThrottle = createThrottle(900);

  async function request(
    throttle: () => Promise<void>,
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string; noThrottle?: boolean } = {},
  ): Promise<{ status: number; ok: boolean; text: string }> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (!init.noThrottle) await throttle();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const resp = await doFetch(url, {
          method: init.method ?? 'GET',
          headers: {
            'User-Agent': USER_AGENT,
            'Accept-Language': 'zh-CN,zh;q=0.9,ja;q=0.8',
            ...(init.headers ?? {}),
          },
          body: init.body,
          signal: controller.signal,
        });
        clearTimeout(timer);
        // 429 / 5xx 才值得重试
        if ((resp.status === 429 || resp.status >= 500) && attempt < retries) {
          lastError = new Error(`HTTP ${resp.status}`);
          await sleep(600 * (attempt + 1));
          continue;
        }
        return { status: resp.status, ok: resp.ok, text: await resp.text() };
      } catch (e) {
        clearTimeout(timer);
        lastError = e;
        if (attempt < retries) {
          await sleep(500 * (attempt + 1));
          continue;
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async function getJson(throttle: () => Promise<void>, url: string, init?: Parameters<typeof request>[2]): Promise<any> {
    const resp = await request(throttle, url, init);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    try {
      return JSON.parse(resp.text);
    } catch {
      throw new Error('响应不是合法 JSON');
    }
  }

  // ── Bangumi：作品搜索 ──
  async function searchWorks(keyword: string, types?: number[], limit = 10): Promise<WorkCandidate[]> {
    const filter = types && types.length > 0 ? { type: types } : undefined;
    const json = await getJson(
      bangumiThrottle,
      `${BANGUMI_API}/v0/search/subjects?limit=${limit}&offset=0`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(filter ? { keyword, filter } : { keyword }),
      },
    );
    const list: any[] = Array.isArray(json?.data) ? json.data : [];
    return list.map((item) => ({
      sourceId: String(item.id),
      type: Number(item.type),
      title: String(item.name ?? ''),
      titleCn: String(item.name_cn || item.name || ''),
      releaseDate: item.date ? String(item.date) : null,
    }));
  }

  // ── Bangumi：角色列表 ──
  function mapVoiceActors(raw: unknown): CharacterVoiceActor[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((a) => a && typeof a === 'object')
      .map((a: any) => ({
        sourceId: String(a.id ?? ''),
        name: String(a.name ?? ''),
        imageUrl: a.images ? String(a.images.grid || a.images.medium || a.images.large || '') || null : null,
        summary: a.short_summary ? String(a.short_summary) : null,
      }));
  }

  function mapListedCharacter(raw: any): CharacterEntry {
    // 简介要先清掉 BBCode/HTML 标记（Bangumi 的 summary 里混着 [i]…[/i] 和 CRLF）
    const summary = raw?.summary ? stripMarkup(String(raw.summary)) : null;
    return {
      sourceId: String(raw?.id ?? ''),
      name: String(raw?.name ?? ''),
      // 角色列表**不带中文名**（实测），要详情里才有
      nameCn: raw?.name_cn ? String(raw.name_cn) : null,
      relation: String(raw?.relation ?? ''),
      summary,
      aliases: [],
      gender: null,
      birthday: null,
      bloodType: null,
      height: null,
      weight: null,
      bwh: null,
      referenceUrl: null,
      imageUrl: raw?.images ? String(raw.images.large || raw.images.medium || '') || null : null,
      imageThumbUrl: raw?.images ? String(raw.images.grid || raw.images.medium || '') || null : null,
      voiceActors: mapVoiceActors(raw?.actors),
      works: [],
      aniListId: null,
      age: null,
      popularity: null,
      profile: resolveProfile(summary, null),
      detailLoaded: false,
    };
  }

  async function listCharacters(subjectId: string | number): Promise<CharacterEntry[]> {
    const json = await getJson(bangumiThrottle, `${BANGUMI_API}/v0/subjects/${encodeURIComponent(String(subjectId))}/characters`);
    const list: any[] = Array.isArray(json) ? json : [];
    return sortCharactersByRelation(list.map(mapListedCharacter));
  }

  // ── Bangumi：角色详情（中文名/生日/血型…都在 infobox 里）──
  async function getCharacter(sourceId: string | number): Promise<CharacterEntry | null> {
    const json = await getJson(bangumiThrottle, `${BANGUMI_API}/v0/characters/${encodeURIComponent(String(sourceId))}`);
    if (!json || json.id === undefined) return null;
    const infobox = buildInfoboxMap(json.infobox);
    const summary = json.summary ? stripMarkup(String(json.summary)) : null;
    const aliasesText = pickInfobox(infobox, ['别名', '別名']);
    return {
      sourceId: String(json.id),
      name: String(json.name ?? ''),
      nameCn: json.name_cn
        ? String(json.name_cn)
        : pickInfobox(infobox, ['简体中文名', '简体中文名(译名)', '中文名']),
      relation: String(json.relation ?? ''),
      summary,
      // 别名压平成一串（'英文名：Frieren / 昵称：…'），再把 '标签：' 去掉当作独立别名
      aliases: aliasesText
        ? aliasesText.split(' / ').map((part) => part.replace(/^[^：:]{1,8}[：:]/, '').trim()).filter(Boolean)
        : [],
      gender: json.gender
        ? String(json.gender)
        : pickInfobox(infobox, ['性别', '性別']),
      birthday: normalizeBirthday(pickInfobox(infobox, BIRTHDAY_INFOBOX_KEYS), json.birth_mon, json.birth_day),
      bloodType: pickInfobox(infobox, BLOOD_TYPE_INFOBOX_KEYS),
      height: pickInfobox(infobox, HEIGHT_INFOBOX_KEYS),
      weight: pickInfobox(infobox, WEIGHT_INFOBOX_KEYS),
      bwh: pickInfobox(infobox, BWH_INFOBOX_KEYS),
      referenceUrl: pickInfobox(infobox, SOURCE_INFOBOX_KEYS),
      imageUrl: json.images ? String(json.images.large || json.images.medium || '') || null : null,
      imageThumbUrl: json.images ? String(json.images.grid || json.images.medium || '') || null : null,
      voiceActors: [],
      works: [],
      aniListId: null,
      age: null,
      popularity: null,
      profile: resolveProfile(summary, null),
      detailLoaded: true,
    };
  }

  // ── Bangumi：角色的所属作品 ──
  async function getCharacterWorks(sourceId: string | number): Promise<WorkCandidate[]> {
    const json = await getJson(bangumiThrottle, `${BANGUMI_API}/v0/characters/${encodeURIComponent(String(sourceId))}/subjects`);
    const list: any[] = Array.isArray(json) ? json : [];
    return list.map((item) => ({
      sourceId: String(item.id),
      type: Number(item.type),
      title: String(item.name ?? ''),
      titleCn: String(item.name_cn || item.name || ''),
      releaseDate: item.date ? String(item.date) : null,
    }));
  }

  // ── Bangumi：声优资料 ──
  async function getPerson(sourceId: string | number) {
    const json = await getJson(bangumiThrottle, `${BANGUMI_API}/v0/persons/${encodeURIComponent(String(sourceId))}`);
    if (!json || json.id === undefined) return null;
    return {
      sourceId: String(json.id),
      name: String(json.name ?? ''),
      imageUrl: json.images ? String(json.images.grid || json.images.medium || '') || null : null,
      infobox: buildInfoboxMap(json.infobox),
      summary: json.summary ? stripMarkup(String(json.summary)) : null,
    };
  }

  // ── Bangumi：角色搜索（兜底用）──
  async function searchCharacters(keyword: string, limit = 10): Promise<CharacterEntry[]> {
    const json = await getJson(
      bangumiThrottle,
      `${BANGUMI_API}/v0/search/characters?limit=${limit}&offset=0`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword }),
      },
    );
    const list: any[] = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
    // 搜索结果的形态和详情一致（带 infobox），所以直接按详情解析，省一次请求
    return list.map((item) => {
      const infobox = buildInfoboxMap(item.infobox);
      return {
        ...mapListedCharacter(item),
        nameCn: item.name_cn ? String(item.name_cn) : pickInfobox(infobox, ['简体中文名', '中文名']),
        gender: item.gender ? String(item.gender) : pickInfobox(infobox, ['性别']),
        birthday: normalizeBirthday(pickInfobox(infobox, BIRTHDAY_INFOBOX_KEYS), item.birth_mon, item.birth_day),
        bloodType: pickInfobox(infobox, BLOOD_TYPE_INFOBOX_KEYS),
        height: pickInfobox(infobox, HEIGHT_INFOBOX_KEYS),
        aliases: (() => {
          const text = pickInfobox(infobox, ['别名', '別名']);
          return text ? text.split(' / ').map((p) => p.replace(/^[^：:]{1,8}[：:]/, '').trim()).filter(Boolean) : [];
        })(),
        detailLoaded: true,
      } as CharacterEntry;
    });
  }

  // ── AniList：作品角色（用来补生日/年龄/人气/详细人设）──
  const ANILIST_QUERY = `
    query ($search: String, $type: MediaType) {
      Page(perPage: 5) {
        media(search: $search, type: $type) {
          id
          title { native romaji english }
          format
          characters(page: 1, perPage: 50, sort: [ROLE, ROLE_DESC]) {
            pageInfo { total }
            edges {
              role
              node {
                id
                name { full native }
                image { large }
                age
                gender
                bloodType
                favourites
                description(asHtml: false)
                dateOfBirth { year month day }
              }
              voiceActors(language: JAPANESE) {
                id
                name { full }
                image { large }
              }
            }
          }
        }
      }
    }`;

  interface AniListCharacter {
    id: number;
    nameNative: string;
    nameFull: string;
    age: string | null;
    gender: string | null;
    bloodType: string | null;
    favourites: number | null;
    description: string | null;
    birthday: string | null;
    imageUrl: string | null;
    voiceActorName: string | null;
  }

  async function anilistWorkCharacters(
    workTitle: string,
    mediaType: 'ANIME' | 'MANGA',
  ): Promise<{ characters: AniListCharacter[]; mediaTitle: string | null; ms: number }> {
    const started = Date.now();
    const resp = await request(anilistThrottle, ANILIST_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: ANILIST_QUERY, variables: { search: workTitle, type: mediaType } }),
    });
    const ms = Date.now() - started;
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = JSON.parse(resp.text);
    if (json.errors && json.errors.length > 0) throw new Error(String(json.errors[0]?.message ?? 'GraphQL 错误'));
    const media: any[] = json?.data?.Page?.media ?? [];
    if (media.length === 0) return { characters: [], mediaTitle: null, ms };

    // 取标题最接近的那个 media：AniList 的 search 会返回同名不同季的作品
    let best = media[0];
    let bestScore = -1;
    for (const item of media) {
      const score = Math.max(
        workTitleSimilarity(workTitle, item.title?.native ?? ''),
        workTitleSimilarity(workTitle, item.title?.romaji ?? ''),
        workTitleSimilarity(workTitle, item.title?.english ?? ''),
      );
      if (score > bestScore) {
        bestScore = score;
        best = item;
      }
    }

    const edges: any[] = best?.characters?.edges ?? [];
    const characters: AniListCharacter[] = edges
      .filter((edge) => edge && edge.node)
      .map((edge) => {
        const node = edge.node;
        const japaneseVa = Array.isArray(edge.voiceActors) && edge.voiceActors[0] ? edge.voiceActors[0] : null;
        return {
          id: Number(node.id),
          nameNative: String(node.name?.native ?? ''),
          nameFull: String(node.name?.full ?? ''),
          age: node.age ? String(node.age) : null,
          gender: node.gender ? String(node.gender) : null,
          bloodType: node.bloodType ? String(node.bloodType) : null,
          favourites: typeof node.favourites === 'number' ? node.favourites : null,
          description: node.description ? stripMarkup(String(node.description)) : null,
          birthday: normalizeBirthday(null, node.dateOfBirth?.month, node.dateOfBirth?.day),
          imageUrl: node.image?.large ? String(node.image.large) : null,
          voiceActorName: japaneseVa?.name?.full ? String(japaneseVa.name.full) : null,
        };
      });
    return { characters, mediaTitle: String(best?.title?.native ?? ''), ms };
  }

  /** 在 AniList 角色里按日文名匹配（AniList 的 native 就是日文名，和 Bangumi 同源） */
  function matchAniListCharacter(
    character: CharacterEntry,
    pool: AniListCharacter[],
  ): AniListCharacter | null {
    const probes = [character.name, character.nameCn, ...character.aliases].filter(Boolean) as string[];
    let best: AniListCharacter | null = null;
    let bestScore = 0;
    for (const candidate of pool) {
      for (const probe of probes) {
        for (const name of [candidate.nameNative, candidate.nameFull]) {
          if (!name) continue;
          const score = workTitleSimilarity(probe, name); // 同一套归一化逻辑
          if (score > bestScore) {
            bestScore = score;
            best = candidate;
          }
        }
      }
    }
    // 阈值刻意高：宁可少补字段，也不要把别的角色的生日写到这张卡上
    return bestScore >= 0.9 ? best : null;
  }

  // ── 一站式解析 ──
  async function resolve(opts: CharacterResolveOptions): Promise<CharacterResolveResult> {
    const errors: string[] = [];
    const detailBudget = opts.detailBudget ?? 40;
    const names = (opts.names ?? []).map((n) => String(n).trim()).filter(Boolean);

    // 1) 确定作品
    let work: WorkCandidate | null = null;
    let workScore = 1;
    if (opts.subjectId !== undefined && opts.subjectId !== null && String(opts.subjectId).trim()) {
      const subjectId = String(opts.subjectId).trim();
      try {
        const json = await getJson(bangumiThrottle, `${BANGUMI_API}/v0/subjects/${encodeURIComponent(subjectId)}`);
        work = {
          sourceId: subjectId,
          type: Number(json?.type),
          title: String(json?.name ?? ''),
          titleCn: String(json?.name_cn || json?.name || ''),
          releaseDate: json?.date ? String(json.date) : null,
        };
      } catch (e) {
        errors.push(`取作品信息失败：${describeError(e)}`);
      }
    } else if (opts.workTitle) {
      try {
        const candidates = await searchWorks(opts.workTitle, opts.types, 10);
        const picked = pickWorkCandidate(candidates, opts.workTitle, opts.types);
        if (picked) {
          work = picked.item;
          workScore = picked.score;
        } else {
          errors.push(
            opts.types && opts.types.length
              ? `没搜到类型匹配的作品（type ∈ ${opts.types.join(',')}）`
              : '没搜到匹配的作品',
          );
        }
      } catch (e) {
        errors.push(`搜索作品失败：${describeError(e)}`);
      }
    } else {
      errors.push('必须提供 subjectId 或 workTitle');
    }

    if (!work) {
      return {
        work: null,
        workScore,
        workLowConfidence: true,
        characters: [],
        matches: names.map((name) => ({ name, character: null, score: 0, matchedOn: null, matchedValue: null, lowConfidence: true })),
        stats: { listMs: 0, detailCalls: 0, anilistUsed: false, anilistMs: 0, totalCharacters: 0 },
        errors,
      };
    }

    // 2) 角色列表（1 次请求拿全，含立绘与声优）
    let characters: CharacterEntry[] = [];
    const listStarted = Date.now();
    try {
      characters = await listCharacters(work.sourceId);
    } catch (e) {
      errors.push(`取角色列表失败：${describeError(e)}`);
    }
    const listMs = Date.now() - listStarted;

    // 3) 只为「需要的人」抓详情：有 names 时优先匹配它们，无 names 时按关系取前 N 个。
    //    已记录的名字全部匹配上就立刻停 —— 这是控制请求量的关键。
    const detailOrder = characters.filter((c) => isImportantRelation(c.relation));
    const detailPool = (detailOrder.length > 0 ? detailOrder : characters).slice(0, detailBudget);
    const matches: CharacterResolveMatch[] = names.map((name) => ({
      name,
      character: null,
      score: 0,
      matchedOn: null,
      matchedValue: null,
      lowConfidence: true,
    }));
    let detailCalls = 0;

    /**
     * 用当前已抓到详情的角色**整体重算**一遍匹配。
     *
     * 刻意不做增量合并：之前写成「分数变高才覆盖」时，一个 0 分的匹配会被当成
     * 已命中并锁死（「安艺伦也」→「霞之丘诗羽」），还会让 allMatched() 提前返回 true、
     * 只抓 1 个详情就停止。整体重算是幂等的，且天然只接受达到阈值的匹配。
     */
    const recompute = () => {
      for (const match of matches) {
        // 阈值内的可信匹配
        const confident = pickCharacterForName(characters, match.name);
        // 最佳候选（含低分），用于给界面展示「最接近的是谁」
        const loose = pickCharacterForName(characters, match.name, 0);
        if (loose) {
          match.score = loose.score;
          match.matchedOn = loose.matchedOn;
          match.matchedValue = loose.matchedValue;
        }
        match.character = confident ? confident.item : null;
        match.lowConfidence = !confident;
        if (confident) {
          match.score = confident.score;
          match.matchedOn = confident.matchedOn;
          match.matchedValue = confident.matchedValue;
        }
      }
    };
    /**
     * 是否所有待匹配名字都已拿到**强**匹配，可以停止继续抓详情。
     *
     * 这里用 HIGH_CONFIDENCE 而不是 LOW_CONFIDENCE：只要 ≥0.6 就停，
     * 一个靠别名包含得来的 0.78 会把真正的角色挡在外面（实测：「星野爱」被
     * 0.783 匹配成共用姓氏的儿子「星野愛久愛海」，真正的「星野アイ」详情还没抓）。
     */
    const allMatched = () =>
      matches.length > 0 && matches.every((m) => m.character !== null && isStrongMatch(m.score));

    if (names.length === 0) {
      // 浏览模式：把排名靠前的角色的详情都抓回来，供界面挑选
      for (const character of detailPool) {
        try {
          const detail = await getCharacter(character.sourceId);
          if (detail) {
            const merged = mergeDetail(character, detail);
            const index = characters.findIndex((c) => c.sourceId === character.sourceId);
            if (index >= 0) characters[index] = merged;
            detailCalls++;
          }
        } catch (e) {
          errors.push(`角色详情失败（${character.name}）：${describeError(e)}`);
        }
      }
    } else {
      for (const character of detailPool) {
        if (allMatched()) break;
        try {
          const detail = await getCharacter(character.sourceId);
          if (detail) {
            const merged = mergeDetail(character, detail);
            const index = characters.findIndex((c) => c.sourceId === character.sourceId);
            if (index >= 0) characters[index] = merged;
            detailCalls++;
            recompute();
          }
        } catch (e) {
          errors.push(`角色详情失败（${character.name}）：${describeError(e)}`);
        }
      }
      recompute();
    }

    // 4) AniList 补充（生日/年龄/人气/详细人设）
    let anilistUsed = false;
    let anilistMs = 0;
    const mediaType = anilistMediaTypeFor(work.type);
    if (opts.withAniList && !mediaType) {
      // 游戏(type 4) / 音乐 / 三次元 在 AniList 里没有对应条目，这不是失败，只是能力边界
      errors.push(`AniList 不覆盖「${subjectTypeName(work.type)}」类作品，已跳过 AniList 补充`);
    }
    if (opts.withAniList && mediaType) {
      try {
        const result = await anilistWorkCharacters(work.title, mediaType);
        anilistMs = result.ms;
        anilistUsed = result.characters.length > 0;
        if (anilistUsed) {
          const targets = names.length > 0
            ? Array.from(new Set(matches.map((m) => m.character).filter(Boolean) as CharacterEntry[]))
            : characters;
          for (const character of targets) {
            const ani = matchAniListCharacter(character, result.characters);
            if (!ani) continue;
            character.aniListId = ani.id;
            character.age = ani.age;
            character.popularity = ani.favourites;
            character.birthday = character.birthday ?? ani.birthday;
            character.bloodType = character.bloodType ?? ani.bloodType;
            character.gender = character.gender ?? ani.gender;
            // 详细人设：AniList 的更长，resolveProfile 会取长的那份
            character.profile = resolveProfile(character.summary, ani.description);
            // Bangumi 有 7/91 的角色没有声优记录，用 AniList 的日语 CV 兜底
            if (character.voiceActors.length === 0 && ani.voiceActorName) {
              character.voiceActors = [{ sourceId: '', name: ani.voiceActorName, imageUrl: null, summary: null }];
            }
          }
        } else {
          errors.push('AniList 没找到对应作品的角色（游戏类作品 AniList 不覆盖）');
        }
      } catch (e) {
        errors.push(`AniList 补充失败：${describeError(e)}`);
      }
    }

    return {
      work,
      workScore,
      workLowConfidence: workScore < LOW_CONFIDENCE,
      characters,
      matches,
      stats: {
        listMs,
        detailCalls,
        anilistUsed,
        anilistMs,
        totalCharacters: characters.length,
      },
      errors,
    };
  }

  /** 把列表项与详情合并：详情给中文名/生日，列表给立绘/声优/关系 */
  function mergeDetail(listed: CharacterEntry, detail: CharacterEntry): CharacterEntry {
    return {
      ...listed,
      nameCn: detail.nameCn ?? listed.nameCn,
      gender: detail.gender ?? listed.gender,
      birthday: detail.birthday ?? listed.birthday,
      bloodType: detail.bloodType ?? listed.bloodType,
      height: detail.height ?? listed.height,
      weight: detail.weight ?? listed.weight,
      bwh: detail.bwh ?? listed.bwh,
      referenceUrl: detail.referenceUrl ?? listed.referenceUrl,
      aliases: detail.aliases.length > 0 ? detail.aliases : listed.aliases,
      // 详情不返回 actors/relation，保留列表里的
      voiceActors: listed.voiceActors.length > 0 ? listed.voiceActors : detail.voiceActors,
      // 立绘优先用详情的大图（列表给的是 medium）
      imageUrl: detail.imageUrl ?? listed.imageUrl,
      profile: resolveProfile(listed.summary, null),
      detailLoaded: true,
    };
  }

  return {
    searchWorks,
    listCharacters,
    getCharacter,
    getCharacterWorks,
    getPerson,
    searchCharacters,
    resolve,
  };
}
