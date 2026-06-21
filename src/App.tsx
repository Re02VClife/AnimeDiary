/**
 * App — 薄编排器
 *   状态管理已迁移到 AnimeContext，此处仅负责布局组合
 */
import React from 'react';
import { Layout, Spin, Result, Button } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useAnimeContext } from '../context/AnimeContext';
import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';
import AnimeGrid from './components/AnimeGrid';
import AnimeDetailModal from './components/AnimeDetailModal';
import SearchAddModal from '../features/search-add/SearchAddModal';
import DimensionManager from './components/DimensionManager';
import KnowledgeGraphModal from '../features/knowledge-graph/KnowledgeGraphModal';
import AISettings from '../features/ai-analysis/AISettings';
import TasteReportModal from '../features/ai-analysis/TasteReportModal';
import './App.css';

const { Sider, Content } = Layout;

const App: React.FC = () => {
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
    searchModalOpen,
    dimManagerOpen,
    knowledgeGraphOpen,
    aiSettingsOpen,
    tasteReportOpen,
    batchMode,
    selectedBatchTags,
    selectedBatchAnime,
    imgHeight,
  } = state;

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
        <Sidebar />
      </Sider>

      <Layout className="main-layout">
        <Content className="main-content">
          <TopBar
            activeCategory={activeCategory}
            onCategoryChange={(c) => dispatch({ type: 'SET_CATEGORY', payload: c })}
            searchText={searchText}
            onSearchChange={(t) => dispatch({ type: 'SET_SEARCH', text: t, mode: searchMode })}
            searchMode={searchMode}
            onSearchModeChange={(m) => dispatch({ type: 'SET_SEARCH', text: searchText, mode: m })}
            onAddAnime={() => dispatch({ type: 'OPEN_MODAL', modal: 'search' })}
          />

          {(sortByDim || activeTag) && (
            <div style={{ padding: '4px 0', fontSize: 12, color: '#8b949e', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {sortByDim && (
                <>
                  <span>按 <span style={{ color: '#fb7299' }}>{sortByDim === 'namesort' ? '番名' : sortByDim === 'bgm' ? 'BGM' : sortByDim}</span> 排序</span>
                  <span style={{ color: '#484f58' }}>{sortOrder === 'desc' ? '↓高到低' : '↑低到高'}</span>
                  <Button size="small" type="text" style={{ color: '#8b949e', fontSize: 11 }}
                    onClick={() => dispatch({ type: 'SET_SORT', dimKey: null, order: 'desc' })}>清除排序</Button>
                </>
              )}
              {activeTag && (
                <>
                  <span>🏷️ Tag: <span style={{ color: '#fb7299' }}>{activeTag}</span></span>
                  <Button size="small" type="text" style={{ color: '#8b949e', fontSize: 11 }}
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
          />

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
        onNavigate={(target) => {
          // 前后番剧切换：直接替换当前选中番剧，保持详情面板打开
          dispatch({ type: 'OPEN_MODAL', modal: 'detail', anime: target });
        }}
        allAnime={state.animeList}
        imgHeight={imgHeight}
        onPosterChange={(animeId, posterUrl) => {
          dispatch({ type: 'SET_ANIME_POSTER', animeId, posterUrl });
        }}
      />

      <SearchAddModal
        open={searchModalOpen}
        onClose={() => dispatch({ type: 'CLOSE_MODAL', modal: 'search' })}
        onAdd={handleAddAnime}
      />

      <DimensionManager
        open={dimManagerOpen}
        onClose={() => dispatch({ type: 'CLOSE_MODAL', modal: 'dimManager' })}
      />

      <KnowledgeGraphModal
        open={knowledgeGraphOpen}
        onClose={() => dispatch({ type: 'CLOSE_MODAL', modal: 'knowledgeGraph' })}
        animeList={state.animeList}
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
