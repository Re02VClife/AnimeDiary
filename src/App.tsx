/**
 * App — 薄编排器
 *   状态管理已迁移到 AnimeContext，此处仅负责布局组合
 */
import React, { useState, useMemo, useEffect } from 'react';
import { Layout, Spin, Result, Button } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useAnimeContext } from '../context/AnimeContext';
import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';
import AnimeGrid from './components/AnimeGrid';
import AnimeDetailModal from './components/AnimeDetailModal';
import SearchAddModal from '../features/search-add/SearchAddModal';
import TemplateManager from './components/TemplateManager';
import { loadTemplates } from '../features/anime-data/template-service';
import { getVisibleCategories } from './types';
import KnowledgeGraphModal from '../features/knowledge-graph/KnowledgeGraphModal';
import AISettings from '../features/ai-analysis/AISettings';
import TasteReportModal from '../features/ai-analysis/TasteReportModal';
import './App.css';

const { Sider, Content } = Layout;

const App: React.FC = () => {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);

  const {
    state,
    dispatch,
    fetchData,
    filteredAnime,
    handleAnimeClick,
    handleSaveAnime,
    handleDeleteFromWatching,
    handleDimensionRank,
    handleImportExcel,
    handleExportExcel,
    handleAddAnime,
    handleExportUserData,
    handleImportUserData,
    handleBatchSavePosters,
    handleFixSearchAlias,
    handleOpenExcel,
    handleCreateRelation,
    handleRenameTag,
    handleDeleteTag,
    handleBatchAddTags,
    handleCancelBatch,
    handleFileChange,
    fileInputRef,
  } = useAnimeContext();

  const {
    loading,
    error,
    activeCategory,
    searchText,
    searchMode,
    activeTag,
    activeDim,
    sortByDim,
    sortOrder,
    selectedAnime,
    detailOpen,
    searchOpen,
    dimManagerOpen,
    templateManagerOpen,
    knowledgeGraphOpen,
    aiSettingsOpen,
    tasteReportOpen,
    batchMode,
    selectedBatchTags,
    selectedBatchAnime,
    imgHeight,
    radarMode,
    radarMin,
    activeTemplateId,
    detailEditMode,
  } = state;

  const templates = useMemo(() => loadTemplates(), []);

  // 当前模板的分类标签覆盖（传给 TopBar 决定显示哪些分类 tab）
  const activeTemplateCategoryLabels = useMemo(() => {
    const t = templates.find((t) => t.id === activeTemplateId);
    return t?.categoryLabels;
  }, [activeTemplateId, templates]);

  // 当前模板的维度列表（传给 AnimeGrid/Sidebar 用于标签查找和排名）
  const activeTemplateDims = useMemo(() => {
    const t = templates.find((t) => t.id === activeTemplateId);
    return t?.dimensions;
  }, [activeTemplateId, templates]);

  // 切换模板时，若当前分类不在可见列表中，自动切到第一个可见分类
  useEffect(() => {
    const t = templates.find((t) => t.id === activeTemplateId);
    if (!t) return;
    const visible = getVisibleCategories(t.categoryLabels);
    if (visible.length > 0 && !visible.includes(activeCategory)) {
      dispatch({ type: 'SET_CATEGORY', payload: visible[0] });
    }
  }, [activeTemplateId]);

  if (loading) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-primary)' }}>
        <Spin size="large" tip="正在读取番剧数据…"><div style={{ padding: 50 }} /></Spin>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-primary)' }}>
        <Result status="warning" title="数据加载失败" subTitle={error}
          extra={<Button type="primary" icon={<ReloadOutlined />} onClick={fetchData}>重试</Button>} />
      </div>
    );
  }

  return (
    <Layout className="app-layout">
      <Sider
        width={300}
        collapsedWidth={48}
        collapsed={sidebarCollapsed}
        onMouseEnter={() => setSidebarCollapsed(false)}
        onMouseLeave={() => setSidebarCollapsed(true)}
        className="app-sidebar"
      >
        <Sidebar collapsed={sidebarCollapsed} />
      </Sider>

      <Layout className="main-layout">
        <Content className="main-content">
          <TopBar
            activeCategory={activeCategory}
            onCategoryChange={(c) => dispatch({ type: 'SET_CATEGORY', payload: c })}
            searchText={searchText}
            onSearchChange={(t) => dispatch({ type: 'SET_SEARCH_TEXT', payload: t })}
            searchMode={searchMode}
            onSearchModeChange={(m) => dispatch({ type: 'SET_SEARCH_MODE', payload: m })}
            onAddAnime={() => dispatch({ type: 'OPEN_MODAL', modal: 'search' })}
            templates={templates}
            activeTemplateId={activeTemplateId}
            onTemplateChange={(id: string) => dispatch({ type: 'SET_ACTIVE_TEMPLATE', payload: id })}
            categoryLabels={activeTemplateCategoryLabels}
          />

          {(sortByDim || activeTag) && (
            <div style={{ padding: '4px 0', fontSize: 12, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {sortByDim && (
                <>
                  <span>按 <span style={{ color: 'var(--brand-primary)' }}>{sortByDim === 'namesort' ? '番名' : sortByDim === 'bgm' ? 'BGM' : sortByDim}</span> 排序</span>
                  <span style={{ color: 'var(--text-muted)' }}>{sortOrder === 'desc' ? '↓高到低' : '↑低到高'}</span>
                  <Button size="small" type="text" style={{ color: 'var(--text-secondary)', fontSize: 11 }}
                    onClick={() => dispatch({ type: 'SET_SORT', dimKey: null, order: 'desc' })}>清除排序</Button>
                </>
              )}
              {activeTag && (
                <>
                  <span>🏷️ Tag: <span style={{ color: 'var(--brand-primary)' }}>{activeTag}</span></span>
                  <Button size="small" type="text" style={{ color: 'var(--text-secondary)', fontSize: 11 }}
                    onClick={() => dispatch({ type: 'SET_ACTIVE_TAG', payload: null })}>清除筛选</Button>
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
            onBatchAnimeChange={(ids) => dispatch({ type: 'SET_BATCH_ANIME', payload: ids })}
            templateDims={activeTemplateDims}
          />

          {batchMode && (
            <div style={{
              position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)',
              background: 'var(--bg-tertiary)', border: '1px solid #30363d', borderRadius: 20,
              padding: '8px 20px', display: 'flex', alignItems: 'center', gap: 16,
              boxShadow: '0 4px 24px rgba(0,0,0,0.5)', zIndex: 100,
              fontSize: 13, color: 'var(--text-primary)',
            }}>
              <span>🏷️ <b style={{ color: 'var(--brand-primary)' }}>{selectedBatchTags.length}</b> 个标签</span>
              <span>→</span>
              <span>🎬 <b style={{ color: 'var(--brand-primary)' }}>{selectedBatchAnime.length}</b> 部番剧</span>
              <Button size="small" type="primary" onClick={handleBatchAddTags}
                disabled={!selectedBatchTags.length || !selectedBatchAnime.length} style={{ borderRadius: 12 }}>确认添加</Button>
              <Button size="small" onClick={handleCancelBatch} style={{ borderRadius: 12 }}>取消</Button>
            </div>
          )}
        </Content>
      </Layout>

      <AnimeDetailModal
        anime={selectedAnime}
        open={detailOpen}
        onClose={() => dispatch({ type: 'CLOSE_MODAL', modal: 'detail' })}
        onSave={handleSaveAnime}
        editMode={detailEditMode}
        onNavigate={(target) => {
          // 前后番剧切换：直接替换当前选中番剧，保持详情面板打开
          dispatch({ type: 'OPEN_MODAL', modal: 'detail', anime: target });
        }}
        allAnime={state.animeList}
        imgHeight={imgHeight}
        radarMode={radarMode}
        radarMin={radarMin}
        onPosterChange={(animeId, posterUrl) => {
          dispatch({ type: 'SET_ANIME_POSTER', animeId, posterUrl });
        }}
      />

      <SearchAddModal
        open={searchOpen}
        onClose={() => dispatch({ type: 'CLOSE_MODAL', modal: 'search' })}
        onAdd={handleAddAnime}
      />

      <TemplateManager
        open={templateManagerOpen}
        onClose={() => dispatch({ type: 'CLOSE_MODAL', modal: 'templateManager' })}
      />

      <KnowledgeGraphModal
        open={knowledgeGraphOpen}
        onClose={() => dispatch({ type: 'CLOSE_MODAL', modal: 'knowledgeGraph' })}
        animeList={state.animeList.filter((a) => !a.templateId || a.templateId === 'default')}
        onAnimeClick={(anime) => {
          dispatch({ type: 'CLOSE_MODAL', modal: 'knowledgeGraph' });
          handleAnimeClick(anime);
        }}
        onCreateRelation={handleCreateRelation}
      />

      <AISettings
        open={aiSettingsOpen}
        onClose={() => dispatch({ type: 'CLOSE_MODAL', modal: 'aiSettings' })}
      />

      <TasteReportModal
        open={tasteReportOpen}
        onClose={() => dispatch({ type: 'CLOSE_MODAL', modal: 'tasteReport' })}
        animeList={state.animeList}
      />

      <input ref={fileInputRef} type="file" accept=".xlsx,.xls"
        style={{ display: 'none' }} onChange={handleFileChange} />
    </Layout>
  );
};

export default App;
