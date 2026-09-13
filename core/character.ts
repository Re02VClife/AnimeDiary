/**
 * core/character — 角色元数据的解析与匹配（纯函数，无网络、无 React）
 *
 * 用于「角色评分卡」的自动补全。两个数据源的字段形态差别很大，这里集中处理：
 *
 *   - Bangumi：角色列表只给**日文原名**，而「简体中文名 / 生日 / 血型 / 身高」
 *     全塞在 character 详情的 infobox 里，且 infobox 的 value 有三种真实形态
 *     （纯字符串 / [{k,v}] 别名数组 / 字符串数组）。见 parseInfoboxValue。
 *   - AniList：有结构化字段（dateOfBirth{month,day} / age / bloodType / favourites），
 *     但**没有中文名**，而且实测用中文名搜索角色一律返回 0 条 ——
 *     所以 AniList 只能用来「补」Bangumi 拿到的角色，不能用来找人。
 *     它的角色简介是英文长文，Bangumi 的 summary 是日文短文，
 *     两者都不是中文，见 resolveProfile 的取舍。
 *
 * 匹配策略上有一条硬性教训：**绝不用角色名做全局搜索**。
 * 「蕾娜」在 Bangumi 有 892 条同名结果，「加藤惠」和「加藤恵」是两个不同码位
 * （惠 U+60E0 / 恵 U+6075）。所以正确做法永远是先锁定作品，
 * 再在**该作品的角色列表内部**匹配，见 scoreCharacterForName。
 */

// ── 作品类型 ──

/** Bangumi subject type → 中文名 */
export const SUBJECT_TYPE_NAMES: Record<number, string> = {
  1: '书籍',
  2: '动画',
  3: '音乐',
  4: '游戏',
  6: '三次元',
};

export function subjectTypeName(type: unknown): string {
  const n = Number(type);
  return SUBJECT_TYPE_NAMES[n] ?? (Number.isFinite(n) ? `类型${n}` : '未知');
}

/** AniList 只覆盖动画与漫画/轻小说，没有游戏 —— 游戏作品的角色只能靠 Bangumi */
export function anilistMediaTypeFor(subjectType: unknown): 'ANIME' | 'MANGA' | null {
  const n = Number(subjectType);
  if (n === 2) return 'ANIME';
  if (n === 1) return 'MANGA';
  return null;
}

// ── infobox 解析 ──

/**
 * 把 Bangumi infobox 的 value 压成一个字符串。
 * 实际见过的三种形态：
 *   '芙莉莲'                              纯字符串
 *   [{k:'英文名', v:'Frieren'}, {v:'…'}]   别名数组，k 可能缺失
 *   ['a', 'b']                            纯字符串数组
 * 嵌套数组也会被展平（别名里偶尔还有一层）。
 */
export function parseInfoboxValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (item === null || item === undefined) return '';
        if (typeof item === 'string') return item.trim();
        if (typeof item === 'object' && 'v' in (item as Record<string, unknown>)) {
          const rec = item as { k?: unknown; v: unknown };
          const text = parseInfoboxValue(rec.v);
          const label = typeof rec.k === 'string' ? rec.k.trim() : '';
          return label && text ? `${label}：${text}` : text;
        }
        return '';
      })
      .filter(Boolean)
      .join(' / ');
  }
  return '';
}

/** infobox 数组 → { key: value }；同名 key 用 ' / ' 合并（别名可能分多条） */
export function buildInfoboxMap(infobox: unknown): Record<string, string> {
  const map: Record<string, string> = {};
  if (!Array.isArray(infobox)) return map;
  for (const raw of infobox) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as { key?: unknown; value?: unknown };
    const key = String(entry.key ?? '').trim();
    if (!key) continue;
    const text = parseInfoboxValue(entry.value);
    if (!text) continue;
    map[key] = map[key] ? `${map[key]} / ${text}` : text;
  }
  return map;
}

/** 按候选项顺序取第一个非空 infobox 值（同一个概念在不同条目里 key 不一样） */
export function pickInfobox(map: Record<string, string>, keys: string[]): string | null {
  for (const key of keys) {
    const value = map[key];
    if (value && value.trim()) return value.trim();
  }
  return null;
}

/** infobox 里可能出现的生日 key（Bangumi 同一个字段在不同条目名不一致） */
export const BIRTHDAY_INFOBOX_KEYS = ['生日', '出生日期', '誕生日', '出生年月日'];
export const BLOOD_TYPE_INFOBOX_KEYS = ['血型', '血液型'];
export const HEIGHT_INFOBOX_KEYS = ['身高', '身長'];
export const WEIGHT_INFOBOX_KEYS = ['体重', '體重'];
export const BWH_INFOBOX_KEYS = ['BWH', '三围', 'スリーサイズ'];
export const SOURCE_INFOBOX_KEYS = ['引用来源', '引用來源', '出典'];

// ── 生日 ──

function toMonthDay(month: unknown, day: unknown): string | null {
  const m = Number(month);
  const d = Number(day);
  if (!Number.isFinite(m) || !Number.isFinite(d)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * 生日归一化为 `MM-DD`（不补年份：绝大多数角色只有月日）。
 * 支持：'9月27日' / '09月27日' / '9-27' / '09/27' / '9月27日生'，
 * 以及 AniList 的结构化 { month, day }。
 * 无法确定月日时返回 null —— 宁可空着，也不要往用户的 Excel 写错数据。
 */
export function normalizeBirthday(raw?: unknown, month?: unknown, day?: unknown): string | null {
  const fromParts = toMonthDay(month, day);
  if (fromParts) return fromParts;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  // 先剥掉年份（'1990年9月27日' 只取月日）
  const text = raw.replace(/\d{4}\s*年/, '');
  const matched = text.match(/(\d{1,2})\s*[月\-\/.]\s*(\d{1,2})/);
  if (!matched) return null;
  return toMonthDay(Number(matched[1]), Number(matched[2]));
}

// ── 名字/标题归一化与相似度 ──

/**
 * 归一化时要去掉的标点。
 * 注意必须包含 ASCII 连字符与斜杠：「86 -不存在的战区-」与「86 不存在的战区 part1」
 * 只差这几处，不剥掉会算出 0.4 的相似度，把本来正确的匹配标成低置信（实测踩过）。
 */
const PUNCTUATION_RE = /[\s\u3000·・\u2010-\u2015_\-./\\、,，:：;；!！?？'"“”‘’`()（）[\]【】{}<>《》「」『』~～*#$%&@^+=|]/g;

function toHalfWidth(input: string): string {
  return input.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/**
 * 角色名归一化：去空白与标点、全角转半角、转小写。
 * 刻意**不做**中文↔日文异体字转换（惠/恵、泽/沢）：那是猜字形，容易把两个
 * 不同角色认成同一个。中文名要靠 infobox 的「简体中文名」拿到，不是靠猜。
 */
export function normalizeCharacterName(input: unknown): string {
  if (typeof input !== 'string') return '';
  return toHalfWidth(input).replace(PUNCTUATION_RE, '').toLowerCase();
}

/** 作品名归一化：额外去掉季数/剧场版等装饰由 stripWorkDecoration 负责，这里只做基础清理 */
export function normalizeWorkTitle(input: unknown): string {
  if (typeof input !== 'string') return '';
  return toHalfWidth(input).replace(PUNCTUATION_RE, '').toLowerCase();
}

/**
 * 去掉作品名里的季数/剧场版等装饰，用于比对「用户记的名字」与「源上的名字」。
 *
 * 用户的表里写的是「86 不存在的战区 part1」「我心里危险的东西2」「路人女主的养成方法fine」，
 * 而源上是「86 -不存在的战区-」「僕の心のヤバイやつ」「冴えない彼女の育てかた Fine」。
 * 不做这层归一化，本来正确的匹配会被算成 0.4 的低置信度（实测踩过）。
 *
 * 刻意保守：结尾的孤立数字只有在剥掉之后还剩 ≥2 个字符时才去掉，
 * 否则「86」「刀剑神域2」这类会整个被吃掉。
 */
export function stripWorkDecoration(input: unknown): string {
  if (typeof input !== 'string') return '';
  let text = input;
  text = text.replace(/[（(【\[]?\s*(?:the\s+)?movie\s*[）)】\]]?/gi, '');
  text = text.replace(/剧场版|劇場版/g, '');
  text = text.replace(/\bpart\s*\d+\b/gi, '');
  text = text.replace(/\bseason\s*\d+\b/gi, '');
  text = text.replace(/第\s*[0-9一二三四五六七八九十]+\s*[季期部篇]/g, '');
  const withoutTrailingNumber = text.replace(/[\s\u3000]*[0-9]+$/, '');
  if (normalizeWorkTitle(withoutTrailingNumber).length >= 2) text = withoutTrailingNumber;
  return text.trim();
}

/**
 * 清掉源里的标记，把正文留下来。
 * Bangumi 的简介混着 BBCode（`[i]…[/i]`、`[url=…]`）和 CRLF，
 * AniList 的 description 是 Markdown（`__Height:__`），直接塞进人设字段会带上这些符号。
 */
export function stripMarkup(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input
    .replace(/\r\n?/g, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    // Markdown 链接 [文字](url) → 只留文字。
    // 必须放在 BBCode 清理**之前**：否则 [Tomoya Aki] 会被当成 BBCode 标签删掉，
    // 正文只剩下一串裸 URL（AniList 的简介里这种链接很多，实测踩过）。
    .replace(/\[([^\]\n]+)\]\([^)\n]*\)/g, '$1')
    // BBCode：标签名只能是「*」或单个不含空格的单词，可带 =参数。
    // 刻意不允许空格，否则 [Tomoya Aki] 这类正常方括号内容会被误删。
    .replace(/\[\/?(?:\*|[a-zA-Z]{1,12})(?:=[^\]]{0,200})?\]/g, '')
    // HTML 标签
    .replace(/<\/?[a-zA-Z][^>]{0,80}>/g, '')
    // Markdown 强调：只去掉成对的标记，保留正文
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function diceCoefficient(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const pairs = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const gram = a.slice(i, i + 2);
    pairs.set(gram, (pairs.get(gram) ?? 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const gram = b.slice(i, i + 2);
    const remain = pairs.get(gram) ?? 0;
    if (remain > 0) {
      pairs.set(gram, remain - 1);
      hits++;
    }
  }
  return (2 * hits) / (a.length - 1 + b.length - 1);
}

/**
 * 归一化字符串的相似度（0-1）。
 * 全等 1；一方包含另一方给 0.7~0.95（按长度比例）；其余用二元组 Dice 打折到 0.7 ，
 * 因为 Dice 对「加藤惠 / 加藤恵」这种只差一个字的串会给 0.5，
 * 打折是为了让它明显低于「可靠匹配」的阈值，宁可让人工确认。
 */
function similarity(x: string, y: string): number {
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) {
    const shorter = Math.min(x.length, y.length);
    const longer = Math.max(x.length, y.length);
    return 0.7 + 0.25 * (shorter / longer);
  }
  return diceCoefficient(x, y) * 0.7;
}

/** 角色名相似度 */
export function characterNameSimilarity(a: unknown, b: unknown): number {
  return similarity(normalizeCharacterName(a), normalizeCharacterName(b));
}

/** 作品名相似度 */
export function workTitleSimilarity(a: unknown, b: unknown): number {
  return similarity(normalizeWorkTitle(a), normalizeWorkTitle(b));
}

// ── 作品匹配 ──

export interface WorkCandidate {
  /** 源内 ID（Bangumi subject id） */
  sourceId: string;
  /** Bangumi subject type：1=书籍 2=动画 3=音乐 4=游戏 6=三次元 */
  type: number;
  /** 原名 */
  title: string;
  /** 中文名（可能为空，此时回退原名） */
  titleCn: string;
  releaseDate?: string | null;
}

export interface Scored<T> {
  item: T;
  score: number;
}

/**
 * 从搜索结果里挑出最匹配的作品。
 *
 * **必须传 types 过滤**：实测搜「路人女主的养成方法」的前三个结果全是书籍
 * (type 1) 而不是剧场版动画 (type 2)，不过滤就会把角色挂到轻小说上。
 * 反过来，如果用户记录的本来就是轻小说，那就该传 [1]。
 *
 * 评分只看标题（中文名与原名取较高者），不掺关键词 —— 关键词匹配是上次
 * 番剧补全误配的根源（「检索名」列被乱序填过）。
 */
export function pickWorkCandidate<T extends WorkCandidate>(
  candidates: T[],
  title: string,
  types?: number[],
): Scored<T> | null {
  const pool = types && types.length > 0
    ? candidates.filter((c) => types.includes(Number(c.type)))
    : candidates;
  const target = normalizeWorkTitle(title);
  // 同时比「原样」与「剥掉季数/剧场版装饰」，取较高分 —— 用户的标题比源上多带
  // 「part1」「2」这类后缀是常态，只比原样会让正确匹配掉到低置信度
  const targetBase = normalizeWorkTitle(stripWorkDecoration(title));
  let best: Scored<T> | null = null;
  for (const candidate of pool) {
    const score = Math.max(
      similarity(target, normalizeWorkTitle(candidate.titleCn || '')),
      similarity(target, normalizeWorkTitle(candidate.title || '')),
      similarity(targetBase, normalizeWorkTitle(stripWorkDecoration(candidate.titleCn || ''))),
      similarity(targetBase, normalizeWorkTitle(stripWorkDecoration(candidate.title || ''))),
    );
    if (!best || score > best.score) best = { item: candidate, score };
  }
  return best;
}

// ── 角色匹配 ──

/** 关系权重：主角优先，其次配角，闲角最后。未知关系排在主角之后 */
const RELATION_RANK: Record<string, number> = { 主角: 0, 配角: 2, 闲角: 3 };
const UNKNOWN_RELATION_RANK = 1;
/** 只有主角/配角值得为角色卡抓取详情，闲角通常是路人 */
export const IMPORTANT_RELATIONS = ['主角', '配角'];

export function relationRank(relation: unknown): number {
  const key = typeof relation === 'string' ? relation.trim() : '';
  return RELATION_RANK[key] ?? UNKNOWN_RELATION_RANK;
}

export function isImportantRelation(relation: unknown): boolean {
  return typeof relation === 'string' && IMPORTANT_RELATIONS.includes(relation.trim());
}

/** 按关系排序（主角 → 配角 → 闲角），同关系保持原顺序（Bangumi 已按登场顺序排） */
export function sortCharactersByRelation<T extends { relation?: string }>(characters: T[]): T[] {
  return characters
    .map((character, index) => ({ character, index }))
    .sort((a, b) => {
      const diff = relationRank(a.character.relation) - relationRank(b.character.relation);
      return diff !== 0 ? diff : a.index - b.index;
    })
    .map((entry) => entry.character);
}

/** 角色匹配时用到的名称字段集合 */
export interface NameBearing {
  /** 原名（Bangumi 是日文名） */
  name: string;
  /** 简体中文名（来自详情 infobox） */
  nameCn?: string | null;
  /** 别名（含中/英/罗马字） */
  aliases?: string[];
}

export type CharacterMatchField = 'nameCn' | 'name' | 'alias';

export interface CharacterMatch<T> {
  item: T;
  score: number;
  /** 命中的是哪个字段 —— 界面可以显示「按简体中文名匹配」，比一个分数更可解释 */
  matchedOn: CharacterMatchField;
  matchedValue: string;
}

/**
 * 用「用户已经记录的角色名」在本作品的角色列表里找人。
 *
 * 判定按证据强度排序，并保留命中字段：
 *   简体中文名全等 > 原名全等 > 别名全等 > 模糊相似
 * 注意 nameCn 需要先为候选角色拉过详情才有值，见服务端的 detailBudget。
 *
 * 不做跨作品搜索，这是刻意的：同名角色太多，必须先锁定作品。
 */
export function scoreCharacterForName<T extends NameBearing>(
  character: T,
  recordedName: string,
): CharacterMatch<T> | null {
  const candidates: Array<{ field: CharacterMatchField; value: string }> = [];
  if (character.nameCn) candidates.push({ field: 'nameCn', value: character.nameCn });
  if (character.name) candidates.push({ field: 'name', value: character.name });
  for (const alias of character.aliases ?? []) {
    if (alias) candidates.push({ field: 'alias', value: alias });
  }

  let best: CharacterMatch<T> | null = null;
  for (const candidate of candidates) {
    const score = characterNameSimilarity(recordedName, candidate.value);
    if (!best || score > best.score) {
      best = { item: character, score, matchedOn: candidate.field, matchedValue: candidate.value };
    }
  }
  return best;
}

/**
 * 在整份角色列表里找最匹配的一个。
 *
 * **默认带置信度下限**：低于 minScore 直接返回 null。这是必需的 ——
 * 不加下限时，任何名字都会「匹配」到列表里某个角色（哪怕 0 分），
 * 于是「安艺伦也」会被塞成「霞之丘诗羽」，而调用方还以为已经匹配完了。
 * 需要拿到「最佳候选但不可信」时显式传 minScore = 0。
 *
 * 分数相同则关系更重要者优先（主角 > 配角 > 闲角）。
 */
export function pickCharacterForName<T extends NameBearing & { relation?: string }>(
  characters: T[],
  recordedName: string,
  minScore: number = LOW_CONFIDENCE,
): CharacterMatch<T> | null {
  let best: CharacterMatch<T> | null = null;
  for (const character of characters) {
    const match = scoreCharacterForName(character, recordedName);
    if (!match) continue;
    if (
      !best
      || match.score > best.score
      || (match.score === best.score
        && relationRank(character.relation) < relationRank(best.item.relation))
    ) {
      best = match;
    }
  }
  return best && best.score >= minScore ? best : null;
}

/** 低于这个分数就不该自动写入 —— 交给人工确认 */
export const LOW_CONFIDENCE = 0.6;

/**
 * 「够好，可以停止继续找」的分数。
 *
 * 为什么必须比 LOW_CONFIDENCE 高一截：批量匹配时「已记录的名字都有了 ≥LOW_CONFIDENCE
 * 的匹配」就提前停止抓详情，会让一个**靠别名包含**得来的 0.78 分把真正的角色挡在外面。
 * 实测踩过：「星野爱」被 0.783 匹配成她儿子「星野愛久愛海」（共用姓氏「星野」，
 * 归一化后名字被包含），而真正的「星野アイ」排在后面、详情还没抓，
 * 名字对名字本该是 1.0。所以只有拿到 ≥0.95 的强匹配才允许提前停止。
 */
export const HIGH_CONFIDENCE = 0.95;

/** 是否是「强匹配」（全等或近似全等）——用于决定要不要继续搜索 */
export function isStrongMatch(score: number): boolean {
  return score >= HIGH_CONFIDENCE;
}

/**
 * 角色简介的取舍：AniList 的 description 更长更详细，Bangumi 的 summary 更短。
 * 两者都不是中文（AniList 英文 / Bangumi 日文），所以同时保留原文与来源，
 * 是否翻译交给上层（项目里已有 ai-analysis 的 LLM 通道）。
 */
export interface CharacterProfile {
  text: string;
  source: 'anilist' | 'bangumi';
  /** 粗略语言标记；只用于界面提示（是否可能需要翻译） */
  lang: 'zh' | 'ja' | 'en' | 'unknown';
}

/**
 * 粗略判断文本语言。
 * 关键在于：**不能只凭「有汉字」就判成日文** —— 中文也全是汉字。
 * 可靠信号是假名（平假名/片假名只出现在日文里）。实测踩过的坑：
 * 「黑神话：悟空」的孙悟空简介是《西游记》原文（中文），却被判成了 ja。
 */
export function detectTextLang(text: string): 'zh' | 'ja' | 'en' | 'unknown' {
  if (!text.trim()) return 'unknown';
  if (/[\u3040-\u309f\u30a0-\u30ff]/.test(text)) return 'ja';
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh';
  if (/[a-zA-Z]/.test(text)) return 'en';
  return 'unknown';
}

export function resolveProfile(
  bangumiSummary?: string | null,
  aniListDescription?: string | null,
): CharacterProfile | null {
  const bgm = stripMarkup(bangumiSummary ?? '');
  const ani = stripMarkup(aniListDescription ?? '');
  if (ani && ani.length >= bgm.length) {
    return { text: ani, source: 'anilist', lang: detectTextLang(ani) };
  }
  if (bgm) return { text: bgm, source: 'bangumi', lang: detectTextLang(bgm) };
  return null;
}

// ── 角色卡字段拼装 ──

/** 角色卡模板的三个内置自定义字段 + 详细人设，与 src/types 的 createCharacterTemplate 对应 */
export interface CharacterCardFields {
  char_source: string;
  char_cv: string;
  char_birthday: string;
  char_profile: string;
}

export interface CharacterCardFieldInput {
  /** 所属作品（中文名优先），多个用 '/' 连接 —— 与界面的 char_source 存储格式一致 */
  works?: Array<{ titleCn?: string; title?: string }>;
  voiceActors?: Array<{ name?: string }>;
  birthday?: string | null;
  bloodType?: string | null;
  height?: string | null;
  weight?: string | null;
  profile?: string | null;
}

/** char_source 最多记几个作品：界面用 tags 展示，太多会挤爆详情面板 */
export const MAX_SOURCE_WORKS = 4;

/**
 * 把抓到的角色资料拼成角色卡的字段。
 * char_birthday 这个字段界面上叫「生日/属性」，所以把血型/身高/体重一并拼进去，
 * 用 ' / ' 分隔，空值不占位。
 */
export function buildCharacterCardFields(input: CharacterCardFieldInput): CharacterCardFields {
  const works = Array.from(
    new Set(
      (input.works ?? [])
        .map((w) => (w.titleCn || w.title || '').trim())
        .filter(Boolean),
    ),
  ).slice(0, MAX_SOURCE_WORKS);

  const cv = (input.voiceActors ?? [])
    .map((v) => (v.name ?? '').trim())
    .filter(Boolean);

  const attributes = [
    input.birthday ? `生日${input.birthday}` : '',
    input.bloodType ? `血型${input.bloodType}` : '',
    input.height ? `身高${input.height}` : '',
    input.weight ? `体重${input.weight}` : '',
  ].filter(Boolean);

  return {
    char_source: works.join('/'),
    // 只填首位声优（Bangumi 的 actors 首位是原版日语 CV，后面是国配/台配），
    // 该字段界面上是单行「声优(CV)」，堆三个语种反而看不出主次
    char_cv: cv[0] ?? '',
    char_birthday: attributes.join(' / '),
    char_profile: (input.profile ?? '').trim(),
  };
}
