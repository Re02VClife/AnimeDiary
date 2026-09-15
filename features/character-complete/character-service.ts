/**
 * 角色补全 —— 客户端服务层
 *
 * 与 server/character-sources.ts（取数）和 core/character.ts（解析/匹配）配套，
 * 负责把「作品 → 角色列表 → 匹配已记录的角色名 → 下图到本地 → 生成角色卡」
 * 这条链路串起来。
 *
 * 设计原则（和番剧补全 features/media-complete 保持一致）：
 *   1. **绝不自动写 Excel** —— 只产出建议，由界面让你过目后再生成。
 *   2. 角色立绘一律先下载到本地再入库，杜绝外链失效。
 *   3. 生成角色卡是**末尾追加新行**，不改动任何已有数据。
 */
import type { AnimeEntry, TemplateGenre } from '../../src/types';
import { CHARACTER_TEMPLATE_ID } from '../../src/types';
import { buildCharacterCardFields, pickCharacterForName } from '../../core/character';
import type { CharacterMatchField } from '../../core/character';

/** 与 server/character-sources.ts 的 CharacterEntry 保持一致 */
export interface CharacterEntry {
  sourceId: string;
  /** 原名（日文） */
  name: string;
  /** 简体中文名（来自 Bangumi 详情的 infobox；未抓详情时为 null） */
  nameCn: string | null;
  /** 主角 / 配角 / 闲角 */
  relation: string;
  summary: string | null;
  aliases: string[];
  gender: string | null;
  birthday: string | null;
  bloodType: string | null;
  height: string | null;
  weight: string | null;
  bwh: string | null;
  referenceUrl: string | null;
  imageUrl: string | null;
  imageThumbUrl: string | null;
  voiceActors: Array<{ sourceId: string; name: string; imageUrl: string | null; summary: string | null }>;
  works: WorkCandidate[];
  aniListId: number | null;
  age: string | null;
  /** AniList 收藏数（人气参考） */
  popularity: number | null;
  /** 详细人设（AniList 英文长文优先，回退 Bangumi 日文/中文） */
  profile: { text: string; source: 'anilist' | 'bangumi'; lang: 'zh' | 'ja' | 'en' | 'unknown' } | null;
  detailLoaded: boolean;
}

export interface WorkCandidate {
  sourceId: string;
  /** Bangumi subject type：1=书籍 2=动画 3=音乐 4=游戏 6=三次元 */
  type: number;
  title: string;
  titleCn: string;
  releaseDate?: string | null;
}

export interface CharacterResolveResult {
  work: WorkCandidate | null;
  /** 作品名匹配分数；低于 0.6 表示「可能不是我认的那部作品」 */
  workScore: number;
  workLowConfidence: boolean;
  characters: CharacterEntry[];
  matches: Array<{
    name: string;
    character: CharacterEntry | null;
    score: number;
    matchedOn: CharacterMatchField | null;
    matchedValue: string | null;
    lowConfidence: boolean;
  }>;
  stats: { listMs: number; detailCalls: number; anilistUsed: boolean; anilistMs: number; totalCharacters: number };
  errors: string[];
}

// ── 作品类型推断 ──

/** 面板上的类型覆盖选项值 */
export type WorkTypeOverride = 'auto' | '2' | '1' | '4' | 'all';

export const WORK_TYPE_OPTIONS: Array<{ value: WorkTypeOverride; label: string }> = [
  { value: 'auto', label: '自动（按模板判断）' },
  { value: '2', label: '动画' },
  { value: '1', label: '书籍 / 轻小说' },
  { value: '4', label: '游戏' },
  { value: 'all', label: '不限（可能误配）' },
];

/**
 * 从模板的适用类别推断 Bangumi 作品类型。
 *
 * 为什么需要：角色可以挂在任意类型的作品上（实测动画/小说/游戏都有角色），
 * 而 Bangumi 搜「路人女主的养成方法」的前三个结果全是书籍(type 1)，
 * 不过滤就会把角色挂到轻小说上。模板已经声明了 applicableGenre，直接用。
 */
export function inferSubjectTypes(genre: TemplateGenre | undefined): number[] {
  switch (genre) {
    case 'anime':
    case 'movie':
      return [2];
    case 'book':
      return [1];
    case 'game':
      return [4];
    default:
      // 自定义模板无从判断 → 放宽到常见三类，由标题相似度挑最好的那个
      return [1, 2, 4];
  }
}

/** 把面板上的类型覆盖 + 模板类别合成为本次请求的 types */
export function resolveSubjectTypes(override: WorkTypeOverride, genre: TemplateGenre | undefined): number[] | undefined {
  if (override === 'all') return undefined;
  if (override === 'auto') return inferSubjectTypes(genre);
  return [Number(override)];
}

// ── 网络 ──

export interface ResolveOptions {
  subjectId?: string;
  workTitle?: string;
  types?: number[];
  names?: string[];
  withAniList?: boolean;
  detailBudget?: number;
}

/**
 * 一站式解析某部作品的角色。
 *
 * 刻意**不传 names**（用浏览模式）：服务端会为「主角优先、其次配角」的角色抓详情，
 * 中文名/生日/血型就都有了，界面上既能看到完整的可选角色列表，
 * 也能在本地用 pickCharacterForName 匹配已记录的角色名。
 *
 * 注意 AniList 只覆盖动画与书籍，游戏会被跳过（服务端会在 errors 里说明）。
 */
export async function resolveCharacters(opts: ResolveOptions): Promise<CharacterResolveResult> {
  const resp = await fetch('/api/character/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subjectId: opts.subjectId,
      workTitle: opts.workTitle,
      types: opts.types,
      names: opts.names ?? [],
      withAniList: opts.withAniList !== false,
      detailBudget: opts.detailBudget ?? 30,
    }),
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok) throw new Error((data && data.error) || `HTTP ${resp.status}`);
  if (!data) throw new Error('响应不是合法 JSON');
  return data as CharacterResolveResult;
}

/** 下载立绘到本地 images/{角色名}/，返回本地 URL（失败抛错） */
export async function downloadPortrait(characterName: string, url: string): Promise<string> {
  const resp = await fetch('/api/media/fetch-cover', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ animeTitle: characterName, url }),
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok || !data || !data.success) {
    throw new Error((data && data.error) || `立绘下载失败 HTTP ${resp.status}`);
  }
  return data.url as string;
}

/** 只解析作品（不发角色请求），用于把解析拆成有中间反馈的几步 */
export async function resolveWork(
  workTitle: string,
  types?: number[],
): Promise<{ work: WorkCandidate | null; workScore: number; workLowConfidence: boolean }> {
  const qs = new URLSearchParams({ workTitle });
  if (types && types.length > 0) qs.set('types', types.join(','));
  const resp = await fetch(`/api/character/work?${qs.toString()}`);
  const data = await resp.json().catch(() => null);
  if (!resp.ok) throw new Error((data && data.error) || `HTTP ${resp.status}`);
  return data as { work: WorkCandidate | null; workScore: number; workLowConfidence: boolean };
}

/** 只取某作品的角色列表（含立绘/声优/关系，但不含中文名生日） */
export async function fetchCharacterList(subjectId: string): Promise<CharacterEntry[]> {
  const resp = await fetch(`/api/character/list?subjectId=${encodeURIComponent(subjectId)}`);
  const data = await resp.json().catch(() => null);
  if (!resp.ok) throw new Error((data && data.error) || `HTTP ${resp.status}`);
  return (data && data.characters) || [];
}

/**
 * 批量取角色详情。调用方按小批调用（配合进度条），单批上限 40。
 * 返回的条目只有详情字段，需要与列表项合并（列表才有关系/立绘/声优）。
 */
export async function fetchCharacterDetails(ids: string[]): Promise<{ characters: CharacterEntry[]; errors: string[] }> {
  const resp = await fetch('/api/character/details', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok) throw new Error((data && data.error) || `HTTP ${resp.status}`);
  return { characters: (data && data.characters) || [], errors: (data && data.errors) || [] };
}

/** 把详情字段并进列表项（列表给关系/立绘/声优，详情给中文名/生日/血型/身高） */
export function mergeDetailIntoListed(listed: CharacterEntry, detail: CharacterEntry): CharacterEntry {
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
    imageUrl: listed.imageUrl ?? detail.imageUrl,
    imageThumbUrl: listed.imageThumbUrl ?? detail.imageThumbUrl,
    // 列表里的日文简介更短，详情给的人设更全，取更长的那个
    profile: detail.profile && (!listed.profile || detail.profile.text.length > listed.profile.text.length)
      ? detail.profile
      : listed.profile,
    detailLoaded: true,
  };
}

// ── 合并（同角色重复建卡时用） ──

export interface MergeResult {
  customFields: Record<string, string>;
  /** 本次补齐了哪些字段（用于给用户看「合并了什么」） */
  filled: string[];
  /** 是否真的变了 */
  changed: boolean;
}

/**
 * 把新抓到的角色资料合并进已有角色卡。
 *
 * 为什么需要：同一角色会在多部作品里出现（同系列续作、客串），
 * 从不同作品解析时会各自建一张卡 —— 实测 101 张卡里有 10 组同名重复。
 * 合并时**只补空、不覆盖**：你自己填过的声优/生日/人设不会被抓取结果冲掉，
 * 评分和评价更是不碰（那是你要打的分）。
 * 所属作品是并集 —— 这就是「一对多绑定」：一张卡挂多部作品。
 */
export function mergeCharacterCardData(
  existingCustomFields: Record<string, string | number> | undefined,
  character: CharacterEntry,
  workName: string,
): MergeResult {
  const existing = { ...(existingCustomFields || {}) };
  const asText = (v: unknown) => (v === undefined || v === null ? '' : String(v));
  const incoming = buildCharacterCardFields({
    works: [{ titleCn: workName }],
    voiceActors: character.voiceActors,
    birthday: character.birthday,
    bloodType: character.bloodType,
    height: character.height,
    weight: character.weight,
    profile: character.profile ? character.profile.text : null,
  });

  const filled: string[] = [];

  // 所属作品：并集（一对多的关键），去重后受 MAX_SOURCE_WORKS 限制
  const works = new Set(
    [...asText(existing.char_source).split('/'), ...incoming.char_source.split('/')]
      .map((w) => w.trim())
      .filter(Boolean),
  );
  const mergedWorks = [...works].slice(0, 6).join('/');
  if (mergedWorks !== asText(existing.char_source)) {
    existing.char_source = mergedWorks;
    filled.push('所属作品');
  }

  // 其余字段只补空
  const fillIfEmpty = (key: 'char_cv' | 'char_birthday' | 'char_profile', label: string) => {
    if (asText(existing[key]).trim()) return;
    const next = incoming[key];
    if (!next) return;
    existing[key] = next;
    filled.push(label);
  };
  fillIfEmpty('char_cv', '声优');
  fillIfEmpty('char_birthday', '生日/属性');
  fillIfEmpty('char_profile', '详细人设');

  return {
    customFields: Object.fromEntries(
      Object.entries(existing).map(([k, v]) => [k, asText(v)]),
    ),
    filled,
    changed: filled.length > 0,
  };
}

// ── 匹配与建卡 ──

export interface RecordedMatch {
  /** 用户记录的角色名 */
  name: string;
  character: CharacterEntry | null;
  score: number;
  matchedOn: CharacterMatchField | null;
  matchedValue: string | null;
  lowConfidence: boolean;
}

/** 用已记录的角色名在作品的角色列表里找人（逻辑与服务端同一套 core 函数） */
export function matchRecordedNames(characters: CharacterEntry[], names: string[]): RecordedMatch[] {
  return names.map((name) => {
    const confident = pickCharacterForName(characters, name);
    const loose = pickCharacterForName(characters, name, 0);
    return {
      name,
      character: confident ? confident.item : null,
      score: confident ? confident.score : (loose ? loose.score : 0),
      matchedOn: confident ? confident.matchedOn : (loose ? loose.matchedOn : null),
      matchedValue: confident ? confident.matchedValue : (loose ? loose.matchedValue : null),
      lowConfidence: !confident,
    };
  });
}

/** 角色卡用的默认评分模板 ID（以界面选项为准，这里只做兜底） */
export function characterTemplateId(): string {
  return CHARACTER_TEMPLATE_ID;
}

/**
 * 把角色资料拼成一张角色卡的 AnimeEntry。
 *
 * 生成的是**新条目**（append 到 Excel 末尾），不改任何已有行。
 * 评价/评分刻意留空 —— 那是你自己要打的分，不该由抓取填。
 */
export function buildCharacterCardEntry(input: {
  character: CharacterEntry;
  /** 解析到的作品（角色的 works 可能有很多部，用它兜底） */
  fallbackWork?: WorkCandidate | null;
  /** 已落盘的本地立绘 URL；留空则不设置海报 */
  localPosterUrl?: string;
  /** 卡片标题（默认用简体中文名，没有则用原名） */
  title?: string;
  /** 归属的作品名（用于 char_source） */
  sourceWorkName?: string;
}): AnimeEntry {
  const { character } = input;
  const today = new Date().toISOString().split('T')[0];
  const title = input.title
    || character.nameCn
    || character.name;

  const works = character.works.length > 0
    ? character.works
    : (input.fallbackWork ? [input.fallbackWork] : []);
  // char_source 用「解析到的那部作品」优先，避免角色参演几十部时把 tags 撑爆
  const sourceWorks = input.sourceWorkName
    ? [{ titleCn: input.sourceWorkName }]
    : works;

  const customFields = buildCharacterCardFields({
    works: sourceWorks,
    voiceActors: character.voiceActors,
    birthday: character.birthday,
    bloodType: character.bloodType,
    height: character.height,
    weight: character.weight,
    profile: character.profile ? character.profile.text : null,
  });

  // spread 成匿名对象，才能满足 AnimeEntry.customFields 的 Record 索引签名
  // （直接放 CharacterCardFields 接口会因为「接口没有隐式索引签名」被拒）
  const fields: Record<string, string> = { ...customFields };

  return {
    id: 'char-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    title,
    posterUrl: input.localPosterUrl || '',
    category: 'watching',
    tags: [],
    templateId: CHARACTER_TEMPLATE_ID,
    scores: [],
    // 原始资料留在自定义字段里；评分/评价留给你自己
    customFields: fields,
    // 跳转到 Bangumi 角色页，方便回查
    link: character.sourceId ? `https://bgm.tv/character/${character.sourceId}` : undefined,
    createdAt: today,
    updatedAt: today,
  };
}
