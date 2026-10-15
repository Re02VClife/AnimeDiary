/**
 * AnimeContext — 全局状态管理
 *   用 useReducer 替代 prop drilling
 */
import React, { createContext, useContext, useReducer, useEffect, useCallback, useMemo, useRef } from 'react';
import { catgirlMessage } from '../src/theme';
import type { AnimeCategory, AnimeEntry, AnimeTag } from '../src/types';
import { loadAnimeList, updateAnimeEntry, appendAnimeEntry, batchSaveAllPosters, deleteExcelRow, readRawRows, rebuildOverallColumn } from '../features/anime-data/excel-service';
import { saveCategory, addToWatchingDeleted, removeFromWatchingDeleted, loadImgHeight, saveImgHeight, exportAllUserData, importUserData, shiftLocalRefsAfterRowDelete, loadWatchingDeleted } from '../features/anime-data/storage-service';
import { migrateLegacyDimensions, loadTemplates } from '../features/anime-data/template-service';
import { buildTransferWorkbook, parseTransferWorkbook, exportFileName, mergeImportedTemplates, SHEET_ANIME } from '../features/anime-data/excel-transfer';
import { getVisibleCategories, DEFAULT_TEMPLATE_ID } from '../src/types';
import { rankByDimension } from '../features/ranking/ranking-service';
import { searchCandidates, pickBestMatch, LOW_CONFIDENCE } from '../features/media-complete/media-service';

/**
 * 汇总批量写回 Excel 的结果。
 * 各处原先用 `.catch(() => {})` 静默吞掉失败，紧接着又弹"成功"——
 * 用户以为改好了，其实文件没动，刷新即还原。
 */
function reportWriteResults(results: PromiseSettledResult<unknown>[], successText: string): void {
  const failed = results.filter((r) => r.status === 'rejected').length;
  if (failed > 0) {
    catgirlMessage.error(`${failed}/${results.length} 条写回 Excel 失败：界面已更新但文件未同步，刷新后会还原`);
  } else {
    catgirlMessage.success(successText);
  }
}

// ── 状态类型 ──

export interface AnimeState {
  animeList: AnimeEntry[];
  loading: boolean;
  error: string | null;

  // 筛选 & 搜索
  activeCategory: AnimeCategory;
  searchText: string;
  searchMode: 'title' | 'tag';
  activeTag: string | null;

  // 排序
  activeDim: string;
  sortByDim: string | null;
  sortOrder: 'asc' | 'desc';

  // 模板筛选
  activeTemplateId: string;

  // 弹窗
  detailOpen: boolean;
  selectedAnime: AnimeEntry | null;
  searchOpen: boolean;
  dimManagerOpen: boolean;
  templateManagerOpen: boolean;
  knowledgeGraphOpen: boolean;
  aiSettingsOpen: boolean;
  tasteReportOpen: boolean;
  /** 表格视图（应用内直接看/改列表原始数据） */
  excelOpen: boolean;

  // 批量模式
  batchMode: boolean;
  selectedBatchTags: string[];
  selectedBatchAnime: string[];

  // 布局
  imgHeight: number;

  // 雷达图显示配置
  radarMode: 'percentile' | 'fixed';
  radarMin: number;

  // 新增条目后自动进入编辑模式
  detailEditMode: boolean;
}

// ── Action 类型 ──

export type AnimeAction =
  | { type: 'SET_LOADING'; payload: boolean }
  | { type: 'SET_ERROR'; payload: string | null }
  | { type: 'SET_ANIME_LIST'; payload: AnimeEntry[] }
  | { type: 'UPDATE_ANIME_IN_LIST'; payload: AnimeEntry }
  | { type: 'REMOVE_ANIME'; payload: string }
  | { type: 'ADD_ANIME'; payload: AnimeEntry }
  | { type: 'SET_CATEGORY'; payload: AnimeCategory }
  | { type: 'SET_SEARCH'; text: string; mode: 'title' | 'tag' }
  | { type: 'SET_SEARCH_TEXT'; payload: string }
  | { type: 'SET_SEARCH_MODE'; payload: 'title' | 'tag' }
  | { type: 'SET_ACTIVE_TAG'; payload: string | null }
  | { type: 'SET_SORT'; dimKey: string | null; order: 'asc' | 'desc' }
  | { type: 'SET_ACTIVE_DIM'; payload: string }
  | { type: 'SET_ACTIVE_TEMPLATE'; payload: string }
  | { type: 'SET_DETAIL_EDIT_MODE'; payload: boolean }
  | { type: 'OPEN_MODAL'; modal: string; anime?: AnimeEntry }
  | { type: 'CLOSE_MODAL'; modal: string }
  | { type: 'SET_BATCH_MODE'; payload: boolean }
  | { type: 'SET_BATCH_TAGS'; payload: string[] }
  | { type: 'SET_BATCH_ANIME'; payload: string[] }
  | { type: 'SET_IMG_HEIGHT'; payload: number }
  | { type: 'SET_RADAR_MODE'; payload: 'percentile' | 'fixed' }
  | { type: 'SET_RADAR_MIN'; payload: number }
  | { type: 'SET_ANIME_POSTER'; animeId: string; posterUrl: string }
  | { type: 'RENAME_TAG'; oldName: string; newName: string }
  | { type: 'DELETE_TAG'; tagName: string }
  | { type: 'BATCH_ADD_TAGS'; tagNames: string[]; animeIds: string[] };

// ── 初始状态 ──

const initialState: AnimeState = {
  animeList: [],
  loading: true,
  error: null,
  activeCategory: 'watched',
  searchText: '',
  searchMode: 'title',
  activeTag: null,
  activeDim: 'overall',
  // 初始视图按观看时间排序：最近看的在左上角，没有时间记录的排最底下
  sortByDim: 'watchDate',
  sortOrder: 'desc',
  activeTemplateId: localStorage.getItem('anime_diary_active_template') || 'default',
  detailOpen: false,
  selectedAnime: null,
  searchOpen: false,
  dimManagerOpen: false,
  templateManagerOpen: false,
  knowledgeGraphOpen: false,
  aiSettingsOpen: false,
  tasteReportOpen: false,
  excelOpen: false,
  batchMode: false,
  detailEditMode: false,
  radarMode: (localStorage.getItem('anime_diary_radar_mode') as 'percentile' | 'fixed') || 'percentile',
  radarMin: Number(localStorage.getItem('anime_diary_radar_min')) || 0,
  selectedBatchTags: [],
  selectedBatchAnime: [],
  imgHeight: loadImgHeight(),
};

// ── Reducer ──

function animeReducer(state: AnimeState, action: AnimeAction): AnimeState {
  switch (action.type) {
    case 'SET_LOADING':
      return { ...state, loading: action.payload };
    case 'SET_ERROR':
      return { ...state, error: action.payload };
    case 'SET_ANIME_LIST':
      return { ...state, animeList: action.payload };

    case 'UPDATE_ANIME_IN_LIST':
      return {
        ...state,
        animeList: state.animeList.map((a) =>
          a.id === action.payload.id ? action.payload : a,
        ),
        selectedAnime:
          state.selectedAnime?.id === action.payload.id
            ? action.payload
            : state.selectedAnime,
      };

    case 'REMOVE_ANIME':
      return {
        ...state,
        animeList: state.animeList.filter((a) => a.id !== action.payload),
      };

    case 'ADD_ANIME':
      return { ...state, animeList: [...state.animeList, action.payload] };

    case 'SET_CATEGORY': {
      // 切分类时清掉"按维度分"的排序：在看/想看这类条目没评分，
      // 继续按总评排会被 .filter(ov > 0) 全部滤掉，列表直接空掉。
      // 番名 / 观看时间不是维度分，与分类无关，保留。
      const keepSort = state.sortByDim === 'watchDate' || state.sortByDim === 'namesort';
      return { ...state, activeCategory: action.payload, sortByDim: keepSort ? state.sortByDim : null };
    }

    case 'SET_SEARCH':
      return { ...state, searchText: action.text, searchMode: action.mode };

    case 'SET_SEARCH_TEXT':
      return { ...state, searchText: action.payload };

    case 'SET_SEARCH_MODE':
      return { ...state, searchMode: action.payload };

    case 'SET_ACTIVE_TAG':
      return { ...state, activeTag: action.payload };

    case 'SET_SORT':
      return { ...state, sortByDim: action.dimKey, sortOrder: action.order };

    case 'SET_ACTIVE_DIM':
      return { ...state, activeDim: action.payload };

    case 'SET_ACTIVE_TEMPLATE':
      localStorage.setItem('anime_diary_active_template', action.payload);
      return { ...state, activeTemplateId: action.payload };

    case 'SET_DETAIL_EDIT_MODE':
      return { ...state, detailEditMode: action.payload };

    case 'OPEN_MODAL': {
      const key = `${action.modal}Open` as keyof AnimeState;
      const update: Partial<AnimeState> = { [key]: true };
      if (action.anime) (update as Record<string, unknown>).selectedAnime = action.anime;
      if (action.modal === 'detail' && action.anime) update.selectedAnime = action.anime;
      return { ...state, ...update };
    }

    case 'CLOSE_MODAL': {
      const key = `${action.modal}Open` as keyof AnimeState;
      return { ...state, [key]: false };
    }

    case 'SET_BATCH_MODE':
      return {
        ...state,
        batchMode: action.payload,
        selectedBatchTags: action.payload ? state.selectedBatchTags : [],
        selectedBatchAnime: action.payload ? state.selectedBatchAnime : [],
      };

    case 'SET_BATCH_TAGS':
      return { ...state, selectedBatchTags: action.payload };

    case 'SET_BATCH_ANIME':
      return { ...state, selectedBatchAnime: action.payload };

    case 'SET_IMG_HEIGHT':
      saveImgHeight(action.payload);
      return { ...state, imgHeight: action.payload };

    case 'SET_RADAR_MODE':
      localStorage.setItem('anime_diary_radar_mode', action.payload);
      return { ...state, radarMode: action.payload };

    case 'SET_RADAR_MIN':
      localStorage.setItem('anime_diary_radar_min', String(action.payload));
      return { ...state, radarMin: action.payload };

    case 'SET_ANIME_POSTER':
      return {
        ...state,
        animeList: state.animeList.map((a) =>
          a.id === action.animeId ? { ...a, posterUrl: action.posterUrl } : a,
        ),
        selectedAnime:
          state.selectedAnime?.id === action.animeId
            ? { ...state.selectedAnime, posterUrl: action.posterUrl }
            : state.selectedAnime,
      };

    case 'RENAME_TAG':
      return {
        ...state,
        animeList: state.animeList.map((a) => ({
          ...a,
          tags: a.tags.map((t) =>
            t.name === action.oldName ? { ...t, name: action.newName } : t,
          ),
        })),
        activeTag:
          state.activeTag === action.oldName ? action.newName : state.activeTag,
      };

    case 'DELETE_TAG':
      return {
        ...state,
        animeList: state.animeList.map((a) => ({
          ...a,
          tags: a.tags.filter((t) => t.name !== action.tagName),
        })),
        activeTag:
          state.activeTag === action.tagName ? null : state.activeTag,
      };

    case 'BATCH_ADD_TAGS':
      return {
        ...state,
        animeList: state.animeList.map((a) => {
          if (!action.animeIds.includes(a.id)) return a;
          const existingNames = new Set(a.tags.map((t) => t.name));
          const newTags = action.tagNames
            .filter((name) => !existingNames.has(name))
            .map((name) => ({ name, highlighted: true } as AnimeTag));
          if (newTags.length === 0) return a;
          return { ...a, tags: [...a.tags, ...newTags] };
        }),
        batchMode: false,
        selectedBatchTags: [],
        selectedBatchAnime: [],
      };

    default:
      return state;
  }
}

// ── Context ──

interface AnimeContextValue {
  state: AnimeState;
  dispatch: React.Dispatch<AnimeAction>;
  // 便捷方法（封装业务逻辑）
  fetchData: () => Promise<void>;
  /**
   * 静默重载番剧列表：只更新数据，**不碰全局 loading**。
   *
   * 为什么需要它：App 在 `state.loading` 为 true 时会提前 return 一个整屏 spinner，
   * 于是整棵组件树（包括所有弹窗）被卸载、弹窗内 state 全部丢失。
   * 批量补全写入完成后若调用 fetchData()，用户会看到面板凭空消失又变空，
   * 连"已写入 N 条"的日志都看不到。所以这类"写完后同步一下数据"的场景必须用它。
   */
  refreshAnimeList: () => Promise<void>;
  filteredAnime: AnimeEntry[];
  handleAnimeClick: (anime: AnimeEntry) => void;
  handleSaveAnime: (updated: AnimeEntry, keepModal?: boolean) => Promise<void>;
  handleDeleteFromWatching: (animeId: string) => void;
  handleExportUserData: () => Promise<void>;
  handleImportUserData: (file: File) => Promise<void>;
  handleAddAnime: (anime: AnimeEntry) => void;
  handleOpenExcel: () => Promise<void>;
  handleBatchSavePosters: () => Promise<void>;
  handleDimensionRank: (dimKey: string, order: 'asc' | 'desc') => void;
  handleRenameTag: (oldName: string, newName: string) => void;
  handleDeleteTag: (tagName: string) => void;
  handleBatchAddTags: () => void;
  handleCancelBatch: () => void;
  handleFixSearchAlias: () => Promise<void>;
  /** 按模板权重重建 Excel 的「综合(观感)」D 列（公式 + 值） */
  handleRebuildOverallColumn: () => Promise<void>;
  handleCreateRelation: (animeId: string, targetType: 'tag' | 'studio' | 'character', targetName: string) => void;
  // Excel 导入导出
  handleImportExcel: () => void;
  handleFileChange: (e: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  handleExportExcel: () => Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fileInputRef: any;
}

const AnimeContext = createContext<AnimeContextValue | null>(null);

export function useAnimeContext(): AnimeContextValue {
  const ctx = useContext(AnimeContext);
  if (!ctx) throw new Error('useAnimeContext must be used within AnimeProvider');
  return ctx;
}

// ── Provider ──

export const AnimeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, dispatch] = useReducer(animeReducer, initialState);

  // 加载数据
  const fetchData = useCallback(async () => {
    // 一次性迁移：旧版维度数据 → 模板系统
    migrateLegacyDimensions();

    dispatch({ type: 'SET_LOADING', payload: true });
    dispatch({ type: 'SET_ERROR', payload: null });
    try {
      const data = await loadAnimeList();
      dispatch({ type: 'SET_ANIME_LIST', payload: data });
    } catch (e) {
      dispatch({ type: 'SET_ERROR', payload: e instanceof Error ? e.message : '数据加载失败' });
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  /**
   * 静默重载：只替换列表数据，不切换 loading / error。
   * 用于「已经写完 Excel，只需要让界面看到新数据」的场合（见 AnimeContextValue 的注释）。
   */
  const refreshAnimeList = useCallback(async () => {
    try {
      const data = await loadAnimeList();
      dispatch({ type: 'SET_ANIME_LIST', payload: data });
    } catch (e) {
      // 静默刷新失败不该把整页打成错误页；已有数据仍然可用
      console.warn('[AnimeDiary] 静默重载失败:', e);
    }
  }, []);

  // 筛选排序
  const filteredAnime = useMemo(() => {
    // 计算当前模板的可见分类：[]>0=按分类筛选，[]=全部留空不筛选
    const templates = loadTemplates();
    const activeTemplate = templates.find((t) => t.id === state.activeTemplateId);
    const visibleCats = activeTemplate ? getVisibleCategories(activeTemplate.categoryLabels) : [];
    const hasCategoryFilter = visibleCats.length > 0;

    let list = state.animeList.filter((a) => {
      const matchCategory = hasCategoryFilter ? a.category === state.activeCategory : true;
      let matchSearch = true;
      if (state.searchText) {
        if (state.searchMode === 'tag') {
          matchSearch = a.tags.some((t) => t.name.includes(state.searchText));
        } else {
          matchSearch = a.title.includes(state.searchText) || (a.searchAlias || '').includes(state.searchText);
        }
      }
      const matchTag = !state.activeTag || a.tags.some((t) => t.name === state.activeTag);
      // 模板筛选：始终按模板分类，'default'=缺省模板，其他=匹配指定模板ID
      const matchTemplate = state.activeTemplateId === 'default'
        ? (!a.templateId || a.templateId === 'default')
        : a.templateId === state.activeTemplateId;
      return matchCategory && matchSearch && matchTag && matchTemplate;
    });

    if (state.sortByDim) {
      if (state.sortByDim === 'overall') {
        // 总评是计算值，不存于 scores 中，需单独处理
        const calcOv = (entry: AnimeEntry): number => {
          const dims = (activeTemplate?.dimensions || [])
            .filter((d) => d.key !== 'overall');
          if (dims.length === 0) return 0;
          const hasWeights = dims.some((d) => d.weight > 0);
          const eff = hasWeights ? dims.filter((d) => d.weight > 0) : dims.map((d) => ({ ...d, weight: 1 / dims.length }));
          let tw = 0, ws = 0;
          for (const d of eff) {
            const s = entry.scores.find((sc) => sc.dimensionKey === d.key)?.score ?? 0;
            if (s > 0) { ws += s * d.weight; tw += d.weight; }
          }
          return tw > 0 ? ws / tw : 0;
        };
        list = [...list]
          .map((a) => ({ entry: a, ov: calcOv(a) }))
          .filter((x) => x.ov > 0)
          .sort((a, b) => state.sortOrder === 'asc' ? a.ov - b.ov : b.ov - a.ov)
          .map((x) => x.entry);
      } else if (state.sortByDim === 'bgm') {
        list = list
          .filter((a) => a.bangumiScore && a.bangumiScore > 0)
          .sort((a, b) => (b.bangumiScore || 0) - (a.bangumiScore || 0));
      } else if (state.sortByDim === 'namesort') {
        list = [...list].sort((a, b) =>
          state.sortOrder === 'asc'
            ? (a.title || '').localeCompare(b.title || '', 'zh')
            : (b.title || '').localeCompare(a.title || '', 'zh'),
        );
      } else if (state.sortByDim === 'watchDate') {
        // 观看时间（ISO 日期字符串，可直接字典序比较）：
        // 没有时间记录的排最后 —— 不能当成空字符串排到最前面
        const watchKey = (a: AnimeEntry) => a.watchDate || a.createdAt || '';
        list = [...list].sort((a, b) => {
          const ka = watchKey(a);
          const kb = watchKey(b);
          if (!ka && !kb) return 0;
          if (!ka) return 1;
          if (!kb) return -1;
          return state.sortOrder === 'asc' ? ka.localeCompare(kb) : kb.localeCompare(ka);
        });
      } else {
        list = rankByDimension(list, state.sortByDim);
        if (state.sortOrder === 'asc') list = list.reverse();
      }
    }
    return list;
  }, [state.animeList, state.activeCategory, state.searchText, state.searchMode, state.activeTag, state.sortByDim, state.sortOrder, state.activeTemplateId]);

  // ── 业务方法 ──

  const handleAnimeClick = useCallback((anime: AnimeEntry) => {
    dispatch({ type: 'OPEN_MODAL', modal: 'detail', anime });
  }, []);

  /**
   * 保存一个条目并写回 Excel。
   *
   * `keepModal` 供「表格视图」这类**不在详情弹窗里**的编辑入口使用：
   * 默认行为（详情面板的保存）会顺手关掉 detail 弹窗并退出编辑态，
   * 表格视图沿用那个行为会在每次单元格保存时把自己的弹窗也关掉。
   */
  const handleSaveAnime = useCallback(async (updated: AnimeEntry, keepModal = false) => {
    let savedEntry = updated;
    // 新条目（无 excelRowIndex）→ 追加到 Excel 末尾，并获取分配的行号
    if (updated.excelRowIndex === undefined) {
      // 失败必须上抛：原先在这里 catch 后 return，调用方会当成保存成功、弹"已保存"并退出编辑
      const newRowIdx = await appendAnimeEntry(updated);
      savedEntry = { ...updated, excelRowIndex: newRowIdx, id: `excel-${newRowIdx}`, excelTitleSnapshot: updated.title };
    } else {
      await updateAnimeEntry(updated);
      // 保存成功后刷新标题快照：下次写回校验的应是新标题
      savedEntry = { ...savedEntry, excelTitleSnapshot: updated.title };
    }
    const old = state.animeList.find((a) => a.id === updated.id);
    if (old && old.category !== updated.category) {
      saveCategory(savedEntry.id, savedEntry.category);
    }
    if (savedEntry.id !== updated.id) {
      // 新条目：保存后 id 由临时 id 变为 excel-N，UPDATE 按 id 匹配不到 → 先移除旧条目再以新 id 加入
      dispatch({ type: 'REMOVE_ANIME', payload: updated.id });
      dispatch({ type: 'ADD_ANIME', payload: { ...savedEntry, updatedAt: new Date().toISOString().split('T')[0] } });
    } else {
      dispatch({
        type: 'UPDATE_ANIME_IN_LIST',
        payload: { ...savedEntry, updatedAt: new Date().toISOString().split('T')[0] },
      });
    }
    if (!keepModal) {
      dispatch({ type: 'SET_DETAIL_EDIT_MODE', payload: false });
      dispatch({ type: 'CLOSE_MODAL', modal: 'detail' });
    }
  }, [state.animeList]);

  /**
   * 删除一个条目。
   *
   * 与旧行为（只把 id 加进本地黑名单、Excel 一行不动）不同：现在**真的把 Excel 里
   * 那一行删掉**。所以必须连带处理两件事，否则会安静地弄坏数据：
   *   1. 条目 id 就是行号（excel-N），删一行会让后面所有行的 id 前移 ——
   *      本地按 id 存的海报覆盖 / 焦点位置 / 分类 / 维度点评要一起迁移，
   *      不迁就会集体错位到别的条目身上（不是丢失，是张冠李戴）
   *   2. Excel 里有 845 个公式，服务端会把大于该行的行引用统一减 1
   *
   * 不放进黑名单了：行已经不存在，黑名单只会指向一个错误的行号。
   */
  const handleDeleteFromWatching = useCallback((animeId: string) => {
    const target = state.animeList.find((a) => a.id === animeId);
    if (!target) return;

    // 只存在于内存里的条目（手工建的角色卡 char-...）没有 Excel 行可删
    if (typeof target.excelRowIndex !== 'number') {
      dispatch({ type: 'REMOVE_ANIME', payload: animeId });
      catgirlMessage.success('已移除（该条目不在 Excel 中）');
      return;
    }

    const rowIndex = target.excelRowIndex;
    void (async () => {
      try {
        const res = await deleteExcelRow({
          rowIndex,
          // 用加载时的标题快照做校验：中途被外部改过行号也能发现
          expectedTitle: target.excelTitleSnapshot || target.title,
        });
        const moved = await shiftLocalRefsAfterRowDelete(rowIndex);
        await refreshAnimeList();
        catgirlMessage.success(
          `已删除「${res.removedTitle}」：Excel 删掉 1 行、平移 ${res.formulasShifted} 个公式`
          + `${moved > 0 ? `、迁移 ${moved} 项本地设置` : ''}`,
        );
      } catch (e) {
        catgirlMessage.error(e instanceof Error ? e.message : '删除失败');
      }
    })();
  }, [state.animeList, refreshAnimeList]);

  const handleExportUserData = useCallback(async () => {
    try {
      await exportAllUserData();
      catgirlMessage.success('备份已导出（含 Excel、图片与本地设置）');
    } catch (e) {
      catgirlMessage.error('导出失败：' + (e instanceof Error ? e.message : '未知错误'));
    }
  }, []);

  const handleImportUserData = useCallback(async (file: File) => {
    const ok = window.confirm(
      `即将用「${file.name}」覆盖本机全部本地数据（分类、标签、海报覆盖、主题、模板、AI 配置）；` +
      `若备份里含 Excel，也会一并替换数据源文件。\n\n` +
      `导入前的本地数据会自动留一份快照，但仍请确认。\n\n确定继续？`,
    );
    if (!ok) return;
    try {
      await importUserData(file);
      catgirlMessage.success('已导入，正在刷新…');
      fetchData();
    } catch (e) {
      catgirlMessage.error('导入失败：' + (e instanceof Error ? e.message : '未知错误'));
    }
  }, [fetchData]);

  const handleAddAnime = useCallback((anime: AnimeEntry) => {
    dispatch({ type: 'ADD_ANIME', payload: anime });
    dispatch({ type: 'CLOSE_MODAL', modal: 'search' });
    // 新增后直接打开详情面板，并自动进入编辑模式
    dispatch({ type: 'SET_DETAIL_EDIT_MODE', payload: true });
    dispatch({ type: 'OPEN_MODAL', modal: 'detail', anime });
  }, []);

  const handleOpenExcel = useCallback(async () => {
    try {
      const resp = await fetch('/api/excel/open');
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        throw new Error((errData as { error?: string }).error || `HTTP ${resp.status}`);
      }
    } catch (e) {
      catgirlMessage.error('打开 Excel 失败：' + (e instanceof Error ? e.message : '请检查 Excel 文件是否存在'));
    }
  }, []);

  /**
   * 按当前模板权重重建 Excel 里「综合(观感)」（D 列）的公式 + 刷新缓存值。
   *
   * 为什么需要：D 列历史上是**另一套手工公式**（只用 5 个维度、还有「内容」这种
   * 不在模板里的列），和界面上按模板算的总评不是一个数 —— 同一部番会出现两个总评。
   * 这个入口把它统一成模板口径。
   */
  const handleRebuildOverallColumn = useCallback(async () => {
    const tpl = loadTemplates().find((t) => t.isDefault) ?? loadTemplates()[0];
    const dims = (tpl?.dimensions ?? []).filter((d) => d.key !== 'overall' && d.weight > 0);
    const desc = dims.map((d) => `${d.label} ${d.weight}`).join('、');
    const ok = window.confirm(
      `将用「${tpl?.name ?? '当前模板'}」的权重重建 Excel 里 D 列「综合(观感)」的公式，\n`
      + `并刷新全部番剧的该列数值。\n\n`
      + `参与的维度：${desc}\n\n`
      + `只影响默认模板的番剧行（角色卡/自定义模板不动）。文件会先自动留快照。\n\n确定继续？`,
    );
    if (!ok) return;
    const hide = catgirlMessage.loading('正在重建总评列…', 0);
    try {
      const res = await rebuildOverallColumn();
      hide();
      if (res.rows === 0) {
        catgirlMessage.warning('没有可重建的行（模板里没有带权重的维度？）');
        return;
      }
      catgirlMessage.success(
        `已重建 ${res.rows} 行总评公式，其中 ${res.changed} 行数值被更新`,
      );
      await refreshAnimeList();
    } catch (e) {
      hide();
      catgirlMessage.error('重建失败：' + (e instanceof Error ? e.message : '未知错误'));
    }
  }, [refreshAnimeList]);

  const handleBatchSavePosters = useCallback(async () => {
    const candidates = state.animeList.filter((a) => a.excelRowIndex !== undefined && a.posterUrl);
    if (candidates.length === 0) { catgirlMessage.warning('没有需要持久化的海报'); return; }
    const hide = catgirlMessage.loading(`正在持久化海报 (0/${candidates.length})…`, 0);
    try {
      await batchSaveAllPosters(candidates);
      hide();
      catgirlMessage.success(`已持久化 ${candidates.length} 张海报到 Excel`);
    } catch (e) {
      hide();
      catgirlMessage.error('持久化失败：' + (e instanceof Error ? e.message : '未知错误'));
    }
  }, [state.animeList]);

  const handleDimensionRank = useCallback((dimKey: string, order: 'asc' | 'desc') => {
    dispatch({ type: 'SET_ACTIVE_DIM', payload: dimKey });
    // 按维度排序时才收窄到「看过」（维度分只在看过的番上有意义）；
    // 番名 / 观看时间不是维度分，保持当前分类
    if (dimKey !== 'namesort' && dimKey !== 'watchDate') {
      dispatch({ type: 'SET_CATEGORY', payload: 'watched' });
    }
    // SET_SORT 必须在 SET_CATEGORY 之后，避免被 sortByDim: null 覆盖
    dispatch({ type: 'SET_SORT', dimKey, order });
  }, []);

  const handleRenameTag = useCallback((oldName: string, newName: string) => {
    if (oldName === newName) return;
    dispatch({ type: 'RENAME_TAG', oldName, newName });
    const affected = state.animeList
      .filter((a) => a.tags.some((t) => t.name === oldName) && a.excelRowIndex !== undefined)
      .map((a) => ({
        ...a,
        tags: a.tags.map((t) => t.name === oldName ? { ...t, name: newName } : t),
      }));
    void Promise.allSettled(affected.map((a) => updateAnimeEntry(a)))
      .then((rs) => reportWriteResults(rs, `已将「${oldName}」重命名为「${newName}」`));
  }, [state.animeList]);

  const handleDeleteTag = useCallback((tagName: string) => {
    dispatch({ type: 'DELETE_TAG', tagName });
    const affected = state.animeList
      .filter((a) => a.tags.some((t) => t.name === tagName) && a.excelRowIndex !== undefined)
      .map((a) => ({
        ...a,
        tags: a.tags.filter((t) => t.name !== tagName),
      }));
    void Promise.allSettled(affected.map((a) => updateAnimeEntry(a)))
      .then((rs) => reportWriteResults(rs, `已全局删除标签「${tagName}」`));
  }, [state.animeList]);

  const handleBatchAddTags = useCallback(() => {
    if (state.selectedBatchTags.length === 0 || state.selectedBatchAnime.length === 0) {
      catgirlMessage.warning('请至少选择一个标签和一部番剧');
      return;
    }
    dispatch({
      type: 'BATCH_ADD_TAGS',
      tagNames: state.selectedBatchTags,
      animeIds: state.selectedBatchAnime,
    });
    const affected = state.animeList
      .filter((a) => state.selectedBatchAnime.includes(a.id) && a.excelRowIndex !== undefined)
      .map((a) => {
        const existingNames = new Set(a.tags.map((t) => t.name));
        const newTags = state.selectedBatchTags.filter((name) => !existingNames.has(name));
        if (newTags.length === 0) return null;
        return { ...a, tags: [...a.tags, ...newTags.map((name) => ({ name, highlighted: true } as AnimeTag))] };
      })
      .filter(Boolean) as AnimeEntry[];
    void Promise.allSettled(affected.map((a) => updateAnimeEntry(a)))
      .then((rs) => reportWriteResults(rs, `已将 ${state.selectedBatchTags.length} 个标签添加到 ${state.selectedBatchAnime.length} 部番剧`));
  }, [state.selectedBatchTags, state.selectedBatchAnime, state.animeList]);

  const handleCancelBatch = useCallback(() => {
    dispatch({ type: 'SET_BATCH_MODE', payload: false });
    dispatch({ type: 'SET_BATCH_TAGS', payload: [] });
    dispatch({ type: 'SET_BATCH_ANIME', payload: [] });
  }, []);

  /**
   * 批量修正检索名。
   *
   * 旧实现直接拿 AniList 的 `list[0].name` **无条件覆盖**每一条 —— 而中文标题在
   * AniList 的 top-1 命中率很低，于是「罪恶王冠 → ギルティクラウン」这类错配成批出现
   * （实测污染过 35 条，只能事后逐条回查 Bangumi 才修回来）。
   *
   * 现在复用「数据补全」那套匹配：查 Bangumi → pickBestMatch（带季数消歧 + 年份修正）
   * → 只有分数 ≥ LOW_CONFIDENCE 才写，拿不准就跳过。写入的是**原名**（日文），
   * 因为检索名的用途就是拿原名去源站搜。
   */
  const handleFixSearchAlias = useCallback(async () => {
    // 只处理番剧：角色卡和自定义模板没有"检索名"的语义，查了也是白查
    const candidates = state.animeList.filter(
      (a) => a.excelRowIndex !== undefined && (!a.templateId || a.templateId === DEFAULT_TEMPLATE_ID),
    );
    if (candidates.length === 0) { catgirlMessage.warning('没有可修正的番剧'); return; }

    const hide = catgirlMessage.loading(`正在修正检索名 (0/${candidates.length})…`, 0);
    let filled = 0;       // 写入成功
    let kept = 0;         // 原值已经等于原名，无需改动
    let unsure = 0;       // 匹配分数不够 → 跳过（宁可不写，也不写错）
    let writeFailed = 0;

    for (let i = 0; i < candidates.length; i++) {
      const anime = candidates[i];
      try {
        const { candidates: found } = await searchCandidates(anime.title, 'bangumi');
        const best = pickBestMatch(
          found,
          [anime.title, anime.titleJa].filter(Boolean) as string[],
          anime.releaseDate,
        );
        if (!best || best.score < LOW_CONFIDENCE) {
          unsure++;
        } else {
          const alias = (best.candidate.title || '').trim();
          if (!alias || alias === anime.title || alias === anime.searchAlias) {
            kept++;
          } else {
            const updated = { ...anime, searchAlias: alias, updatedAt: new Date().toISOString().split('T')[0] };
            dispatch({ type: 'UPDATE_ANIME_IN_LIST', payload: updated });
            try {
              await updateAnimeEntry(updated);
              filled++;
            } catch {
              writeFailed++; // 原先静默吞掉，结尾还无条件报"完成"
            }
          }
        }
      } catch {
        unsure++;
      }
      if (i < candidates.length - 1) await new Promise((r) => setTimeout(r, 600));
    }
    hide();

    const summary = `写入 ${filled} 条，已正确 ${kept} 条，拿不准跳过 ${unsure} 条`;
    if (writeFailed > 0) {
      catgirlMessage.error(`检索名修正完成：${summary}；其中 ${writeFailed} 条写回 Excel 失败`);
    } else {
      catgirlMessage.success(`检索名修正完成：${summary}`);
    }
  }, [state.animeList]);

  const handleCreateRelation = useCallback(
    (animeId: string, targetType: 'tag' | 'studio' | 'character', targetName: string) => {
      if (!targetName.trim()) return;
      const anime = state.animeList.find((a) => a.id === animeId);
      if (!anime) return;
      const now = new Date().toISOString().split('T')[0];
      let updated: AnimeEntry;
      if (targetType === 'tag') {
        if (anime.tags.some((t) => t.name === targetName)) return;
        updated = { ...anime, tags: [...anime.tags, { name: targetName, highlighted: true }], updatedAt: now };
      } else if (targetType === 'studio') {
        updated = { ...anime, studio: targetName, updatedAt: now };
      } else {
        const chars = anime.characters || [];
        if (chars.includes(targetName)) return;
        updated = { ...anime, characters: [...chars, targetName], updatedAt: now };
      }
      dispatch({ type: 'UPDATE_ANIME_IN_LIST', payload: updated });
      const label = targetType === 'tag' ? '标签' : targetType === 'studio' ? '制作公司' : '角色';
      const successText = `已将「${targetName}」${targetType === 'studio' ? '设为' : '添加到'}「${anime.title}」的${label}`;
      if (anime.excelRowIndex !== undefined) {
        void updateAnimeEntry(updated)
          .then(() => catgirlMessage.success(successText))
          .catch(() => catgirlMessage.error(`「${anime.title}」写回 Excel 失败，仅界面已更新`));
      } else {
        catgirlMessage.success(successText);
      }
    },
    [state.animeList],
  );

  // Excel 导入导出
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fileInputRef = useRef<HTMLInputElement>(null) as any;

  const handleImportExcel = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  /**
   * 导入 Excel。
   *
   * 旧实现是「把上传的文件原样覆盖数据源」—— 因为它压根不解析结构，只把文件字节写过去。
   * 后果有新格式后是致命的：导出文件的列义（「音/制作/…」）和内部 43 列存储格式不是一回事，
   * 直接覆盖会让应用再也读不出这些行。
   *
   * 现在：解析 → 重建内部格式工作簿 → 落盘。既能吃新导出格式，也继续吃旧格式。
   */
  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // 破坏性操作：明确告知会替换数据源，并要求确认
    const ok = window.confirm(
      `即将用「${file.name}」替换当前数据源（番评分.xlsx）。\n\n` +
      `当前文件会先自动留一份可回滚的快照，但界面上的数据将被文件内容覆盖。\n\n确定继续？`,
    );
    if (!ok) {
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    try {
      const XLSX = await import('xlsx');
      const data = await file.arrayBuffer();
      const wb = XLSX.read(data, { type: 'array' });
      const parsed = parseTransferWorkbook(wb);
      if (parsed.count === 0) {
        const sheets = wb.SheetNames.join('、');
        throw new Error(
          `没认出任何可导入的记录（文件里的表：${sheets}）。\n` +
          `需要包含「${SHEET_ANIME}」或旧格式的「番剧列表」表。`,
        );
      }
      // 自定义模板的定义不在导出文件里，按维度列名反推补回 localStorage，否则这些条目没有模板可显示
      const addedTemplates = mergeImportedTemplates(parsed.templates);
      const out = XLSX.write(parsed.workbook, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
      const resp = await fetch('/api/excel/replace', { method: 'POST', body: out });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
        throw new Error((err as { error?: string }).error || `HTTP ${resp.status}`);
      }
      const detail = parsed.summary.map((s) => `${s.sheet} ${s.count}`).join('、');
      catgirlMessage.success(
        `已导入 ${parsed.count} 条（${detail}）`
        + `${addedTemplates > 0 ? `，并补回 ${addedTemplates} 个模板定义` : ''}`,
      );
      await fetchData();
    } catch (err) {
      catgirlMessage.error('导入失败：' + (err instanceof Error ? err.message : '文件格式错误'));
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [fetchData]);

  /**
   * 导出 Excel。
   *
   * 输出是**按记录类型分表**的：番剧 / 角色卡 / 每个自定义模板一张表 / 异常行。
   * 原来是一张 43 列的内部格式平铺表，三类记录混在一起、非默认模板的分只存在于
   * 「模板JSON」列里。详见 features/anime-data/excel-transfer.ts 的模块注释。
   *
   * 这里的数据源必须是 Excel 原始行（不是 state.animeList）：只有原始行里才有
   * 源表里名字为空、被程序丢弃的「异常行」—— 那正是用户说「已删除的数据也导出来了」的东西。
   */
  const handleExportExcel = useCallback(async () => {
    try {
      const XLSX = await import('xlsx');
      const rows = await readRawRows();
      const wb = buildTransferWorkbook({
        rows,
        templates: loadTemplates(),
        // 界面上被隐藏/删除、但行还在源文件里的条目，在「状态」列标出来
        hiddenIds: loadWatchingDeleted(),
      });
      const fileName = exportFileName();
      XLSX.writeFile(wb, fileName);
      const sheetCount = wb.SheetNames.length;
      catgirlMessage.success(
        `已导出到「${fileName}」：${sheetCount} 张表（源表 ${rows.length - 1} 行）`,
      );
    } catch (e) {
      catgirlMessage.error('导出失败：' + (e instanceof Error ? e.message : '未知错误'));
    }
  }, []);

  const value: AnimeContextValue = {
    state,
    dispatch,
    fetchData,
    refreshAnimeList,
    filteredAnime,
    handleAnimeClick,
    handleSaveAnime,
    handleDeleteFromWatching,
    handleExportUserData,
    handleImportUserData,
    handleAddAnime,
    handleOpenExcel,
    handleBatchSavePosters,
    handleDimensionRank,
    handleRenameTag,
    handleDeleteTag,
    handleBatchAddTags,
    handleCancelBatch,
    handleFixSearchAlias,
    handleRebuildOverallColumn,
    handleCreateRelation,
    handleImportExcel,
    handleFileChange,
    handleExportExcel,
    fileInputRef,
  };

  return React.createElement(AnimeContext.Provider, { value }, children);
};
