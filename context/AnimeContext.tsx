/**
 * AnimeContext — 全局状态管理
 *   用 useReducer 替代 prop drilling
 */
import React, { createContext, useContext, useReducer, useEffect, useCallback, useMemo, useRef } from 'react';
import { message } from 'antd';
import type { AnimeCategory, AnimeEntry, AnimeTag } from '../src/types';
import { loadAnimeList, updateAnimeEntry, batchSaveAllPosters } from '../features/anime-data/excel-service';
import { saveCategory, addToWatchingDeleted, loadImgHeight, saveImgHeight, exportAllUserData, importUserData } from '../features/anime-data/storage-service';
import { rankByDimension } from '../features/ranking/ranking-service';
import { DIMENSION_COL_MAP, EXCEL_COL } from '../features/anime-data/excel-mapping';

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

  // 弹窗
  detailOpen: boolean;
  selectedAnime: AnimeEntry | null;
  searchModalOpen: boolean;
  dimManagerOpen: boolean;
  knowledgeGraphOpen: boolean;
  aiSettingsOpen: boolean;
  tasteReportOpen: boolean;

  // 批量模式
  batchMode: boolean;
  selectedBatchTags: string[];
  selectedBatchAnime: string[];

  // 布局
  imgHeight: number;
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
  | { type: 'SET_ACTIVE_TAG'; payload: string | null }
  | { type: 'SET_SORT'; dimKey: string | null; order: 'asc' | 'desc' }
  | { type: 'SET_ACTIVE_DIM'; payload: string }
  | { type: 'OPEN_MODAL'; modal: string; anime?: AnimeEntry }
  | { type: 'CLOSE_MODAL'; modal: string }
  | { type: 'SET_BATCH_MODE'; payload: boolean }
  | { type: 'SET_BATCH_TAGS'; payload: string[] }
  | { type: 'SET_BATCH_ANIME'; payload: string[] }
  | { type: 'SET_IMG_HEIGHT'; payload: number }
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
  sortByDim: null,
  sortOrder: 'desc',
  detailOpen: false,
  selectedAnime: null,
  searchModalOpen: false,
  dimManagerOpen: false,
  knowledgeGraphOpen: false,
  aiSettingsOpen: false,
  tasteReportOpen: false,
  batchMode: false,
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

    case 'SET_CATEGORY':
      return { ...state, activeCategory: action.payload, sortByDim: null };

    case 'SET_SEARCH':
      return { ...state, searchText: action.text, searchMode: action.mode };

    case 'SET_ACTIVE_TAG':
      return { ...state, activeTag: action.payload };

    case 'SET_SORT':
      return { ...state, sortByDim: action.dimKey, sortOrder: action.order };

    case 'SET_ACTIVE_DIM':
      return { ...state, activeDim: action.payload };

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
  filteredAnime: AnimeEntry[];
  handleAnimeClick: (anime: AnimeEntry) => void;
  handleSaveAnime: (updated: AnimeEntry) => Promise<void>;
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

  // 筛选排序
  const filteredAnime = useMemo(() => {
    let list = state.animeList.filter((a) => {
      const matchCategory = a.category === state.activeCategory;
      let matchSearch = true;
      if (state.searchText) {
        if (state.searchMode === 'tag') {
          matchSearch = a.tags.some((t) => t.name.includes(state.searchText));
        } else {
          matchSearch = a.title.includes(state.searchText) || (a.searchAlias || '').includes(state.searchText);
        }
      }
      const matchTag = !state.activeTag || a.tags.some((t) => t.name === state.activeTag);
      return matchCategory && matchSearch && matchTag;
    });

    if (state.sortByDim) {
      if (state.sortByDim === 'bgm') {
        list = list
          .filter((a) => a.bangumiScore && a.bangumiScore > 0)
          .sort((a, b) => (b.bangumiScore || 0) - (a.bangumiScore || 0));
      } else if (state.sortByDim === 'namesort') {
        list = [...list].sort((a, b) =>
          state.sortOrder === 'asc'
            ? (a.title || '').localeCompare(b.title || '', 'zh')
            : (b.title || '').localeCompare(a.title || '', 'zh'),
        );
      } else {
        list = rankByDimension(list, state.sortByDim);
        if (state.sortOrder === 'asc') list = list.reverse();
      }
    }
    return list;
  }, [state.animeList, state.activeCategory, state.searchText, state.searchMode, state.activeTag, state.sortByDim, state.sortOrder]);

  // ── 业务方法 ──

  const handleAnimeClick = useCallback((anime: AnimeEntry) => {
    dispatch({ type: 'OPEN_MODAL', modal: 'detail', anime });
  }, []);

  const handleSaveAnime = useCallback(async (updated: AnimeEntry) => {
    await updateAnimeEntry(updated);
    const old = state.animeList.find((a) => a.id === updated.id);
    if (old && old.category !== updated.category) {
      saveCategory(updated.id, updated.category);
    }
    dispatch({
      type: 'UPDATE_ANIME_IN_LIST',
      payload: { ...updated, updatedAt: new Date().toISOString().split('T')[0] },
    });
    dispatch({ type: 'CLOSE_MODAL', modal: 'detail' });
  }, [state.animeList]);

  const handleDeleteFromWatching = useCallback((animeId: string) => {
    addToWatchingDeleted(animeId);
    dispatch({ type: 'REMOVE_ANIME', payload: animeId });
  }, []);

  const handleExportUserData = useCallback(async () => {
    try {
      await exportAllUserData();
      message.success('备份已导出（含图片）');
    } catch (e) {
      message.error('导出失败：' + (e instanceof Error ? e.message : '未知错误'));
    }
  }, []);

  const handleImportUserData = useCallback(async (file: File) => {
    try {
      await importUserData(file);
      message.success('已导入，正在刷新…');
      fetchData();
    } catch (e) {
      message.error('导入失败：' + (e instanceof Error ? e.message : '未知错误'));
    }
  }, [fetchData]);

  const handleAddAnime = useCallback((anime: AnimeEntry) => {
    dispatch({ type: 'ADD_ANIME', payload: anime });
    dispatch({ type: 'CLOSE_MODAL', modal: 'search' });
  }, []);

  const handleOpenExcel = useCallback(async () => {
    try {
      const resp = await fetch('/api/excel/open');
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        throw new Error((errData as { error?: string }).error || `HTTP ${resp.status}`);
      }
    } catch (e) {
      message.error('打开 Excel 失败：' + (e instanceof Error ? e.message : '请检查 Excel 文件是否存在'));
    }
  }, []);

  const handleBatchSavePosters = useCallback(async () => {
    const candidates = state.animeList.filter((a) => a.excelRowIndex !== undefined && a.posterUrl);
    if (candidates.length === 0) { message.warning('没有需要持久化的海报'); return; }
    const hide = message.loading(`正在持久化海报 (0/${candidates.length})…`, 0);
    try {
      await batchSaveAllPosters(candidates);
      hide();
      message.success(`已持久化 ${candidates.length} 张海报到 Excel`);
    } catch (e) {
      hide();
      message.error('持久化失败：' + (e instanceof Error ? e.message : '未知错误'));
    }
  }, [state.animeList]);

  const handleDimensionRank = useCallback((dimKey: string, order: 'asc' | 'desc') => {
    dispatch({ type: 'SET_ACTIVE_DIM', payload: dimKey });
    if (dimKey !== 'namesort') {
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
    Promise.all(affected.map((a) => updateAnimeEntry(a).catch(() => {})));
    message.success(`已将「${oldName}」重命名为「${newName}」`);
  }, [state.animeList]);

  const handleDeleteTag = useCallback((tagName: string) => {
    dispatch({ type: 'DELETE_TAG', tagName });
    const affected = state.animeList
      .filter((a) => a.tags.some((t) => t.name === tagName) && a.excelRowIndex !== undefined)
      .map((a) => ({
        ...a,
        tags: a.tags.filter((t) => t.name !== tagName),
      }));
    Promise.all(affected.map((a) => updateAnimeEntry(a).catch(() => {})));
    message.success(`已全局删除标签「${tagName}」`);
  }, [state.animeList]);

  const handleBatchAddTags = useCallback(() => {
    if (state.selectedBatchTags.length === 0 || state.selectedBatchAnime.length === 0) {
      message.warning('请至少选择一个标签和一部番剧');
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
    Promise.all(affected.map((a) => updateAnimeEntry(a).catch(() => {})));
    message.success(`已将 ${state.selectedBatchTags.length} 个标签添加到 ${state.selectedBatchAnime.length} 部番剧`);
  }, [state.selectedBatchTags, state.selectedBatchAnime, state.animeList]);

  const handleCancelBatch = useCallback(() => {
    dispatch({ type: 'SET_BATCH_MODE', payload: false });
    dispatch({ type: 'SET_BATCH_TAGS', payload: [] });
    dispatch({ type: 'SET_BATCH_ANIME', payload: [] });
  }, []);

  const handleFixSearchAlias = useCallback(async () => {
    const candidates = state.animeList.filter((a) => a.excelRowIndex !== undefined);
    if (candidates.length === 0) { message.warning('没有可修正的番剧'); return; }
    const hide = message.loading('正在修正检索名 (0/' + candidates.length + ')…', 0);
    let done = 0;
    for (const anime of candidates) {
      try {
        const resp = await fetch(`/api/anilist/search?keyword=${encodeURIComponent(anime.title)}`);
        if (!resp.ok) { done++; continue; }
        const data = await resp.json();
        const alias = data?.list?.[0]?.name || '';
        if (!alias || alias === anime.searchAlias) { done++; continue; }
        const updated = { ...anime, searchAlias: alias, updatedAt: new Date().toISOString().split('T')[0] };
        dispatch({ type: 'UPDATE_ANIME_IN_LIST', payload: updated });
        updateAnimeEntry(updated).catch(() => {});
        done++;
      } catch { done++; }
      if (done < candidates.length) await new Promise((r) => setTimeout(r, 800));
    }
    hide();
    message.success(`检索名修正完成 (${done}/${candidates.length})`);
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
      if (anime.excelRowIndex !== undefined) updateAnimeEntry(updated).catch(() => {});
      const label = targetType === 'tag' ? '标签' : targetType === 'studio' ? '制作公司' : '角色';
      message.success(`已将「${targetName}」${targetType === 'studio' ? '设为' : '添加到'}「${anime.title}」的${label}`);
    },
    [state.animeList],
  );

  // Excel 导入导出
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fileInputRef = useRef<HTMLInputElement>(null) as any;

  const handleImportExcel = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const XLSX = await import('xlsx');
      const data = await file.arrayBuffer();
      const wb = XLSX.read(data, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }) as unknown[][];
      const entries: AnimeEntry[] = [];
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const title = String(row[EXCEL_COL.TITLE] || '').trim();
        if (!title) continue;
        const scores: { dimensionKey: string; score: number }[] = [];
        for (const [dimKey, colIdx] of Object.entries(DIMENSION_COL_MAP)) {
          const v = Number(row[colIdx]);
          if (v > 0) scores.push({ dimensionKey: dimKey, score: v });
        }
        entries.push({
          id: `import-${i}-${Date.now()}`,
          title,
          posterUrl: '',
          category: 'watched' as AnimeCategory,
          tags: String(row[EXCEL_COL.TAG] || '').split(/[/、]/).filter(Boolean).map((n: string) => ({ name: n.trim(), highlighted: false })),
          scores,
          releaseDate: String(row[EXCEL_COL.RELEASE_DATE] || ''),
          bangumiScore: Number(row[EXCEL_COL.BGM_SCORE]) || undefined,
          review: String(row[EXCEL_COL.REVIEW] || ''),
          studio: String(row[EXCEL_COL.STUDIO] || ''),
          createdAt: new Date().toISOString().split('T')[0],
          updatedAt: new Date().toISOString().split('T')[0],
        });
      }
      dispatch({ type: 'SET_ANIME_LIST', payload: entries });
      message.success(`已导入 ${entries.length} 条记录`);
    } catch (err) {
      message.error('导入失败：' + (err instanceof Error ? err.message : '文件格式错误'));
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const handleExportExcel = useCallback(async () => {
    try {
      const XLSX = await import('xlsx');
      const headers = ['检索名', '名字', '赋分', '综合(观感)', '音', '制作', '张数', '作画', '制作组', '内容', '沉浸感', '剧情', '人设', '深度', '电波', '评价', '上映年月', '首刷时间', '备注', '', '', '', 'BGM', '', '', 'tag'];
      const rows = [headers];
      for (const a of state.animeList) {
        const row = Array(40).fill('');
        row[EXCEL_COL.TITLE] = a.title;
        row[EXCEL_COL.SEARCH_ALIAS] = a.searchAlias || '';
        row[EXCEL_COL.STUDIO] = a.studio || '';
        row[EXCEL_COL.REVIEW] = a.review || '';
        row[EXCEL_COL.RELEASE_DATE] = a.releaseDate || '';
        row[EXCEL_COL.BGM_SCORE] = a.bangumiScore || '';
        row[EXCEL_COL.TAG] = a.tags.map((t) => t.name).join('/');
        for (const s of a.scores) {
          const col = DIMENSION_COL_MAP[s.dimensionKey];
          if (col !== undefined) row[col] = s.score;
        }
        rows.push(row);
      }
      const ws = XLSX.utils.aoa_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, '番剧列表');
      XLSX.writeFile(wb, '番评分_导出.xlsx');
      message.success(`已导出 ${state.animeList.length} 条记录`);
    } catch { message.error('导出失败'); }
  }, [state.animeList]);

  const value: AnimeContextValue = {
    state,
    dispatch,
    fetchData,
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
    handleCreateRelation,
    handleImportExcel,
    handleFileChange,
    handleExportExcel,
    fileInputRef,
  };

  return React.createElement(AnimeContext.Provider, { value }, children);
};
