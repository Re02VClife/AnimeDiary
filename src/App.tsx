import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Layout, Spin, Result, Button, message } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';
import AnimeGrid from './components/AnimeGrid';
import AnimeDetailModal from './components/AnimeDetailModal';
import SearchAddModal from './components/SearchAddModal';
import DimensionManager from './components/DimensionManager';
import KnowledgeGraphModal from './components/KnowledgeGraphModal';
import AISettings from './components/AISettings';
import TasteReportModal from './components/TasteReportModal';
import { loadAnimeList, updateAnimeEntry } from './services/excelService';
import { saveCategory, addToWatchingDeleted, loadImgHeight, saveImgHeight, exportAllUserData, importUserData } from './services/storageService';
import { rankByDimension } from './services/rankingService';
import type { AnimeCategory, AnimeEntry, DimensionScore, AnimeTag } from './types';
import { EXCEL_COL, DIMENSION_COL_MAP } from './services/excelMapping';
import './App.css';

const { Sider, Content } = Layout;

const App: React.FC = () => {
  const [activeCategory, setActiveCategory] = useState<AnimeCategory>('watched');
  const [searchText, setSearchText] = useState('');
  const [searchMode, setSearchMode] = useState<'title' | 'tag'>('title');
  const [activeTag, setActiveTag] = useState<string | null>(null); // Tag 管理筛选
  const [animeList, setAnimeList] = useState<AnimeEntry[]>([]);

  // ── 批量添加模式 ──
  const [batchMode, setBatchMode] = useState(false);
  const [selectedBatchTags, setSelectedBatchTags] = useState<string[]>([]);
  const [selectedBatchAnime, setSelectedBatchAnime] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedAnime, setSelectedAnime] = useState<AnimeEntry | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [searchModalOpen, setSearchModalOpen] = useState(false);
  const [dimManagerOpen, setDimManagerOpen] = useState(false);
  const [knowledgeGraphOpen, setKnowledgeGraphOpen] = useState(false);
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const [tasteReportOpen, setTasteReportOpen] = useState(false);
  const [imgHeight, setImgHeight] = useState(() => loadImgHeight());

  // 维度排序联动主网格
  const [activeDim, setActiveDim] = useState<string>('overall');
  const [sortByDim, setSortByDim] = useState<string | null>(null);
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  // 加载数据
  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await loadAnimeList();
      setAnimeList(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : '数据加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // 分类筛选 + 搜索 + Tag 筛选 + 维度排序
  const filteredAnime = useMemo(() => {
    let list = animeList.filter((a) => {
      const matchCategory = a.category === activeCategory;
      // 搜索：按模式匹配番名或标签
      let matchSearch = true;
      if (searchText) {
        if (searchMode === 'tag') {
          matchSearch = a.tags.some((t) => t.name.includes(searchText));
        } else {
          matchSearch = a.title.includes(searchText) || (a.searchAlias || '').includes(searchText);
        }
      }
      // Tag 管理筛选
      const matchTag = !activeTag || a.tags.some((t) => t.name === activeTag);
      return matchCategory && matchSearch && matchTag;
    });

    // 如果有维度排序，按维度分数排
    if (sortByDim) {
      if (sortByDim === 'bgm') {
        list = list
          .filter((a) => a.bangumiScore && a.bangumiScore > 0)
          .sort((a, b) => (b.bangumiScore || 0) - (a.bangumiScore || 0));
      } else if (sortByDim === 'namesort') {
        list = [...list].sort((a, b) => sortOrder === 'asc'
          ? (a.title || '').localeCompare(b.title || '', 'zh')
          : (b.title || '').localeCompare(a.title || '', 'zh'));
      } else {
        list = rankByDimension(list, sortByDim);
        if (sortOrder === 'asc') list = list.reverse();
      }
    }

    return list;
  }, [animeList, activeCategory, searchText, searchMode, activeTag, sortByDim, sortOrder]);

  // 打开详情
  const handleAnimeClick = useCallback((anime: AnimeEntry) => {
    setSelectedAnime(anime);
    setDetailOpen(true);
  }, []);

  // 保存编辑（含分类变更持久化）
  const handleSaveAnime = useCallback(async (updated: AnimeEntry) => {
    await updateAnimeEntry(updated);
    // 如果分类变了，持久化
    const old = animeList.find((a) => a.id === updated.id);
    if (old && old.category !== updated.category) {
      saveCategory(updated.id, updated.category);
    }
    setAnimeList((prev) =>
      prev.map((a) => a.id === updated.id ? { ...updated, updatedAt: new Date().toISOString().split('T')[0] } : a),
    );
    setDetailOpen(false);
  }, [animeList]);

  // 切换分类
  const handleCategoryChange = useCallback((cat: AnimeCategory) => {
    setActiveCategory(cat);
    setSortByDim(null); // 切换分类时清除排序
  }, []);

  // 从「在看」中删除
  const handleDeleteFromWatching = useCallback((animeId: string) => {
    addToWatchingDeleted(animeId);
    setAnimeList((prev) => prev.filter((a) => a.id !== animeId));
  }, []);

  // ── 用户数据一键导出/导入（含本地图片）──
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

  // ── Excel 导入导出 ──
  const fileInputRef = useRef<HTMLInputElement>(null);

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
      // 简易映射：假设第一行是表头且结构与原 Excel 一致
      const entries: AnimeEntry[] = [];
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const title = String(row[EXCEL_COL.TITLE] || '').trim();
        if (!title) continue;
        const scores: DimensionScore[] = [];
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
      setAnimeList(entries);
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
      for (const a of animeList) {
        const row = Array(40).fill('');
        row[EXCEL_COL.TITLE] = a.title;
        row[EXCEL_COL.SEARCH_ALIAS] = a.searchAlias || '';
        row[EXCEL_COL.STUDIO] = a.studio || '';
        row[EXCEL_COL.REVIEW] = a.review || '';
        row[EXCEL_COL.RELEASE_DATE] = a.releaseDate || '';
        row[EXCEL_COL.BGM_SCORE] = a.bangumiScore || '';
        row[EXCEL_COL.TAG] = a.tags.map(t => t.name).join('/');
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
      message.success(`已导出 ${animeList.length} 条记录`);
    } catch (err) {
      message.error('导出失败');
    }
  }, [animeList]);

  // 搜索新增番剧
  const handleAddAnime = useCallback((anime: AnimeEntry) => {
    setAnimeList((prev) => [...prev, anime]);
    setSearchModalOpen(false);
  }, []);

  // 直接用系统默认程序打开 Excel 文件
  const handleOpenExcel = useCallback(async () => {
    try {
      const resp = await fetch('/api/excel/open');
      if (!resp.ok) throw new Error('打开失败');
    } catch (e) {
      message.error('打开失败');
    }
  }, []);

  // 一键修正检索名：调 AniList API 取日文名填入检索名列
  const handleFixSearchAlias = useCallback(async () => {
    const candidates = animeList.filter((a) => a.excelRowIndex !== undefined);
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

        // 更新内存
        const updated = { ...anime, searchAlias: alias, updatedAt: new Date().toISOString().split('T')[0] };
        setAnimeList((prev) => prev.map((a) => a.id === anime.id ? updated : a));
        // 写回 Excel
        updateAnimeEntry(updated).catch(() => {});
        done++;
      } catch { done++; }
      // 频率限制：每 800ms 一个请求
      if (done < candidates.length) await new Promise((r) => setTimeout(r, 800));
    }
    hide();
    message.success(`检索名修正完成 (${done}/${candidates.length})`);
  }, [animeList]);

  // 知识图谱连线建立关联：番剧 → 实体节点
  const handleCreateRelation = useCallback(
    (animeId: string, targetType: 'tag' | 'studio' | 'character', targetName: string) => {
      if (!targetName.trim()) return;
      const now = new Date().toISOString().split('T')[0];
      let toWrite: AnimeEntry | null = null;
      setAnimeList((prev) =>
        prev.map((a) => {
          if (a.id !== animeId) return a;
          let updated: AnimeEntry;
          if (targetType === 'tag') {
            if (a.tags.some((t) => t.name === targetName)) return a;
            updated = { ...a, tags: [...a.tags, { name: targetName, highlighted: true }], updatedAt: now };
          } else if (targetType === 'studio') {
            updated = { ...a, studio: targetName, updatedAt: now };
          } else {
            // character
            const chars = a.characters || [];
            if (chars.includes(targetName)) return a;
            updated = { ...a, characters: [...chars, targetName], updatedAt: now };
          }
          if (a.excelRowIndex !== undefined) toWrite = updated;
          return updated;
        }),
      );
      // 异步写回 Excel
      if (toWrite) updateAnimeEntry(toWrite).catch(() => {});
      const label = targetType === 'tag' ? '标签' : targetType === 'studio' ? '制作公司' : '角色';
      message.success(`已将「${targetName}」${targetType === 'studio' ? '设为' : '添加到'}「${animeList.find(a => a.id === animeId)?.title || animeId}」的${label}`);
    },
    [animeList],
  );

  // 维度排序 → 联动主网格（番名排序保持在当前分类，其余维度切换到「看过」）
  const handleDimensionRank = (dimKey: string, order: 'asc' | 'desc') => {
    setActiveDim(dimKey);
    setSortByDim(dimKey);
    setSortOrder(order);
    if (dimKey !== 'namesort') {
      setActiveCategory('watched');
    }
  };

  // ── Tag 全量操作 ──

  /** 重命名标签：所有番剧中将 oldName 替换为 newName，并写回 Excel */
  const handleRenameTag = useCallback((oldName: string, newName: string) => {
    if (oldName === newName) return;
    // 找出受影响且有 Excel 行号的条目
    const affected = animeList
      .filter((a) => a.tags.some((t) => t.name === oldName) && a.excelRowIndex !== undefined)
      .map((a) => ({
        ...a,
        tags: a.tags.map((t) => t.name === oldName ? { ...t, name: newName } : t),
      }));
    setAnimeList((prev) =>
      prev.map((a) => ({
        ...a,
        tags: a.tags.map((t) => t.name === oldName ? { ...t, name: newName } : t),
      })),
    );
    // 写回 Excel（异步，不阻塞 UI）
    Promise.all(affected.map((a) => updateAnimeEntry(a).catch(() => {})));
    if (activeTag === oldName) setActiveTag(newName);
    message.success(`已将「${oldName}」重命名为「${newName}」`);
  }, [activeTag, animeList]);

  /** 删除标签：从所有番剧中移除此标签，并写回 Excel */
  const handleDeleteTag = useCallback((tagName: string) => {
    // 找出受影响且有 Excel 行号的条目
    const affected = animeList
      .filter((a) => a.tags.some((t) => t.name === tagName) && a.excelRowIndex !== undefined)
      .map((a) => ({
        ...a,
        tags: a.tags.filter((t) => t.name !== tagName),
      }));
    setAnimeList((prev) =>
      prev.map((a) => ({
        ...a,
        tags: a.tags.filter((t) => t.name !== tagName),
      })),
    );
    // 写回 Excel（异步，不阻塞 UI）
    Promise.all(affected.map((a) => updateAnimeEntry(a).catch(() => {})));
    if (activeTag === tagName) setActiveTag(null);
    message.success(`已全局删除标签「${tagName}」`);
  }, [activeTag, animeList]);

  /** 批量添加标签到选定番剧 */
  const handleBatchAddTags = useCallback(() => {
    if (selectedBatchTags.length === 0 || selectedBatchAnime.length === 0) {
      message.warning('请至少选择一个标签和一部番剧');
      return;
    }
    // 受影响且有 Excel 行号的条目
    const affected = animeList
      .filter((a) => selectedBatchAnime.includes(a.id) && a.excelRowIndex !== undefined)
      .map((a) => {
        const existingNames = new Set(a.tags.map((t) => t.name));
        const newTags = selectedBatchTags.filter((name) => !existingNames.has(name));
        if (newTags.length === 0) return null;
        return {
          ...a,
          tags: [...a.tags, ...newTags.map((name) => ({ name, highlighted: true } as AnimeTag))],
        };
      })
      .filter(Boolean) as AnimeEntry[];
    setAnimeList((prev) =>
      prev.map((a) => {
        if (!selectedBatchAnime.includes(a.id)) return a;
        const existingNames = new Set(a.tags.map((t) => t.name));
        const newTags = selectedBatchTags
          .filter((name) => !existingNames.has(name))
          .map((name) => ({ name, highlighted: true } as AnimeTag));
        if (newTags.length === 0) return a;
        return { ...a, tags: [...a.tags, ...newTags] };
      }),
    );
    // 写回 Excel（异步）
    Promise.all(affected.map((a) => updateAnimeEntry(a).catch(() => {})));
    message.success(
      `已将 ${selectedBatchTags.length} 个标签添加到 ${selectedBatchAnime.length} 部番剧`,
    );
    setBatchMode(false);
    setSelectedBatchTags([]);
    setSelectedBatchAnime([]);
  }, [selectedBatchTags, selectedBatchAnime, animeList]);

  /** 取消批量模式 */
  const handleCancelBatch = useCallback(() => {
    setBatchMode(false);
    setSelectedBatchTags([]);
    setSelectedBatchAnime([]);
  }, []);

  if (loading) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0d1117' }}>
        <Spin size="large" tip="正在读取番剧数据…"><div style={{ padding: 50 }} /></Spin>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0d1117' }}>
        <Result status="warning" title="数据加载失败" subTitle={error}
          extra={<Button type="primary" icon={<ReloadOutlined />} onClick={fetchData}>重试</Button>} />
      </div>
    );
  }

  return (
    <Layout className="app-layout">
      <Sider width={300} className="app-sidebar">
        <Sidebar
          animeList={animeList}
          activeDim={activeDim}
          onActiveDimChange={setActiveDim}
          onDimensionRank={handleDimensionRank}
          onImportExcel={handleImportExcel}
          onExportExcel={handleExportExcel}
          onOpenDimensionManager={() => setDimManagerOpen(true)}
          onAnimeClick={handleAnimeClick}
          imgHeight={imgHeight}
          onImgHeightChange={(h) => { setImgHeight(h); saveImgHeight(h); }}
          activeTag={activeTag}
          onActiveTagChange={setActiveTag}
          onRenameTag={handleRenameTag}
          onDeleteTag={handleDeleteTag}
          batchMode={batchMode}
          selectedBatchTags={selectedBatchTags}
          onBatchTagsChange={setSelectedBatchTags}
          onStartBatch={() => { setBatchMode(true); setSelectedBatchTags([]); setSelectedBatchAnime([]); }}
          onConfirmBatch={handleBatchAddTags}
          onCancelBatch={handleCancelBatch}
          onOpenKnowledgeGraph={() => setKnowledgeGraphOpen(true)}
          onExportUserData={handleExportUserData}
          onImportUserData={handleImportUserData}
          onFixSearchAlias={handleFixSearchAlias}
          onOpenExcel={handleOpenExcel}
          onOpenAISettings={() => setAiSettingsOpen(true)}
          onOpenTasteReport={() => setTasteReportOpen(true)}
        />
      </Sider>

      <Layout className="main-layout">
        <Content className="main-content">
          <TopBar
            activeCategory={activeCategory}
            onCategoryChange={handleCategoryChange}
            searchText={searchText}
            onSearchChange={setSearchText}
            searchMode={searchMode}
            onSearchModeChange={setSearchMode}
            onAddAnime={() => setSearchModalOpen(true)}
          />
          {/* 排序 + Tag 筛选指示器 */}
          {(sortByDim || activeTag) && (
            <div style={{
              padding: '4px 0', fontSize: 12, color: '#8b949e',
              display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
            }}>
              {sortByDim && (
                <>
                  <span>按 <span style={{ color: '#fb7299' }}>{sortByDim === 'namesort' ? '番名' : sortByDim === 'bgm' ? 'BGM' : sortByDim}</span> 排序</span>
                  <span style={{ color: '#484f58' }}>{sortOrder === 'desc' ? '↓高到低' : '↑低到高'}</span>
                  <Button size="small" type="text" style={{ color: '#8b949e', fontSize: 11 }}
                    onClick={() => { setSortByDim(null); }}>
                    清除排序
                  </Button>
                </>
              )}
              {activeTag && (
                <>
                  <span>🏷️ Tag: <span style={{ color: '#fb7299' }}>{activeTag}</span></span>
                  <Button size="small" type="text" style={{ color: '#8b949e', fontSize: 11 }}
                    onClick={() => { setActiveTag(null); }}>
                    清除筛选
                  </Button>
                </>
              )}
            </div>
          )}
          <AnimeGrid
            animeList={filteredAnime}
            onAnimeClick={handleAnimeClick}
            activeDim={activeDim}
            onDeleteFromWatching={activeCategory === 'watching' ? handleDeleteFromWatching : undefined}
            batchMode={batchMode}
            selectedBatchAnime={selectedBatchAnime}
            onBatchAnimeChange={setSelectedBatchAnime}
          />
          {/* 批量模式底部状态栏 */}
          {batchMode && (
            <div style={{
              position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)',
              background: '#1c2128', border: '1px solid #30363d', borderRadius: 20,
              padding: '8px 20px', display: 'flex', alignItems: 'center', gap: 16,
              boxShadow: '0 4px 24px rgba(0,0,0,0.5)', zIndex: 100,
              fontSize: 13, color: '#e6edf3',
            }}>
              <span>🏷️ <b style={{ color: '#fb7299' }}>{selectedBatchTags.length}</b> 个标签</span>
              <span>→</span>
              <span>🎬 <b style={{ color: '#fb7299' }}>{selectedBatchAnime.length}</b> 部番剧</span>
              <Button size="small" type="primary" onClick={handleBatchAddTags}
                disabled={!selectedBatchTags.length || !selectedBatchAnime.length}
                style={{ borderRadius: 12 }}>
                确认添加
              </Button>
              <Button size="small" onClick={handleCancelBatch} style={{ borderRadius: 12 }}>
                取消
              </Button>
            </div>
          )}
        </Content>
      </Layout>

      <AnimeDetailModal
        anime={selectedAnime}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        onSave={handleSaveAnime}
        allAnime={animeList}
        imgHeight={imgHeight}
        onPosterChange={(animeId, posterUrl) => {
          setAnimeList((prev) =>
            prev.map((a) => a.id === animeId ? { ...a, posterUrl } : a),
          );
          if (selectedAnime?.id === animeId) {
            setSelectedAnime((prev) => prev ? { ...prev, posterUrl } : prev);
          }
        }}
      />

      <SearchAddModal
        open={searchModalOpen}
        onClose={() => setSearchModalOpen(false)}
        onAdd={handleAddAnime}
      />

      <DimensionManager
        open={dimManagerOpen}
        onClose={() => setDimManagerOpen(false)}
      />

      <KnowledgeGraphModal
        open={knowledgeGraphOpen}
        onClose={() => setKnowledgeGraphOpen(false)}
        animeList={animeList}
        onAnimeClick={(anime) => {
          setKnowledgeGraphOpen(false);
          handleAnimeClick(anime);
        }}
        onCreateRelation={handleCreateRelation}
      />

      <AISettings
        open={aiSettingsOpen}
        onClose={() => setAiSettingsOpen(false)}
      />

      <TasteReportModal
        open={tasteReportOpen}
        onClose={() => setTasteReportOpen(false)}
        animeList={animeList}
      />

      {/* 隐藏的 Excel 导入文件选择器 */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".xlsx,.xls"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />
    </Layout>
  );
};

export default App;
