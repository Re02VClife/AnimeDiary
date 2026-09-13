/**
 * 番剧元数据补全 —— 客户端服务层
 *
 * 与 server/media-sources.ts 一一对应，负责把「源状态 → 搜索 → 挑最佳匹配 →
 * 下图到本地 → 生成字段补丁」这条链路串起来。
 *
 * 设计原则（承接此前的教训）：
 *   1. 绝不自动写 Excel —— 只产出「建议」，由界面让用户过目后再写。
 *   2. 跨源数据不得混用：B 站评分 ≠ Bangumi 评分，见 ExcelPatch 的注释。
 *   3. 图片一律先下载到本地再入库，杜绝外链失效。
 */

export type MediaSource = 'bangumi' | 'bilibili';

export const SOURCE_LABEL: Record<MediaSource, string> = {
  bangumi: 'Bangumi',
  bilibili: 'Bilibili',
};

/** 与 server/media-sources.ts 的 MediaCandidate 保持一致 */
export interface MediaCandidate {
  source: MediaSource;
  sourceId: string;
  title: string;
  titleCn: string;
  aliases: string[];
  coverUrl: string;
  score: number | null;
  releaseDate: string | null;
  episodes: number | null;
  studio: string | null;
  tags: string[];
  summary: string;
  link: string;
}

export interface SourceStatus {
  source: MediaSource;
  ok: boolean;
  latencyMs: number;
  error?: string;
}

/** 探测各数据源连通性（服务端有 120s 缓存，force 可强制重探） */
export async function probeSources(force = false): Promise<SourceStatus[]> {
  const resp = await fetch(`/api/media/sources${force ? '?force=1' : ''}`);
  if (!resp.ok) throw new Error(`探测失败 HTTP ${resp.status}`);
  const data = await resp.json();
  return Array.isArray(data.sources) ? data.sources : [];
}

export interface SearchOutcome {
  candidates: MediaCandidate[];
  errors: Record<string, string>;
}

/** 搜索候选条目。source='auto' 时服务端会并行查询所有可用源并合并 */
export async function searchCandidates(
  keyword: string,
  source: MediaSource | 'auto' = 'auto',
  limit = 8,
): Promise<SearchOutcome> {
  const resp = await fetch(
    `/api/media/search?keyword=${encodeURIComponent(keyword)}&source=${source}&limit=${limit}`,
  );
  if (!resp.ok) throw new Error(`搜索失败 HTTP ${resp.status}`);
  const data = await resp.json();
  return {
    candidates: Array.isArray(data.candidates) ? data.candidates : [],
    errors: data.errors || {},
  };
}

/** 取单条详情（补全搜索列表里没有的制作组 / 上映年月 / 集数 / 简介） */
export async function fetchDetail(source: MediaSource, sourceId: string): Promise<MediaCandidate | null> {
  const resp = await fetch(`/api/media/subject?source=${source}&id=${encodeURIComponent(sourceId)}`);
  if (!resp.ok) throw new Error(`取详情失败 HTTP ${resp.status}`);
  const data = await resp.json();
  // 服务端有响应上限，超时会以 error 形式回来 —— 让调用方能在日志里说清原因，
  // 但它不是致命错误：封面与写入都不依赖详情字段。
  if (data.error) throw new Error(data.error);
  return data.candidate || null;
}

export interface DownloadedCover {
  /** 本地地址 /api/images/file?anime=…&file=… */
  url: string;
  fileName: string;
  bytes: number;
}

/** 把远程封面下载到本地 images/{番剧名}/，返回本地地址 */
export async function downloadCover(animeTitle: string, coverUrl: string): Promise<DownloadedCover> {
  const resp = await fetch('/api/media/fetch-cover', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ animeTitle, url: coverUrl }),
  });
  const data = await resp.json().catch(() => ({ error: '响应解析失败' }));
  if (!resp.ok || data.error) throw new Error(data.error || `HTTP ${resp.status}`);
  return { url: data.url, fileName: data.fileName, bytes: data.bytes };
}

// ── 标题匹配 ──

/**
 * 归一化标题，用于相似度比较：
 *   全角转半角、去空格、去各种标点与装饰符、转小写。
 * 例：「Re：从零开始的异世界生活 2」与「Re: 从零开始的异世界生活2」应归一为同一串。
 */
export function normalizeTitle(input: string): string {
  return String(input || '')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .toLowerCase()
    .replace(/[\s\-_~·・,，.。:：;；!！?？'"“”‘’()（）\[\]【】{}<>《》/\\|+&*#@$%^=]/g, '');
}

/** 字符二元组集合（中文标题用 bigram 比单词切分更稳） */
function bigrams(s: string): Set<string> {
  const set = new Set<string>();
  if (s.length <= 1) {
    if (s) set.add(s);
    return set;
  }
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

/**
 * 标题相似度 0~1。
 * 完全相等 → 1；互相包含 → 0.75~1（按长度比缩放）；其余走 Dice 系数（上限 0.75）。
 */
export function titleSimilarity(a: string, b: string): number {
  const x = normalizeTitle(a);
  const y = normalizeTitle(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) {
    const ratio = Math.min(x.length, y.length) / Math.max(x.length, y.length);
    return 0.75 + 0.25 * ratio;
  }
  const bx = bigrams(x);
  const by = bigrams(y);
  let inter = 0;
  for (const g of bx) if (by.has(g)) inter++;
  if (bx.size + by.size === 0) return 0;
  return (2 * inter) / (bx.size + by.size) * 0.75;
}

export interface MatchResult {
  candidate: MediaCandidate;
  /** 0~1，越低越需要人工确认 */
  score: number;
}

const CN_DIGIT: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  十一: 11, 十二: 12,
};

/** 解析「2 / 二 / 十二」这类数字 */
function parseCount(s: string): number | null {
  if (/^\d+$/.test(s)) return Number(s);
  return CN_DIGIT[s] ?? null;
}

/**
 * 提取标题里的「季/期/部」序号，没有则返回 null。
 *
 * 为什么需要它：这份数据里续作极多（RE:Zero4、我推的孩子2/3、无职转生2、
 * 间谍过家家 part1/part2…），而单靠标题相似度会**系统性偏向短标题** ——
 * 「我心里危险的东西」是「我心里危险的东西2」的子串，按"互相包含"规则能拿
 * 0.975 分，于是第一季反而赢过真正的第二季。必须把季数显式比出来。
 */
export function seasonMark(raw: string): number | null {
  const s = normalizeTitle(raw);
  if (!s) return null;
  // 第N季 / 第N期 / 第N部 / 第N章 / 第N部分
  let m = s.match(/第(\d+|[一二三四五六七八九十]+)(?:季|期|部|章|篇|部分)/);
  if (m) return parseCount(m[1]);
  // part N / season N / series N
  m = s.match(/(?:part|season|series)(\d+)/);
  if (m) return Number(m[1]);
  // Unicode 罗马数字 Ⅰ-Ⅹ
  const roman: Record<string, number> = {
    'ⅰ': 1, 'ⅱ': 2, 'ⅲ': 3, 'ⅳ': 4, 'ⅴ': 5, 'ⅵ': 6, 'ⅶ': 7, 'ⅷ': 8, 'ⅸ': 9, 'ⅹ': 10,
  };
  for (const [ch, n] of Object.entries(roman)) if (s.endsWith(ch)) return n;
  // 末尾的 II/III/IV（仅限跟在非拉丁字母之后，避免误伤以 i 结尾的英文词）
  m = s.match(/(?:^|[^a-z])(ii|iii|iv)$/);
  if (m) return { ii: 2, iii: 3, iv: 4 }[m[1]] ?? null;
  // 末尾阿拉伯数字（「我推的孩子3」「relife2」），排除 4 位数的年份
  m = s.match(/(\d+)$/);
  if (m) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 20) return n;
  }
  return null;
}

/**
 * 去掉季数标记后的「主标题」。
 * 用于识别「我心里危险的东西2」与「我心里危险的东西 第二季」其实是同一部。
 */
export function baseTitle(raw: string): string {
  return normalizeTitle(raw)
    .replace(/第(?:\d+|[一二三四五六七八九十]+)(?:季|期|部|章|篇|部分)/g, '')
    .replace(/(?:part|season|series)\d+/g, '')
    .replace(/[ⅰⅱⅲⅳⅴⅵⅶⅷⅸⅹ]+$/g, '')
    .replace(/(?:ii|iii|iv)$/g, '')
    .replace(/\d+$/g, '');
}

/**
 * 季数是否相容。
 * 特例：**「第一季」与「无标记」视为同一季** ——
 * 很多作品的第一季在数据源上就叫「间谍过家家」，而用户写的是
 * 「间谍过家家 part1」，不该因为这点差异就判为低置信度。
 */
function seasonsCompatible(a: number | null, b: number | null): boolean {
  if (a === b) return true;
  if (a === null && b === 1) return true;
  if (a === 1 && b === null) return true;
  return false;
}

/**
 * 从候选里挑最贴合的一个。
 *
 * 打分**只依据 entry 自己的标题**（`names` 传「名字」列 + 日文名），
 * 绝不用搜索关键词打分 —— 关键词可能是错位的检索名，
 * 用它打分会得出"100% 命中一部完全不相干的番剧"这种危险结论。
 *
 * @param names 该条目可信的标题（中文名、日文名）
 * @param releaseDate 该条目已知的上映年月，用于消歧（见下方年份修正）
 * @param trustedAliases **可信的**检索名（调用方负责判定），例如表内唯一的那个。
 *        与之完全同名的候选视为「身份确认」，直接满分且跳过季数启发式 ——
 *        这是唯一能救回「辉夜大小姐想让我告白3」这类条目的路径：
 *        它的检索名 `かぐや様は告らせたい-ウルトラロマンティック-` 是标准答案，
 *        但数据源用副标题而非数字表示季数，季数启发式反而会把正确答案压到低置信度。
 */
export function pickBestMatch(
  candidates: MediaCandidate[],
  names: string[],
  releaseDate?: string | null,
  trustedAliases: string[] = [],
): MatchResult | null {
  const kws = names.map((k) => String(k || '').trim()).filter(Boolean);
  if (candidates.length === 0 || kws.length === 0) return null;
  const entryYear = yearOf(releaseDate);
  const trustedNorm = new Set(trustedAliases.map((a) => normalizeTitle(a)).filter(Boolean));

  let best: MatchResult | null = null;
  for (const candidate of candidates) {
    // 候选项自身可能有多个名字，取它最好的那一面来比
    const candidateNames = [candidate.titleCn, candidate.title, ...(candidate.aliases || [])].filter(Boolean);
    let score = 0;
    for (const kw of kws) {
      if (score === 1) break;
      const kwSeason = seasonMark(kw);
      const kwBase = baseTitle(kw);
      for (const name of candidateNames) {
        const normalized = normalizeTitle(name);
        // 与可信检索名完全一致 → 身份确认，跳过一切启发式
        if (normalized && trustedNorm.has(normalized)) {
          score = 1;
          break;
        }
        const cSeason = seasonMark(name);
        let s = titleSimilarity(kw, name);
        if (!seasonsCompatible(kwSeason, cSeason)) {
          // 季数对不上（含"一方有、一方无"）强烈降权：
          // 续作错配到相邻季度是这类自动匹配最高频、也最难察觉的错误。
          s *= 0.5;
        } else if (kwBase && kwBase === baseTitle(name)) {
          // 季数相容且主标题一致 → 强匹配
          // （「我心里危险的东西2」↔「我心里危险的东西 第二季」）
          s = Math.max(s, 0.95);
        }
        if (s > score) score = s;
      }
    }
    // 年份修正：Excel 里已经记着上映时间，这是很有力的消歧信号。
    // 典型场景：「无职转生」→ 数据源里排在前面的是一部同人动画
    // （标题更长、评分很低、2025 年），而正片是 2021 年 —— 包含规则会偏袒短标题，
    // 加上年份一致 +0.10 / 不一致 -0.08 就能把正片拉回来。
    // 惩罚刻意比奖励轻：用户记的上映时间本身也可能不准，不该因此否掉正确候选。
    if (score < 1) {
      const candYear = yearOf(candidate.releaseDate);
      if (entryYear !== null && candYear !== null) {
        if (entryYear === candYear) score += 0.1;
        else if (Math.abs(entryYear - candYear) > 1) score -= 0.08;
      }
      score = Math.max(0, Math.min(1, score));
    }
    if (!best || score > best.score) best = { candidate, score };
  }
  return best;
}

/** 从 YYYY / YYYY-MM / 时间戳里取年份 */
function yearOf(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const m = String(value).match(/(\d{4})/);
  if (!m) return null;
  const y = Number(m[1]);
  return y >= 1900 && y <= 2200 ? y : null;
}

/** 低于该分数视为「需要人工确认」（界面会标黄） */
export const LOW_CONFIDENCE = 0.6;

/**
 * 候选检索词链（按优先级排序，已去重）。
 *
 * **两个源都优先用「名字」列（中文标题）**，检索名列只作回退。原因是一个实测
 * 发现：这份 Excel 的检索名列（A 列）存在**既有错位**（190 条里有 23 个检索名
 * 被多条复用，例如「利兹与青鸟」和「玉子爱情故事」的检索名都是 トニカクカワイイ，
 * 「时光流逝，饭菜依旧美味」的检索名是 葬送のフリーレン）。
 * 拿错位的检索名去搜，会召回一个完全不相干的番剧；如果再用它来打分，
 * 还会以 100% 置信度把错误的封面写进去。
 * 所以检索词只负责"召回"，是否可信一律由 pickBestMatch 对着「名字」列判定。
 *
 * 第二个位置放**去掉季数标记后的主标题**：实测「辉夜大小姐想让我告白3」在
 * Bangumi 上叫「辉夜大小姐想让我告白 -Ultra Romantic-」，带着 3 去搜一无所获，
 * 而用主标题搜就能把整季的候选都召回来 —— 即使自动判定为低置信度，
 * 用户至少能在下拉里手动选到正确的那一季，而不是面对一个空的候选框。
 */
export function keywordChain(
  entry: { title?: string; titleJa?: string; searchAlias?: string },
  _source?: 'auto' | MediaSource,
): string[] {
  const cn = String(entry.title || '').trim();
  const alias = String(entry.searchAlias || '').trim();
  const ja = String(entry.titleJa || '').trim();
  const base = baseTitle(cn);
  // 只有确实去掉了季数标记（base 与 cn 不同且非空）才把它加进链里
  const baseKeyword = base && base !== normalizeTitle(cn) && base !== cn ? base : '';
  const list = [cn, baseKeyword, alias, ja];
  return list.filter((x, i) => x !== '' && list.indexOf(x) === i);
}
