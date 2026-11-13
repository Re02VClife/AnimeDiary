/**
 * features/local-library/local-store — 本地番剧库的全局单例（useSyncExternalStore）
 *
 * 为什么不进 AnimeContext：扫描结果和绑定跟 Excel 数据是两套生命周期 ——
 * 用户可能在设置里加了目录、扫出 30 个文件夹，而 Excel 一条都没动。
 * 塞进全局 reducer 会让每次「刷新本地库」都触发整页重算。
 *
 * 另外卡片只需要知道「这部番绑定了哪些集」，用不着感知 loading / 扫描进度，
 * 所以这里用 `derivedVersion` 做细粒度订阅：只有 folders / bindings 真的变了，
 * 卡片才重渲染。
 */
import { useSyncExternalStore } from 'react';
import { normalizeTitle } from '../../../core/bangumi-match';
import type { LocalBinding, LocalFolder, LocalSource } from '../../../core/local-library';
import { animeKeyFor } from '../../../core/music-links';
import { loadMatchMap } from '../bangumi-sync/bangumi-map';
import {
  fetchLibrary,
  addSource as apiAddSource,
  removeSource as apiRemoveSource,
  saveBinding as apiSaveBinding,
  saveProgress,
} from './local-service';
import {
  mergeEpisodes,
  suggestBindings,
  type BindingSuggestion,
  type MatchableAnime,
  type PlayableEpisode,
} from './local-match';

export interface LocalLibraryState {
  sources: LocalSource[];
  folders: LocalFolder[];
  bindings: Record<string, LocalBinding>;
  /** 前端算出的建议绑定（只在设置页展示，不自动落盘） */
  suggestions: BindingSuggestion[];
  /** 正在加载/扫描 */
  loading: boolean;
  /** 正在请求 Bangumi 识别（几十个目录时会有几秒） */
  identifying: boolean;
  /** 首次加载完成（空库也算完成） */
  loaded: boolean;
  error: string | null;
}

let state: LocalLibraryState = {
  sources: [],
  folders: [],
  bindings: {},
  suggestions: [],
  loading: false,
  identifying: false,
  loaded: false,
  error: null,
};

const listeners = new Set<() => void>();
/** 派生缓存：key → 合并后的集数（卡片和播放器都高频读，别每次重算） */
let episodesByKey = new Map<string, PlayableEpisode[]>();
/**
 * 只在「集数可能变了」时递增。卡片订阅它而不是整个 state ——
 * 否则一次扫描进度更新就会让整页几十张卡重渲染。
 */
let derivedVersion = 0;

function notify(): void {
  listeners.forEach((fn) => fn());
}

function recomputeDerived(): void {
  const next = new Map<string, PlayableEpisode[]>();
  for (const [key, binding] of Object.entries(state.bindings)) {
    next.set(key, mergeEpisodes(binding.dirPaths, state.folders));
  }
  episodesByKey = next;
  derivedVersion++;
}

function set(patch: Partial<LocalLibraryState>): void {
  const prevFolders = state.folders;
  const prevBindings = state.bindings;
  state = { ...state, ...patch };
  if (state.folders !== prevFolders || state.bindings !== prevBindings) {
    recomputeDerived();
  }
  notify();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** 从 bangumi-map 里查「用户确认过的 subject id」 */
function savedSubjectLookup(title: string): number | undefined {
  try {
    return loadMatchMap()[normalizeTitle(title)]?.subjectId;
  } catch {
    return undefined;
  }
}

function computeSuggestions(animeList: MatchableAnime[], folders: LocalFolder[], bindings: Record<string, LocalBinding>): BindingSuggestion[] {
  return suggestBindings(animeList, folders, {
    savedSubjectLookup,
    existingKeys: new Set(Object.keys(bindings)),
  });
}

// ── 对外动作 ──────────────────────────────────────────────

/**
 * 加载（首次）或刷新本地库。
 * @param opts.identify 是否请求 Bangumi 识别（设置页第一次打开时才需要，要等几秒）
 * @param opts.animeList 用来重算建议绑定的番剧列表
 */
export async function refreshLocalLibrary(opts: {
  identify?: boolean;
  force?: boolean;
  animeList?: MatchableAnime[];
} = {}): Promise<void> {
  set({ loading: true, error: null, identifying: !!opts.identify });
  try {
    const payload = await fetchLibrary({ identify: opts.identify, force: opts.force });
    set({
      sources: payload.sources,
      folders: payload.folders,
      bindings: payload.bindings,
      suggestions: computeSuggestions(opts.animeList ?? [], payload.folders, payload.bindings),
      loading: false,
      identifying: false,
      loaded: true,
    });
  } catch (e) {
    set({
      loading: false,
      identifying: false,
      loaded: true,
      error: e instanceof Error ? e.message : '加载本地库失败',
    });
  }
}

/** 番剧列表变了（比如刚导入 Excel）时补算建议 */
export function recomputeSuggestions(animeList: MatchableAnime[]): void {
  if (state.folders.length === 0) return;
  set({ suggestions: computeSuggestions(animeList, state.folders, state.bindings) });
}

export async function addLocalSource(path: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const result = await apiAddSource(path);
    if (!result.ok) return { ok: false, error: result.error };
    set({ sources: result.sources });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '添加失败' };
  }
}

export async function removeLocalSource(path: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const result = await apiRemoveSource(path);
    if (!result.ok) return { ok: false, error: result.error };
    set({ sources: result.sources });
    // 服务端会顺手清掉指向该地址的绑定，这里重扫一次把 folders / bindings 对齐
    await refreshLocalLibrary({});
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '删除失败' };
  }
}

/** 绑定/解绑一部番（dirPaths 为空 = 解绑） */
export async function bindAnime(key: string, dirPaths: string[]): Promise<void> {
  const bindings = await apiSaveBinding(key, dirPaths);
  const remaining = state.suggestions.filter((s) => s.key !== key);
  set({ bindings, suggestions: remaining });
}

/** 一键绑定所有「高置信且无冲突」的建议 */
export async function bindHighConfidenceSuggestions(): Promise<number> {
  const targets = state.suggestions.filter((s) => s.confidence === 'high' && !s.conflict);
  if (targets.length === 0) return 0;
  let bindings = state.bindings;
  for (const target of targets) {
    bindings = await apiSaveBinding(target.key, target.dirPaths);
  }
  set({
    bindings,
    suggestions: state.suggestions.filter((s) => !targets.some((t) => t.key === s.key)),
  });
  return targets.length;
}

/** 记住看到第几集（卡片播放键据此续播） */
export function rememberEpisode(key: string, episode: number): void {
  const binding = state.bindings[key];
  if (!binding) return;
  /**
   * 幂等：同一个集号已经记过就什么都不做。
   * 不这么写会成环 —— 这里 set 会重建 episodesByKey，播放器里的 current
   * 变成新对象，那个「切集就记一次」的 effect 再触发，页面就转不完了。
   */
  if (binding.lastEpisode === episode) return;
  set({ bindings: { ...state.bindings, [key]: { ...binding, lastEpisode: episode } } });
  void saveProgress(key, episode);
}

// ── React 接口 ────────────────────────────────────────────

export function useLocalLibrary(): LocalLibraryState {
  return useSyncExternalStore(subscribe, () => state);
}

/**
 * 卡片网格专用：只订阅绑定表。
 * 返回的引用只在绑定真的变化时更换，扫描进度/loading 不会让整页卡片重渲染。
 */
export function useLocalBindingMap(): Record<string, LocalBinding> {
  return useSyncExternalStore(subscribe, () => state.bindings);
}

/**
 * 卡片专用：这部番有没有本地文件。
 * 返回 null = 没绑定（不渲染播放键），否则返回合并后的集数。
 */
export function useLocalEpisodes(anime: MatchableAnime | null | undefined): PlayableEpisode[] | null {
  useSyncExternalStore(subscribe, () => derivedVersion);
  if (!anime) return null;
  const key = animeKeyFor(anime);
  if (!state.bindings[key]) return null;
  return episodesByKey.get(key) ?? null;
}

/** 播放器用：某部番合并后的集数 */
export function episodesForKey(key: string): PlayableEpisode[] {
  return episodesByKey.get(key) ?? [];
}

/** 绑定里记住的集号 */
export function lastEpisodeForKey(key: string): number | undefined {
  return state.bindings[key]?.lastEpisode;
}
