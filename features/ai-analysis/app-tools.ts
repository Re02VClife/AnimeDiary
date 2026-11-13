/**
 * features/ai-analysis/app-tools — AI 可调用的应用操作工具
 *
 * 这一层只做「把应用能力翻译成模型能调的工具」，不自己实现落库：
 *   - 读：直接基于传入的实时列表计算；
 *   - 写：统一回调 host.saveAnime（AnimeContext.handleSaveAnime），
 *     所以 Excel 行定位、原子写、写前快照、expectedTitle 校验全部复用现有链路，
 *     不存在第二条写 Excel 的路径。
 *
 * 权限：createAppTools 在注册阶段就按档位过滤，read 档根本看不到写工具；
 * confirm 档的写工具在 run 里再走一次 host.approve（UI 弹确认）。
 */

import type { AnimeCategory, AnimeEntry } from '../../src/types';
import { calcOverall } from '../../core/overall';
import { sameTagName } from '../../core/tag-name';
import type { AIPermission } from '../../core/ai-permission';
import { normalizeAIPermission } from '../../core/ai-permission';
import {
  AppToolError,
  canUseAppTool,
  needsApproval,
  type AppToolRuntime,
  type AppToolSpec,
} from '../../core/app-tools';
import { getTemplate } from '../anime-data/template-service';

export interface AppToolHost {
  /** 当前实时数据（由 AIChatDrawer 从 context 传入） */
  list: AnimeEntry[];
  /** 保存单条：必须映射到 handleSaveAnime(updated, true)，避免关掉详情面板 */
  saveAnime(updated: AnimeEntry): Promise<void>;
  /** confirm 档的写操作确认；返回 false 表示用户拒绝 */
  approve?(spec: AppToolSpec, args: Record<string, unknown>): Promise<boolean>;
}

const CATEGORIES: AnimeCategory[] = ['watching', 'wantToWatch', 'onHold', 'watched', 'dropped'];

const CATEGORY_LABEL: Record<AnimeCategory, string> = {
  watching: '在看',
  wantToWatch: '想看',
  onHold: '搁置',
  watched: '看过',
  dropped: '抛弃',
};

// ── 参数读取（模型给的值一律当不可信输入） ──

function str(args: Record<string, unknown>, key: string, max = 200): string | undefined {
  const v = args[key];
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s ? s.slice(0, max) : undefined;
}

function int(args: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const v = Number(args[key]);
  if (!Number.isFinite(v)) return undefined;
  return Math.max(min, Math.min(max, Math.round(v)));
}

function num(args: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const v = Number(args[key]);
  if (!Number.isFinite(v)) return undefined;
  return Math.max(min, Math.min(max, v));
}

function strList(args: Record<string, unknown>, key: string, maxItems = 12, maxLen = 24): string[] {
  const v = args[key];
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string') continue;
    const s = item.trim();
    if (!s) continue;
    if (!out.includes(s)) out.push(s.slice(0, maxLen));
    if (out.length >= maxItems) break;
  }
  return out;
}

function categoryOf(args: Record<string, unknown>): AnimeCategory | undefined {
  const v = args.category;
  return typeof v === 'string' && (CATEGORIES as string[]).includes(v) ? (v as AnimeCategory) : undefined;
}

// ── 条目定位 ──

/** 精确 → 忽略大小写 → 包含匹配；返回全部候选，由调用方决定是否歧义 */
function findEntries(list: AnimeEntry[], title: string): AnimeEntry[] {
  const exact = list.filter((a) => a.title === title);
  if (exact.length > 0) return exact;
  const lower = title.toLowerCase();
  const ci = list.filter((a) => a.title.toLowerCase() === lower);
  if (ci.length > 0) return ci;
  return list.filter((a) => a.title.toLowerCase().includes(lower));
}

function requireEntry(list: AnimeEntry[], title: string): AnimeEntry {
  if (!title) throw new AppToolError('INVALID_ARGS', '缺少 title 参数');
  const found = findEntries(list, title);
  if (found.length === 0) throw new AppToolError('NOT_FOUND', `列表里没有标题匹配「${title}」的条目`);
  if (found.length > 1) {
    const names = found.slice(0, 8).map((a) => a.title).join('、');
    throw new AppToolError('AMBIGUOUS', `「${title}」匹配到 ${found.length} 部：${names}。请改用完整标题`);
  }
  return found[0];
}

function overviewOf(entry: AnimeEntry): number {
  try {
    return Math.round(calcOverall(entry.scores, getTemplate(entry.templateId).dimensions) * 100) / 100;
  } catch {
    return 0;
  }
}

function slim(entry: AnimeEntry) {
  return {
    title: entry.title,
    category: entry.category,
    categoryLabel: CATEGORY_LABEL[entry.category],
    overall: overviewOf(entry),
    bangumiScore: entry.bangumiScore ?? null,
    watchDate: entry.watchDate ?? null,
    tags: entry.tags.slice(0, 10).map((t) => t.name),
  };
}

function detail(entry: AnimeEntry) {
  const scores: Record<string, number> = {};
  for (const s of entry.scores) scores[s.dimensionKey] = s.score;
  return {
    title: entry.title,
    category: entry.category,
    categoryLabel: CATEGORY_LABEL[entry.category],
    overall: overviewOf(entry),
    scores,
    tags: entry.tags.map((t) => t.name),
    studio: entry.studio ?? null,
    characters: entry.characters ?? [],
    episodes: entry.episodes ?? null,
    currentEpisode: entry.currentEpisode ?? null,
    bangumiScore: entry.bangumiScore ?? null,
    watchDate: entry.watchDate ?? null,
    notes: (entry.notes ?? '').slice(0, 800),
    review: (entry.review ?? '').slice(0, 800),
  };
}

// ── 工具定义 ──

const LIST_SPEC: AppToolSpec = {
  name: 'app_anime_list',
  title: '查询番剧列表',
  description: '按分类/标签/关键词查询用户列表里的番剧，返回每部标题、分类、总评、评分和标签。'
    + '需要具体数字或标题时先用它，不要凭记忆编。只读。',
  effect: 'read',
  modelInputs: ['category', 'tag', 'query', 'limit'],
  inputSchema: {
    type: 'object',
    properties: {
      category: { type: 'string', enum: CATEGORIES, description: '分类筛选，不填为全部' },
      tag: { type: 'string', description: '标签筛选（包含匹配）' },
      query: { type: 'string', description: '标题关键词' },
      limit: { type: 'number', description: '最多返回多少条，默认 20，上限 100' },
    },
    required: [],
  },
};

const GET_SPEC: AppToolSpec = {
  name: 'app_anime_get',
  title: '读取单部详情',
  description: '按完整标题读取一部番的分类、各维度评分、标签、备注、评价、观看日期。只读。',
  effect: 'read',
  modelInputs: ['title'],
  inputSchema: {
    type: 'object',
    properties: { title: { type: 'string', description: '完整标题，必须与列表一致' } },
    required: ['title'],
  },
};

const TAG_STATS_SPEC: AppToolSpec = {
  name: 'app_tag_stats',
  title: '统计标签使用次数',
  description: '统计当前列表里每个标签被多少部番使用，按次数降序。用于发现只用过一两次的长尾标签。只读。',
  effect: 'read',
  modelInputs: ['minCount', 'limit'],
  inputSchema: {
    type: 'object',
    properties: {
      minCount: { type: 'number', description: '只返回使用次数 >= 该值的标签，默认 0' },
      limit: { type: 'number', description: '最多返回多少个，默认 60，上限 200' },
    },
    required: [],
  },
};

const UPDATE_SPEC: AppToolSpec = {
  name: 'app_anime_update',
  title: '修改番剧字段',
  description: '修改某一部的分类、备注、评价、观看日期、BGM 评分、当前集数或维度评分。'
    + '只改传入的字段，其余保持不变；写入会走 Excel 原子写并留快照。写操作。',
  effect: 'write',
  modelInputs: ['title', 'category', 'notes', 'review', 'watchDate', 'bangumiScore', 'currentEpisode', 'scores'],
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '完整标题' },
      category: { type: 'string', enum: CATEGORIES, description: '新分类' },
      notes: { type: 'string', description: '备注，最多 2000 字' },
      review: { type: 'string', description: '评价正文，最多 2000 字' },
      watchDate: { type: 'string', description: '观看日期 YYYY-MM-DD' },
      bangumiScore: { type: 'number', description: 'BGM 社区评分 0-10' },
      currentEpisode: { type: 'number', description: '看到第几集，0 表示清空' },
      scores: {
        type: 'object',
        description: '维度评分，键为维度 key（如 story / art），值 0-10',
        additionalProperties: { type: 'number' },
      },
    },
    required: ['title'],
  },
};

const TAG_ADD_SPEC: AppToolSpec = {
  name: 'app_tag_add',
  title: '给番剧加标签',
  description: '给某一部番追加标签；已存在的标签会自动跳过。只新增，不删除、不改其他标签。写操作。',
  effect: 'write',
  modelInputs: ['title', 'tags'],
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '完整标题' },
      tags: { type: 'array', items: { type: 'string' }, description: '要新增的标签名，最多 12 个' },
    },
    required: ['title', 'tags'],
  },
};

const TAG_REMOVE_SPEC: AppToolSpec = {
  name: 'app_tag_remove',
  title: '从番剧删标签',
  description: '从某一部番移除指定标签（按归一化同名匹配）；不存在的标签自动跳过。只删这一部的标签，不删全局标签池。写操作。',
  effect: 'write',
  modelInputs: ['title', 'tags'],
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '完整标题' },
      tags: { type: 'array', items: { type: 'string' }, description: '要移除的标签名，最多 12 个' },
    },
    required: ['title', 'tags'],
  },
};

const ALL_SPECS: AppToolSpec[] = [
  LIST_SPEC, GET_SPEC, TAG_STATS_SPEC, UPDATE_SPEC, TAG_ADD_SPEC, TAG_REMOVE_SPEC,
];

async function ensureApproval(
  host: AppToolHost,
  spec: AppToolSpec,
  args: Record<string, unknown>,
  permission: AIPermission,
): Promise<void> {
  if (!needsApproval(permission, spec.effect)) return;
  if (!host.approve) {
    throw new AppToolError('FORBIDDEN', '当前是「提议后确认」权限，但宿主没有提供确认入口');
  }
  const ok = await host.approve(spec, args);
  if (!ok) throw new AppToolError('FORBIDDEN', '用户取消了这次改动');
}

async function saveOrThrow(host: AppToolHost, entry: AnimeEntry): Promise<void> {
  try {
    await host.saveAnime(entry);
  } catch (e) {
    throw new AppToolError('WRITE_FAILED', e instanceof Error ? e.message : String(e));
  }
}

function requireTags(args: Record<string, unknown>): string[] {
  const tags = strList(args, 'tags');
  if (tags.length === 0) throw new AppToolError('INVALID_ARGS', 'tags 必须是非空字符串数组');
  return tags;
}

/**
 * 生成当前权限下可用的工具执行器。
 * 注意：返回的是新数组，调用方（chat-agent）还会再按权限过滤一次，双重保险。
 */
export function createAppTools(host: AppToolHost, permission: AIPermission): AppToolRuntime[] {
  const perm = normalizeAIPermission(permission);
  const byName = new Map<string, AppToolRuntime>();

  byName.set(LIST_SPEC.name, {
    spec: LIST_SPEC,
    async run(args) {
      const category = categoryOf(args);
      const tag = str(args, 'tag');
      const query = str(args, 'query', 80)?.toLowerCase();
      const limit = int(args, 'limit', 1, 100) ?? 20;
      let rows = host.list;
      if (category) rows = rows.filter((a) => a.category === category);
      if (tag) rows = rows.filter((a) => a.tags.some((t) => sameTagName(t.name, tag)));
      if (query) rows = rows.filter((a) => a.title.toLowerCase().includes(query));
      return {
        total: rows.length,
        returned: Math.min(rows.length, limit),
        items: rows.slice(0, limit).map(slim),
      };
    },
  });

  byName.set(GET_SPEC.name, {
    spec: GET_SPEC,
    async run(args) {
      return detail(requireEntry(host.list, str(args, 'title', 120) || ''));
    },
  });

  byName.set(TAG_STATS_SPEC.name, {
    spec: TAG_STATS_SPEC,
    async run(args) {
      const minCount = int(args, 'minCount', 0, 10000) ?? 0;
      const limit = int(args, 'limit', 1, 200) ?? 60;
      const counts = new Map<string, number>();
      for (const entry of host.list) {
        for (const tag of entry.tags) counts.set(tag.name, (counts.get(tag.name) ?? 0) + 1);
      }
      const rows = Array.from(counts, ([name, count]) => ({ name, count }))
        .filter((x) => x.count >= minCount)
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
        .slice(0, limit);
      return { total: counts.size, returned: rows.length, tags: rows };
    },
  });

  byName.set(UPDATE_SPEC.name, {
    spec: UPDATE_SPEC,
    async run(args) {
      await ensureApproval(host, UPDATE_SPEC, args, perm);
      const entry = requireEntry(host.list, str(args, 'title', 120) || '');
      const category = categoryOf(args);
      const notes = str(args, 'notes', 2000);
      const review = str(args, 'review', 2000);
      const watchDate = str(args, 'watchDate', 10);
      const bangumiScore = num(args, 'bangumiScore', 0, 10);
      const currentEpisode = int(args, 'currentEpisode', 0, 100000);
      const rawScores = args.scores;

      const next: AnimeEntry = { ...entry };
      const changed: string[] = [];
      if (category && category !== entry.category) {
        next.category = category;
        changed.push('category');
      }
      if (notes !== undefined) { next.notes = notes; changed.push('notes'); }
      if (review !== undefined) { next.review = review; changed.push('review'); }
      if (watchDate !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(watchDate)) {
        next.watchDate = watchDate;
        changed.push('watchDate');
      }
      if (bangumiScore !== undefined) { next.bangumiScore = bangumiScore; changed.push('bangumiScore'); }
      if (currentEpisode !== undefined) { next.currentEpisode = currentEpisode; changed.push('currentEpisode'); }

      if (rawScores && typeof rawScores === 'object' && !Array.isArray(rawScores)) {
        const dims = getTemplate(entry.templateId).dimensions;
        const allowed = new Map(dims.map((d) => [d.key, d]));
        const scores = new Map(entry.scores.map((s) => [s.dimensionKey, s.score]));
        for (const [key, raw] of Object.entries(rawScores as Record<string, unknown>)) {
          if (!allowed.has(key)) continue;
          const score = Number(raw);
          if (!Number.isFinite(score) || score < 0 || score > 10) continue;
          scores.set(key, Math.round(score * 10) / 10);
        }
        const nextScores = Array.from(scores, ([dimensionKey, score]) => ({ dimensionKey, score }));
        const sameScores = nextScores.length === entry.scores.length
          && nextScores.every((s) => {
            const old = entry.scores.find((x) => x.dimensionKey === s.dimensionKey);
            return old && old.score === s.score;
          });
        if (!sameScores) {
          next.scores = nextScores;
          changed.push('scores');
        }
      }

      if (changed.length === 0) return { ok: true, title: entry.title, changed: [], note: '没有可应用的改动' };
      await saveOrThrow(host, next);
      return { ok: true, title: entry.title, changed };
    },
  });

  byName.set(TAG_ADD_SPEC.name, {
    spec: TAG_ADD_SPEC,
    async run(args) {
      await ensureApproval(host, TAG_ADD_SPEC, args, perm);
      const tags = requireTags(args);
      const entry = requireEntry(host.list, str(args, 'title', 120) || '');
      const existing = new Set(entry.tags.map((t) => t.name));
      const additions = tags.filter((t) => !existing.has(t));
      if (additions.length === 0) return { ok: true, title: entry.title, added: [], note: '这些标签都已经存在' };
      const next: AnimeEntry = {
        ...entry,
        tags: [...entry.tags, ...additions.map((name) => ({ name, highlighted: true }))],
      };
      await saveOrThrow(host, next);
      return { ok: true, title: entry.title, added: additions };
    },
  });

  byName.set(TAG_REMOVE_SPEC.name, {
    spec: TAG_REMOVE_SPEC,
    async run(args) {
      await ensureApproval(host, TAG_REMOVE_SPEC, args, perm);
      const tags = requireTags(args);
      const entry = requireEntry(host.list, str(args, 'title', 120) || '');
      const removed: string[] = [];
      const kept = entry.tags.filter((t) => {
        const hit = tags.some((name) => sameTagName(t.name, name));
        if (hit) removed.push(t.name);
        return !hit;
      });
      if (removed.length === 0) return { ok: true, title: entry.title, removed: [], note: '这些标签本来就不在这部番上' };
      await saveOrThrow(host, { ...entry, tags: kept });
      return { ok: true, title: entry.title, removed };
    },
  });

  // 注册阶段就按权限裁剪：read 档连写工具的定义都不给模型看
  return Array.from(byName.values()).filter((t) => canUseAppTool(perm, t.spec.effect));
}

/** 供测试/文档使用：全部工具定义（不执行） */
export function listAppToolSpecs(): AppToolSpec[] {
  return ALL_SPECS;
}
