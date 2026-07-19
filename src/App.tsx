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
import AppIcon from './theme/AppIcon';
import AISettings from '../features/ai-analysis/AISettings';
import TasteReportModal from '../features/ai-analysis/TasteReportModal';
import PosterFlipOverlay from './components/PosterFlipOverlay';
import './App.css';

const { Sider, Content } = Layout;

const App: React.FC = () => {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);

  // ── FLIP 海报过渡状态 ──
  const [flipState, setFlipState] = useState<{
    posterUrl: string;
    startRect: DOMRect;
    endRect: DOMRect | null;
    /** 起始 object-position（网格海报的裁剪位置） */
    startObjPos: string;
    /** 目标 object-position（Modal 海报的裁剪位置，打开时后续捕获） */
    endObjPos: string | null;
  } | null>(null);

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

  // FLIP 过渡：Modal 打开后捕获详情海报位置
  useEffect(() => {
    if (!flipState || flipState.endRect || !detailOpen) return;
    // 安全兜底：800ms 后仍未捕获则放弃，避免海报永久隐藏
    const safety = setTimeout(() => {
      setFlipState((prev) => prev && !prev.endRect ? null : prev);
    }, 1200);
    // 等 Modal 渲染完成
    const timer = setTimeout(() => {
      const modalImg = document.querySelector(
        '[data-modal-poster="true"]'
      ) as HTMLElement | null;
      if (modalImg) {
        const endRect = modalImg.getBoundingClientRect();
        if (endRect.width > 0 && endRect.height > 0) {
          const endObjPos = getComputedStyle(modalImg).objectPosition || '50% 50%';
          setFlipState((prev) => prev ? { ...prev, endRect, endObjPos } : null);
        } else {
          requestAnimationFrame(() => {
            const retry = modalImg.getBoundingClientRect();
            if (retry.width > 0) {
              const endObjPos = getComputedStyle(modalImg).objectPosition || '50% 50%';
              setFlipState((prev) => prev ? { ...prev, endRect: retry, endObjPos } : null);
            }
          });
        }
      }
    }, 50);  // transitionName="" 已关闭动画，Modal 在最终位置
    return () => { clearTimeout(timer); clearTimeout(safety); };
  }, [flipState, detailOpen]);

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
        collapsedWidth={0}
        collapsed={sidebarCollapsed}
        onMouseEnter={() => setSidebarCollapsed(false)}
        onMouseLeave={() => setSidebarCollapsed(true)}
        className="app-sidebar"
      >
        <Sidebar collapsed={sidebarCollapsed} />
      </Sider>

      <Layout className="main-layout">
        {/* 收起状态方块：绝对定位覆盖在内容区左上角 */}
        {sidebarCollapsed && (
          <div
            style={{
              position: 'absolute', left: 0, top: 0, zIndex: 20,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              height: 60, width: 60,
              background: 'var(--bg-secondary)',
              borderBottom: '1px solid var(--border-primary)',
              borderRight: '1px solid var(--border-primary)',
              borderRadius: '0 0 8px 0',
              cursor: 'pointer',
            }}
            onMouseEnter={() => setSidebarCollapsed(false)}
          >
            <AppIcon name="anime" size={22} style={{ opacity: 0.7 }} />
          </div>
        )}
        <Content className="main-content">
          <div style={sidebarCollapsed ? { marginLeft: 60 } : undefined}>
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
          </div>

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
            onAnimeClick={(anime) => {
              // 捕获网格海报的屏幕位置和裁剪位置用于 FLIP 过渡
              const gridImg = document.querySelector(
                `[data-poster-anime-id="${CSS.escape(anime.id)}"]`
              ) as HTMLElement | null;
              if (gridImg && anime.posterUrl) {
                const startRect = gridImg.getBoundingClientRect();
                const startObjPos = getComputedStyle(gridImg).objectPosition || '50% 50%';
                setFlipState({ posterUrl: anime.posterUrl, startRect, endRect: null, startObjPos, endObjPos: null });
              }
              handleAnimeClick(anime);
            }}
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
        onClose={() => {
          // 关闭 FLIP：捕获 Modal 海报 → 网格海报位置
          if (selectedAnime?.posterUrl) {
            const modalImg = document.querySelector(
              '[data-modal-poster="true"]'
            ) as HTMLElement | null;
            const gridImg = document.querySelector(
              `[data-poster-anime-id="${CSS.escape(selectedAnime.id)}"]`
            ) as HTMLElement | null;
            if (modalImg && gridImg) {
              setFlipState({
                posterUrl: selectedAnime.posterUrl,
                startRect: modalImg.getBoundingClientRect(),
                endRect: gridImg.getBoundingClientRect(),
                startObjPos: getComputedStyle(modalImg).objectPosition || '50% 50%',
                endObjPos: getComputedStyle(gridImg).objectPosition || '50% 50%',
              });
            }
          }
          dispatch({ type: 'CLOSE_MODAL', modal: 'detail' });
        }}
        onSave={handleSaveAnime}
        editMode={detailEditMode}
        onNavigate={(target) => {
          // 前后番剧切换：直接替换当前选中番剧，保持详情面板打开
          dispatch({ type: 'OPEN_MODAL', modal: 'detail', anime: target });
        }}
        onAddAnime={handleAddAnime}
        allAnime={state.animeList}
        imgHeight={imgHeight}
        radarMode={radarMode}
        radarMin={radarMin}
        contentHidden={flipState !== null && !flipState.endRect && detailOpen}
        posterHidden={flipState !== null && detailOpen}
        onPosterChange={(animeId, posterUrl) => {
          dispatch({ type: 'SET_ANIME_POSTER', animeId, posterUrl });
        }}
      />

      <SearchAddModal
        open={searchOpen}
        onClose={() => dispatch({ type: 'CLOSE_MODAL', modal: 'search' })}
        onAdd={handleAddAnime}
        activeTemplateId={activeTemplateId}
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

      {/* FLIP 海报过渡：克隆海报从网格位置飞入详情面板位置 */}
      {flipState?.endRect && (
        <PosterFlipOverlay
          posterUrl={flipState.posterUrl}
          startRect={flipState.startRect}
          endRect={flipState.endRect}
          startObjPos={flipState.startObjPos}
          endObjPos={flipState.endObjPos ?? undefined}
          onDone={() => setFlipState(null)}
        />
      )}
    </Layout>
  );
};

export default App;
