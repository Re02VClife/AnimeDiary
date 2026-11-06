/**
 * App — 薄编排器
 *   状态管理已迁移到 AnimeContext，此处仅负责布局组合
 */
import React, { useState, useMemo, useEffect } from 'react';
import { Layout, Result, Button } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useAnimeContext } from '../context/AnimeContext';
import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';
import AnimeGrid from './components/AnimeGrid';
import AnimeDetailModal from './components/AnimeDetailModal';
import SearchAddModal from '../features/search-add/SearchAddModal';
import MediaCompleteModal from '../features/media-complete/MediaCompleteModal';
import CharacterCompleteModal from '../features/character-complete/CharacterCompleteModal';
import CharacterCutoutModal from '../features/image-management/CharacterCutoutModal';
import TemplateManager from './components/TemplateManager';
import ExcelEditor from './components/ExcelEditor';
import { loadTemplates } from '../features/anime-data/template-service';
import { getVisibleCategories } from './types';
import KnowledgeGraphModal from '../features/knowledge-graph/KnowledgeGraphModal';
import AppIcon from './theme/AppIcon';
import AISettings from '../features/ai-analysis/AISettings';
import AIChatDrawer from './components/AIChatDrawer';
import BatchTagModal from './components/BatchTagModal';
import BackupHistoryModal from './components/BackupHistoryModal';
import { initAIConfig } from '../features/ai-analysis/ai-config';
import TasteReportModal from '../features/ai-analysis/TasteReportModal';
import PosterFlipOverlay from './components/PosterFlipOverlay';
import TitleBar from './components/TitleBar';
import UpdateToast from './components/UpdateToast';
import SettingsModal from './components/SettingsModal';
import ScreenCapture from './components/ScreenCapture';
import type { QuickActionId } from './features/quick-actions/quick-actions';
import './App.css';

const { Sider, Content } = Layout;

const App: React.FC = () => {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  /** 「数据补全」面板开关（本地模态，不入全局 reducer） */
  const [mediaCompleteOpen, setMediaCompleteOpen] = useState(false);
  /** 「角色补全」面板开关（搜索角色资料并生成角色卡） */
  const [characterCompleteOpen, setCharacterCompleteOpen] = useState(false);
  const [characterCutoutOpen, setCharacterCutoutOpen] = useState(false);
  /** 「设置」面板开关（外观 / 数据 / 工具 / 关于） */
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 顶栏快捷栏「录制 GIF」：独立打开录制面板，保存到 images/快捷截图/ */
  const [gifRecorderOpen, setGifRecorderOpen] = useState(false);

  /**
   * 顶栏快捷动作分发。
   *
   * 快捷栏的配置在 quick-actions 模块里（localStorage + 事件同步），
   * 这里只负责把动作映射到已有的打开逻辑，避免 TopBar 反过来依赖 AnimeContext。
   */
  const handleQuickAction = (id: QuickActionId) => {
    switch (id) {
      case 'gif':
        setGifRecorderOpen(true);
        break;
      case 'ai-chat':
        dispatch({ type: 'OPEN_MODAL', modal: 'aiChat' });
        break;
      case 'taste-report':
        dispatch({ type: 'OPEN_MODAL', modal: 'tasteReport' });
        break;
      case 'complete-data':
        setMediaCompleteOpen(true);
        break;
      case 'complete-characters':
        setCharacterCompleteOpen(true);
        break;
      case 'cutout':
        setCharacterCutoutOpen(true);
        break;
      case 'knowledge-graph':
        dispatch({ type: 'OPEN_MODAL', modal: 'knowledgeGraph' });
        break;
      case 'excel':
        dispatch({ type: 'OPEN_MODAL', modal: 'excel' });
        break;
      case 'backup':
        dispatch({ type: 'OPEN_MODAL', modal: 'backupHistory' });
        break;
      case 'template-manager':
        dispatch({ type: 'OPEN_MODAL', modal: 'templateManager' });
        break;
      case 'ai-settings':
        dispatch({ type: 'OPEN_MODAL', modal: 'aiSettings' });
        break;
      default:
        break;
    }
  };

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
    refreshAnimeList,
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
    aiChatOpen,
    backupHistoryOpen,
    batchTagOpen,
    excelOpen,
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

  /**
   * 侧栏 hover 展开 / 延迟收起。
   *
   * 之前这里是「鼠标不在侧栏矩形内就立即收起」。实测有两个毛病：
   *   1. 展开动画进行中 Sider 宽度还没到 300，鼠标虽然正往侧栏去，矩形判断却不成立，
   *      于是刚展开就被收起、再 hover 再展开 —— 左上角一直闪。
   *   2. 品牌块到侧栏之间隔着顶栏底部十几像素，鼠标路过那一帧也不在矩形内。
   * 现在改成：宽度动画结束（>= 280px）后才开始判定，离开后等 200ms 再收；
   * 期间鼠标回到侧栏或品牌块热区都会取消计时。
   */
  useEffect(() => {
    if (sidebarCollapsed) return undefined;
    let closeTimer: number | null = null;
    const cancel = () => {
      if (closeTimer !== null) {
        window.clearTimeout(closeTimer);
        closeTimer = null;
      }
    };
    const onMove = (e: MouseEvent) => {
      const sider = document.querySelector('.app-sidebar');
      if (!sider) return;
      const r = sider.getBoundingClientRect();
      // 展开动画没走完时宽度不稳定，先不判定，否则会自己把自己收起来
      if (r.width < 280) return;

      const inSider = e.clientX >= r.left && e.clientX <= r.right
        && e.clientY >= r.top - 16 && e.clientY <= r.bottom;
      /*
       * 品牌块用它的真实矩形算热区，不能拿 --topbar-height 当屏幕坐标：
       * 那个变量是顶栏「高度」，而 Electron 顶栏上方还有 36px 自定义标题栏，
       * 品牌块下半截（y 71~90）会落到热区外 —— 表现就是悬停有「打开侧栏」提示，
       * 鼠标一停过去就被判成离开、侧栏刚开就收，看起来完全打不开。
       */
      const brand = document.querySelector('.brand-trigger');
      const br = brand ? brand.getBoundingClientRect() : null;
      const inBrand = !!br
        && e.clientX >= br.left - 8 && e.clientX <= br.right + 8
        && e.clientY >= br.top - 8 && e.clientY <= br.bottom + 8;

      if (inSider || inBrand) {
        cancel();
        return;
      }
      if (closeTimer === null) {
        closeTimer = window.setTimeout(() => {
          closeTimer = null;
          setSidebarCollapsed(true);
        }, 200);
      }
    };
    window.addEventListener('mousemove', onMove);
    return () => {
      cancel();
      window.removeEventListener('mousemove', onMove);
    };
  }, [sidebarCollapsed]);

  // 启动时同步一次 AI 配置（真配置在服务端，浏览器只留镜像）
  useEffect(() => {
    void initAIConfig();
  }, []);

  // 切换模板时，若当前分类不在可见列表中，自动切到第一个可见分类
  useEffect(() => {
    const t = templates.find((t) => t.id === activeTemplateId);
    if (!t) return;
    const visible = getVisibleCategories(t.categoryLabels);
    if (visible.length > 0 && !visible.includes(activeCategory)) {
      dispatch({ type: 'SET_CATEGORY', payload: visible[0] });
    }
  }, [activeTemplateId]);

  /**
   * 详情遮罩：不用 antd 自带的 mask 动画。
   *
   * 实测 antd 的 mask 要等 Modal 挂载后再过 ~200ms 才开始变暗，而海报 120ms 就起飞了，
   * 结果是「海报在亮着的网格上飞 → 飞了一半背景突然变黑」，眼睛会觉得闪。
   * 这里在 detailOpen 变化的同一轮就切换 body 上的类，自定义遮罩从 0 开始稳定淡入，
   * antd 的 mask 只保留点击关闭的交互（视觉上透明）。
   */
  useEffect(() => {
    document.body.classList.toggle('detail-mask-on', detailOpen);
    return () => { document.body.classList.remove('detail-mask-on'); };
  }, [detailOpen]);

  // FLIP 过渡：Modal 打开后捕获详情海报位置
  useEffect(() => {
    if (!flipState || flipState.endRect || !detailOpen) return;
    // 安全兜底：捕获失败时别让 Modal 海报永久隐藏
    const safety = setTimeout(() => {
      setFlipState((prev) => prev && !prev.endRect ? null : prev);
    }, 1200);

    /**
     * 用两帧 rAF 代替 setTimeout(50)。
     *
     * 点击到海报起飞之间原本有 ~120ms 的静止空窗（实测遮罩和副本都还没动），
     * 手感像"点了一下没反应，然后画面突然变暗"。Modal 的 DOM 在第一帧就挂好了，
     * 第二帧就能量到最终位置，没必要等 50ms 定时器。
     */
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const modalImg = document.querySelector(
          '[data-modal-poster="true"]'
        ) as HTMLElement | null;
        if (!modalImg) return;
        const endRect = modalImg.getBoundingClientRect();
        if (endRect.width > 0 && endRect.height > 0) {
          const endObjPos = getComputedStyle(modalImg).objectPosition || '50% 50%';
          setFlipState((prev) => prev ? { ...prev, endRect, endObjPos } : null);
        } else {
          // 极少数情况下图片还没布局完，再等一帧重试一次
          requestAnimationFrame(() => {
            const retry = modalImg.getBoundingClientRect();
            if (retry.width > 0) {
              const endObjPos = getComputedStyle(modalImg).objectPosition || '50% 50%';
              setFlipState((prev) => prev ? { ...prev, endRect: retry, endObjPos } : null);
            }
          });
        }
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      clearTimeout(safety);
    };
  }, [flipState, detailOpen]);

  /**
   * 详情面板的键盘导航：← / → 切上一部 / 下一部。
   *
   * 面板右上角本来就有 ‹ › 按钮，但只能点。连续评十几部番的时候，
   * 手在鼠标和键盘之间来回切很断节奏 —— 这对「一本正经地刷番评分」是高频动作。
   * 顺序跟随网格（filteredAnime），和 ‹ › 按钮完全一致。
   *
   * 输入框/文本域里按方向键是移动光标，必须让路。
   */
  useEffect(() => {
    if (!detailOpen || !selectedAnime) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;
      const idx = filteredAnime.findIndex((a) => a.id === selectedAnime.id);
      if (idx < 0) return;
      const next = filteredAnime[idx + (e.key === 'ArrowRight' ? 1 : -1)];
      if (!next) return; // 到头了就安静地什么都不做，别把网格滚走
      e.preventDefault();
      dispatch({ type: 'OPEN_MODAL', modal: 'detail', anime: next });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [detailOpen, selectedAnime, filteredAnime, dispatch]);

  if (loading) {
    return (
      <div className="app-boot">
        <div className="app-boot-mark">
          <AppIcon name="anime" size={34} />
          <span className="app-boot-ring" />
        </div>
        <div className="app-boot-text">正在读取番剧数据…</div>
        <div className="app-boot-bar"><span /></div>
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
    <>
      {/* 桌面版自定义标题栏；浏览器里 TitleBar 自身不渲染 */}
      <TitleBar />
      {/* 热更新下载完成后的全局提示（浏览器里不渲染任何东西） */}
      <UpdateToast />
      <Layout className="app-layout">
      <Sider
        width={300}
        collapsedWidth={0}
        collapsed={sidebarCollapsed}
        onMouseEnter={() => setSidebarCollapsed(false)}
        className="app-sidebar"
      >
        {/*
          始终渲染完整内容，让宽度动画去裁剪它。
          之前传 collapsed，收起瞬间内容会切成一个小方块，300ms 的收窄动画里
          先"闪没"再缩，观感很跳；固定 300px 宽 + 折叠时淡出才连贯。
        */}
        <Sidebar onOpenSettings={() => setSettingsOpen(true)} />
      </Sider>

      {/* 侧栏已改成绝对定位浮层（App.css .app-sidebar），展开时不再挤压网格，
          所以这里不再需要 with-sidebar 标记去收缩顶栏 */}
      <Layout className="main-layout">
        <Content className={`main-content${batchMode ? ' with-batch-bar' : ''}`}>
          <TopBar
            onExpandSidebar={() => setSidebarCollapsed(false)}
            onQuickAction={handleQuickAction}
            onOpenSettings={() => setSettingsOpen(true)}
            activeCategory={activeCategory}
            onCategoryChange={(c) => dispatch({ type: 'SET_CATEGORY', payload: c })}
            searchText={searchText}
            onSearchChange={(t) => dispatch({ type: 'SET_SEARCH_TEXT', payload: t })}
            searchMode={searchMode}
            onSearchModeChange={(m) => dispatch({ type: 'SET_SEARCH_MODE', payload: m })}
            onAddAnime={() => dispatch({ type: 'OPEN_MODAL', modal: 'search' })}
            onCompleteData={() => setMediaCompleteOpen(true)}
            onCompleteCharacters={() => setCharacterCompleteOpen(true)}
            onCutoutCharacters={() => setCharacterCutoutOpen(true)}
            templates={templates}
            activeTemplateId={activeTemplateId}
            onTemplateChange={(id: string) => dispatch({ type: 'SET_ACTIVE_TEMPLATE', payload: id })}
            categoryLabels={activeTemplateCategoryLabels}
          />

          {(sortByDim || activeTag) && (
            <div className="filter-strip">
              {sortByDim && (
                <>
                  <span>按 <span style={{ color: 'var(--brand-primary)' }}>{sortByDim === 'namesort' ? '番名' : sortByDim === 'bgm' ? 'BGM' : sortByDim === 'watchDate' ? '观看时间' : sortByDim}</span> 排序</span>
                  <span style={{ color: 'var(--text-muted)' }}>{sortByDim === 'watchDate' ? (sortOrder === 'desc' ? '↓新到旧' : '↑旧到新') : (sortOrder === 'desc' ? '↓高到低' : '↑低到高')}</span>
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
            scoreFocus={state.scoreFocus}
          />

          {batchMode && (
            <div className="batch-bar">
              <span>🏷️ <b>{selectedBatchTags.length}</b> 个标签</span>
              <span className="batch-bar-arrow">→</span>
              <span>🎬 <b>{selectedBatchAnime.length}</b> 部番剧</span>
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
        onDelete={(animeId) => {
          // 移除后立刻关面板，否则会停在一个已经不存在的条目上
          handleDeleteFromWatching(animeId);
          dispatch({ type: 'CLOSE_MODAL', modal: 'detail' });
        }}
        onAddAnime={handleAddAnime}
        allAnime={state.animeList}
        // 上/下一张跟随网格的显示顺序（排序/筛选后），而不是 Excel 原始行序
        navList={filteredAnime}
        imgHeight={imgHeight}
        radarMode={radarMode}
        radarMin={radarMin}
        contentHidden={flipState !== null && !flipState.endRect && detailOpen}
        // 只要还有 FLIP 副本在场，详情里的海报就保持隐藏 —— 关闭时若按 detailOpen
        // 判断会提前露出来，和正在飞回网格的副本叠成两张
        posterHidden={flipState !== null}
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

      <MediaCompleteModal
        open={mediaCompleteOpen}
        onClose={() => setMediaCompleteOpen(false)}
        animeList={state.animeList}
        activeTemplateId={activeTemplateId}
        templates={templates}
        // 用静默刷新而不是 fetchData：后者会把全局 loading 置 true，
        // 导致 App 提前 return 整屏 spinner、把本面板连 state 一起卸载掉，
        // 用户就再也看不到「已写入 N 条」的结果了。
        onApplied={refreshAnimeList}
      />

      <CharacterCompleteModal
        open={characterCompleteOpen}
        onClose={() => setCharacterCompleteOpen(false)}
        animeList={state.animeList}
        activeTemplateId={activeTemplateId}
        templates={templates}
        // 同 MediaCompleteModal：必须用静默刷新，否则全局 loading 会把本面板卸载掉
        onApplied={refreshAnimeList}
      />

      <CharacterCutoutModal
        open={characterCutoutOpen}
        onClose={() => setCharacterCutoutOpen(false)}
        animeList={state.animeList}
      />
      <TemplateManager
        open={templateManagerOpen}
        onClose={() => dispatch({ type: 'CLOSE_MODAL', modal: 'templateManager' })}
      />

      {/* 全应用设置：以前铺在侧栏底部（滚 3 屏才够得着），现在收进分页弹窗 */}
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      {/* 快捷栏「录制 GIF」：独立打开录制面板，不依赖某部番的图片管理 */}
      {gifRecorderOpen && (
        <ScreenCapture
          animeTitle="快捷截图"
          initialMode="record"
          onClose={() => setGifRecorderOpen(false)}
        />
      )}

      {/* 表格视图：应用内直接看 / 改列表原始数据 */}
      <ExcelEditor
        open={excelOpen}
        onClose={() => dispatch({ type: 'CLOSE_MODAL', modal: 'excel' })}
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

      <BackupHistoryModal
        open={backupHistoryOpen}
        onClose={() => dispatch({ type: 'CLOSE_MODAL', modal: 'backupHistory' })}
        onRestored={refreshAnimeList}
      />

      {/* AI 对话抽屉：贴在右侧、可拖拽调宽，不遮挡网格布局 */}
      <AIChatDrawer
        open={aiChatOpen}
        onClose={() => dispatch({ type: 'CLOSE_MODAL', modal: 'aiChat' })}
        animeList={state.animeList}
        onOpenSettings={() => dispatch({ type: 'OPEN_MODAL', modal: 'aiSettings' })}
      />

      <BatchTagModal
        open={batchTagOpen}
        onClose={() => dispatch({ type: 'CLOSE_MODAL', modal: 'batchTag' })}
        animeList={state.animeList}
        templateId={activeTemplateId}
        onApplied={refreshAnimeList}
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
    </>
  );
};

export default App;
