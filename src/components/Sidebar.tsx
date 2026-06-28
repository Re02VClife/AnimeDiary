import { useState, useMemo, useCallback } from 'react';
import { Segmented, Slider, Input, InputNumber, Button, Popconfirm, Switch, Modal, ColorPicker } from 'antd';
import { PlusOutlined, EditOutlined, CloseOutlined } from '@ant-design/icons';
import type { AnimeEntry, Dimension } from '../types';
import { getTemplate } from '../../features/anime-data/template-service';
import { rankByDimension } from '../../features/ranking/ranking-service';
import WatchTimeline from '../../features/watch-calendar/WatchCalendar';
import { useAnimeContext } from '../../context/AnimeContext';
import { catgirlMessage } from '../theme';
import { useTheme } from '../theme/ThemeContext';
import AppIcon from '../theme/AppIcon';
import type { ThemeColors } from '../theme/types';

interface SidebarProps {
  collapsed?: boolean;
}

/** Tag 预设存储 key */
const TAG_PRESETS_KEY = 'anime_diary_tag_presets';

function loadTagPresets(): string[] {
  try {
    const raw = localStorage.getItem(TAG_PRESETS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveTagPresets(presets: string[]): void {
  localStorage.setItem(TAG_PRESETS_KEY, JSON.stringify(presets));
}

/** 伪维度：BGM / 番名 */
const BGM_DIM: Dimension = { key: 'bgm', label: 'BGM评分', description: 'Bangumi 评分', weight: 0 };
const NAME_DIM: Dimension = { key: 'namesort', label: '番名', description: '按番剧名称排序', weight: 0 };

const Sidebar: React.FC<SidebarProps> = ({ collapsed = false }) => {
  const { state, dispatch, handleDimensionRank, handleAnimeClick, handleRenameTag,
    handleDeleteTag, handleBatchAddTags, handleCancelBatch, handleExportUserData,
    handleImportUserData, handleFixSearchAlias, handleOpenExcel, handleBatchSavePosters,
    handleImportExcel, handleExportExcel } = useAnimeContext();
  const { animeList, activeDim, imgHeight, radarMode, radarMin, activeTag, batchMode, selectedBatchTags, activeTemplateId } = state;

  // 当前模板的维度
  const activeDims = useMemo(() => {
    return getTemplate(activeTemplateId).dimensions;
  }, [activeTemplateId]);

  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [showCalendar, setShowCalendar] = useState(true);
  const [showRanking, setShowRanking] = useState(true);
  const [showTags, setShowTags] = useState(true);
  const [tagEditMode, setTagEditMode] = useState(false); // Tag 编辑模式开关
  const [showGraph, setShowGraph] = useState(false); // 知识图谱折叠
  const [showAI, setShowAI] = useState(false); // AI 分析折叠

  // Tag 编辑状态
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [newTagName, setNewTagName] = useState('');
  const [tagPresets, setTagPresets] = useState<string[]>(() => loadTagPresets());

  // ── 主题状态 ──
  const { state: themeState, colors, setThemeMode, toggleCatgirlMode, setCustomColors, resetCustomColors } = useTheme();
  const [themeEditorOpen, setThemeEditorOpen] = useState(false);
  const [editingColors, setEditingColors] = useState<Partial<ThemeColors>>({});

  // ── Tag 统计：收集全部标签（含预设），按使用次数排序 ──
  const tagStats = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const a of animeList) {
      for (const t of a.tags) {
        counts[t.name] = (counts[t.name] || 0) + 1;
      }
    }
    // 合并预设标签（未在番剧中出现的计数为 0）
    for (const preset of tagPresets) {
      if (!(preset in counts)) counts[preset] = 0;
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'));
  }, [animeList, tagPresets]);

  // 开始重命名
  const startRename = useCallback((name: string) => {
    setEditingTag(name);
    setEditValue(name);
  }, []);

  // 确认重命名
  const confirmRename = useCallback(() => {
    const newName = editValue.trim();
    if (!newName || !editingTag || newName === editingTag) {
      setEditingTag(null);
      return;
    }
    handleRenameTag(editingTag, newName);
    // 同步更新预设列表
    const updated = tagPresets.map((p) => p === editingTag ? newName : p);
    setTagPresets(updated);
    saveTagPresets(updated);
    setEditingTag(null);
    catgirlMessage.success(`已重命名「${editingTag}」→「${newName}」`);
  }, [editingTag, editValue, tagPresets, handleRenameTag]);

  // 删除标签
  const confirmDelete = useCallback((name: string) => {
    handleDeleteTag(name);
    // 同步从预设列表移除
    const updated = tagPresets.filter((p) => p !== name);
    setTagPresets(updated);
    saveTagPresets(updated);
  }, [tagPresets, handleDeleteTag]);

  // 新增预设标签
  const addTagPreset = useCallback(() => {
    const name = newTagName.trim();
    if (!name) return;
    if (tagPresets.includes(name)) { catgirlMessage.warning('标签已存在'); return; }
    const updated = [...tagPresets, name];
    setTagPresets(updated);
    saveTagPresets(updated);
    setNewTagName('');
    catgirlMessage.success(`已添加标签「${name}」`);
  }, [newTagName, tagPresets]);

  // 按当前模板筛选后的条目列表（未选模板=全部，已选=仅该模板）
  const templateFiltered = useMemo(() => {
    if (!activeTemplateId) return animeList;
    return animeList.filter((a) =>
      activeTemplateId === 'default'
        ? (!a.templateId || a.templateId === 'default')
        : a.templateId === activeTemplateId,
    );
  }, [animeList, activeTemplateId]);

  /** 动态计算条目的加权总评（根据条目自身模板的维度和权重） */
  const calcOverall = useCallback((entry: AnimeEntry): number => {
    const allDims = getTemplate(entry.templateId).dimensions
      .filter((d) => d.key !== 'overall');
    if (allDims.length === 0) return 0;
    const hasWeights = allDims.some((d) => d.weight > 0);
    const effectiveDims = hasWeights
      ? allDims.filter((d) => d.weight > 0)
      : allDims.map((d) => ({ ...d, weight: 1 / allDims.length }));
    let tw = 0, ws = 0;
    for (const d of effectiveDims) {
      const s = entry.scores.find((sc) => sc.dimensionKey === d.key)?.score ?? 0;
      if (s > 0) { ws += s * d.weight; tw += d.weight; }
    }
    return tw > 0 ? ws / tw : 0;
  }, []);

  // 按当前维度排序（仅含当前模板类型的条目）
  const allRanked = useMemo(() => {
    if (!activeDim) return [];
    if (activeDim === 'overall') {
      return [...templateFiltered]
        .map((a) => ({ entry: a, overall: calcOverall(a) }))
        .filter((x) => x.overall > 0)
        .sort((a, b) => b.overall - a.overall)
        .map((x) => x.entry);
    }
    if (activeDim === 'bgm') {
      return [...templateFiltered]
        .filter((a) => a.bangumiScore && a.bangumiScore > 0)
        .sort((a, b) => (b.bangumiScore || 0) - (a.bangumiScore || 0));
    }
    if (activeDim === 'namesort') {
      return [...templateFiltered].sort((a, b) => a.title.localeCompare(b.title, 'zh'));
    }
    return rankByDimension(templateFiltered, activeDim);
  }, [templateFiltered, activeDim, calcOverall]);

  const dimLabel = (key: string) =>
    activeDims.find((d) => d.key === key)?.label || key;

  // 收起状态：仅显示纵向 Logo 提示
  if (collapsed) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12,
        paddingTop: 16, height: '100%',
      }}>
        <AppIcon name="anime" size={20} style={{ opacity: 0.6 }} />
        <div style={{
          writingMode: 'vertical-rl', fontSize: 11, color: 'var(--text-muted)',
          letterSpacing: 4, userSelect: 'none',
        }}>
          番剧日记
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* ── 时间轴 ── */}
      <div className="sidebar-section">
        <div
          className="section-title"
          onClick={() => setShowCalendar(!showCalendar)}
          style={{ cursor: 'pointer', userSelect: 'none' }}
        >
          {showCalendar ? '▼' : '▶'} 时间轴
        </div>
        {showCalendar && (
          <WatchTimeline animeList={animeList} onAnimeClick={handleAnimeClick} />
        )}
      </div>

      {/* ── 维度排序 ── */}
      <div className="sidebar-section">
        <div
          className="section-title"
          onClick={() => setShowRanking(!showRanking)}
          style={{ cursor: 'pointer', userSelect: 'none' }}
        >
          {showRanking ? '▼' : '▶'} 维度排序
        </div>
        {showRanking && (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
              {[...activeDims, ...(activeTemplateId === 'default' ? [BGM_DIM, NAME_DIM] : [])].map((dim: Dimension) => (
                <div
                  key={dim.key}
                  className={`dimension-chip${activeDim === dim.key ? ' active' : ''}`}
                  onClick={() => {
                    dispatch({ type: 'SET_ACTIVE_DIM', payload: dim.key });
                    setSortDir('desc');
                    handleDimensionRank(dim.key, 'desc');
                  }}
                  title={dim.description}
                >
                  {dim.label}
                </div>
              ))}
            </div>

            {/* 正倒序切换 */}
            <div style={{ marginBottom: 6, display: 'flex', justifyContent: 'flex-end' }}>
              <Segmented
                size="small"
                value={sortDir}
                onChange={(v) => {
                  setSortDir(v as 'asc' | 'desc');
                  handleDimensionRank(activeDim, v as 'asc' | 'desc');
                }}
                options={[
                  { value: 'desc', label: '↓高到低' },
                  { value: 'asc', label: '↑低到高' },
                ]}
              />
            </div>

            {/* 排名列表（可滚动全量） */}
            <div style={{
              display: 'flex', flexDirection: 'column', gap: 2,
              maxHeight: 500, overflowY: 'auto',
            }}>
              {(sortDir === 'desc' ? allRanked : [...allRanked].reverse()).map((anime, idx) => {
                const score = anime.scores.find((s) => s.dimensionKey === activeDim);
                const rank = sortDir === 'desc' ? idx + 1 : allRanked.length - idx;
                return (
                  <div
                    key={anime.id}
                    onClick={() => handleAnimeClick(anime)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '4px 8px', borderRadius: 4, cursor: 'pointer',
                      background: rank <= 3 ? 'rgba(251,114,153,0.06)' : 'transparent',
                      border: rank <= 3 ? '1px solid rgba(251,114,153,0.15)' : '1px solid transparent',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = rank <= 3 ? 'rgba(251,114,153,0.06)' : 'transparent'; }}
                  >
                    <span style={{
                      fontSize: 11, fontWeight: 700,
                      color: rank <= 3 ? 'var(--brand-primary)' : 'var(--text-muted)',
                      minWidth: 16, textAlign: 'center',
                    }}>
                      {rank}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {anime.title}
                      </div>
                    </div>
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--brand-primary)' }}>
                      {activeDim === 'namesort' ? '' :
                       activeDim === 'overall'
                        ? calcOverall(anime).toFixed(2)
                        : activeDim === 'bgm'
                          ? (anime.bangumiScore?.toFixed(1) || '-')
                          : (score?.score?.toFixed(activeDim === 'vibe' ? 2 : 1) || '-')}
                    </span>
                  </div>
                );
              })}
              {allRanked.length === 0 && (
                <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: 12 }}>
                  暂无 {dimLabel(activeDim)} 维度数据
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* ── Tag 管理 ── */}
      <div className="sidebar-section">
        <div
          className="section-title"
          onClick={() => setShowTags(!showTags)}
          style={{ cursor: 'pointer', userSelect: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
        >
          <span>
            {showTags ? '▼' : '▶'} 🏷️ Tag 管理
            {activeTag && (
              <span
                style={{ fontSize: 11, color: 'var(--text-secondary)', fontWeight: 400, marginLeft: 4 }}
                onClick={(e) => { e.stopPropagation(); dispatch({ type: 'SET_ACTIVE_TAG', payload: null }); }}
              >
                (已选: {activeTag} ✕)
              </span>
            )}
          </span>
          <span style={{ display: 'flex', gap: 2 }}>
            {batchMode ? (
              <>
                <Button size="small" type="primary"
                  onClick={(e) => { e.stopPropagation(); handleBatchAddTags(); }}
                  style={{ fontSize: 11, height: 22, padding: '0 8px' }}
                  disabled={!selectedBatchTags?.length}
                >
                  确认
                </Button>
                <Button size="small"
                  onClick={(e) => { e.stopPropagation(); handleCancelBatch(); }}
                  style={{ fontSize: 11, height: 22, padding: '0 6px' }}
                >
                  取消
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="small" type="text"
                  onClick={(e) => { e.stopPropagation(); dispatch({ type: 'SET_BATCH_MODE', payload: true }); }}
                  style={{ fontSize: 11, height: 22, padding: '0 6px', color: 'var(--text-secondary)' }}
                  title="批量添加标签到番剧"
                >
                  批量添加
                </Button>
                <Button
                  size="small" type="text"
                  icon={<EditOutlined style={{ fontSize: 12 }} />}
                  onClick={(e) => { e.stopPropagation(); setTagEditMode(!tagEditMode); }}
                  style={{
                    color: tagEditMode ? 'var(--brand-primary)' : 'var(--text-muted)',
                    width: 24, height: 24, minWidth: 24, padding: 0,
                  }}
                  title={tagEditMode ? '退出编辑' : '编辑标签'}
                />
              </>
            )}
          </span>
        </div>
        {showTags && (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, maxHeight: 200, overflowY: 'auto', marginBottom: 8 }}>
              {tagStats.length === 0 && !newTagName ? (
                <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', width: '100%', padding: 12 }}>
                  暂无标签数据
                </div>
              ) : (
                tagStats.map(([name, count]) => (
                  <div
                    key={name}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 2,
                      padding: '2px 4px 2px 10px', borderRadius: 12, fontSize: 12,
                      background: activeTag === name ? 'rgba(251,114,153,0.2)' : 'var(--bg-quaternary)',
                      border: `1px solid ${activeTag === name ? 'var(--brand-primary)' : 'var(--border-primary)'}`,
                      color: activeTag === name ? 'var(--brand-primary)' : 'var(--text-secondary)',
                    }}
                  >
                    {/* 编辑模式 → 输入框 */}
                    {editingTag === name ? (
                      <Input
                        size="small"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onPressEnter={confirmRename}
                        onBlur={confirmRename}
                        autoFocus
                        style={{
                          width: 70, height: 20, fontSize: 11,
                          background: 'var(--bg-primary)', borderColor: 'var(--brand-primary)', color: 'var(--text-primary)',
                        }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <span
                        onClick={() => {
                          if (batchMode) {
                            // 批量模式：切换标签选中
                            const sel = selectedBatchTags || [];
                            dispatch({
                              type: 'SET_BATCH_TAGS',
                              payload: sel.includes(name) ? sel.filter((t) => t !== name) : [...sel, name],
                            });
                          } else {
                            dispatch({ type: 'SET_ACTIVE_TAG', payload: activeTag === name ? null : name });
                          }
                        }}
                        style={{ cursor: 'pointer' }}
                        title={batchMode ? `勾选「${name}」以批量添加` : `${name}（${count} 部番剧）`}
                      >
                        {/* 批量模式下的勾选标记 */}
                        {batchMode && (
                          <span style={{
                            display: 'inline-block', width: 14, height: 14, lineHeight: '14px',
                            borderRadius: 3, marginRight: 2, fontSize: 10, textAlign: 'center',
                            background: selectedBatchTags?.includes(name) ? 'var(--brand-primary)' : 'var(--border-primary)',
                            color: '#fff', verticalAlign: 'middle',
                          }}>
                            {selectedBatchTags?.includes(name) ? '✓' : ''}
                          </span>
                        )}
                        {name}
                        {count > 0 && <span style={{ fontSize: 10, opacity: 0.5, marginLeft: 2 }}>{count}</span>}
                      </span>
                    )}
                    {/* 操作按钮（仅在编辑模式下显示） */}
                    {tagEditMode && (
                      <span style={{ display: 'flex', gap: 1, marginLeft: 2 }}>
                        <Button
                          size="small" type="text"
                          icon={<EditOutlined style={{ fontSize: 10 }} />}
                          onClick={(e) => { e.stopPropagation(); startRename(name); }}
                          style={{ width: 18, height: 18, minWidth: 18, padding: 0, color: 'var(--text-muted)' }}
                          title="重命名"
                        />
                        <Popconfirm
                          title="全局删除"
                          description={`从全部番剧中删除「${name}」？`}
                          onConfirm={(e) => { e?.stopPropagation(); confirmDelete(name); }}
                          onCancel={(e) => e?.stopPropagation()}
                          okText="删除" cancelText="取消"
                          placement="bottom"
                        >
                          <Button
                            size="small" type="text" danger
                            icon={<CloseOutlined style={{ fontSize: 10 }} />}
                            onClick={(e) => e.stopPropagation()}
                            style={{ width: 18, height: 18, minWidth: 18, padding: 0 }}
                            title="删除"
                          />
                        </Popconfirm>
                      </span>
                    )}
                  </div>
                ))
              )}
            </div>
            {/* 新增预设标签（仅在编辑模式下显示） */}
            {tagEditMode && (
            <div style={{ display: 'flex', gap: 4 }}>
              <Input
                size="small"
                placeholder="新增标签…"
                value={newTagName}
                onChange={(e) => setNewTagName(e.target.value)}
                onPressEnter={addTagPreset}
                style={{
                  flex: 1, height: 26, fontSize: 12,
                  background: 'var(--bg-primary)', borderColor: 'var(--border-primary)', color: 'var(--text-primary)',
                }}
              />
              <Button size="small" type="primary" icon={<PlusOutlined />}
                onClick={addTagPreset} style={{ height: 26 }} />
            </div>
            )}
          </>
        )}
      </div>

      {/* ── 知识图谱 ── */}
      <div className="sidebar-section">
        <div
          className="section-title"
          onClick={() => setShowGraph(!showGraph)}
          style={{ cursor: 'pointer', userSelect: 'none' }}
        >
          {showGraph ? '▼' : '▶'} 🔗 知识图谱
        </div>
        {showGraph && (
          <div style={{ padding: '4px 0' }}>
            <div
              onClick={() => dispatch({ type: 'OPEN_MODAL', modal: 'knowledgeGraph' })}
              style={{
                height: 160,
                background: 'var(--bg-secondary)',
                borderRadius: 8,
                border: '1px solid #30363d',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                transition: 'border-color 0.2s, background 0.2s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'var(--brand-primary)';
                e.currentTarget.style.background = 'var(--bg-tertiary)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'var(--border-primary)';
                e.currentTarget.style.background = 'var(--bg-secondary)';
              }}
            >
              <div style={{ fontSize: 28, marginBottom: 4, opacity: 0.6 }}>🕸️</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 2 }}>
                番剧关系网络
              </div>
              <div
                style={{
                  fontSize: 10,
                  color: 'var(--brand-primary)',
                  background: 'rgba(251,114,153,0.1)',
                  padding: '2px 10px',
                  borderRadius: 10,
                  border: '1px solid rgba(251,114,153,0.2)',
                }}
              >
                全屏查看
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── AI 分析 ── */}
      {/* ── AI 分析（始终显示）── */}
      <div className="sidebar-section">
        <div
          className="section-title"
          onClick={() => setShowAI(!showAI)}
          style={{ cursor: 'pointer', userSelect: 'none' }}
        >
          {showAI ? '▼' : '▶'} 🤖 AI 分析
        </div>
        {showAI && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div
              className="settings-item"
              onClick={() => dispatch({ type: 'OPEN_MODAL', modal: 'tasteReport' })}
              style={{
                background: 'linear-gradient(135deg, rgba(251,114,153,0.1), rgba(251,114,153,0.02))',
                border: '1px solid rgba(251,114,153,0.15)',
                borderRadius: 8,
                padding: '10px 14px',
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--brand-primary)' }}>
                📊 品味分析
              </span>
              <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 'auto' }}>
                ~¥0.002
              </span>
            </div>
            <div
              className="settings-item"
              onClick={() => dispatch({ type: 'OPEN_MODAL', modal: 'aiSettings' })}
            >
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>⚙️ AI 设置</span>
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', padding: '2px 0' }}>
              基于评分数据生成品味报告和偏好画像。需要配置 API Key。
            </div>
          </div>
        )}
      </div>

      {/* ── 主题 ── */}
      <div className="sidebar-section">
        <div className="section-title"><AppIcon name="theme" size={14} /> 主题</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* 深色/浅色切换 */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>模式</span>
            <Segmented
              size="small"
              value={themeState.themeMode}
              onChange={(v) => setThemeMode(v as 'dark' | 'light')}
              options={[
                { value: 'dark', label: '🌙 深色' },
                { value: 'light', label: '☀️ 浅色' },
              ]}
              style={{ background: 'var(--bg-quaternary)' }}
            />
          </div>

          {/* 猫娘模式 */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>🐱 猫娘模式</span>
            <Switch
              size="small"
              checked={themeState.catgirlMode}
              onChange={toggleCatgirlMode}
            />
          </div>

          {/* 自定义配色 */}
          <Button
            size="small"
            block
            style={{ borderRadius: 6, fontSize: 12 }}
            onClick={() => {
              setEditingColors({ ...themeState.customColors });
              setThemeEditorOpen(true);
            }}
          >
            🎨 自定义配色
          </Button>

          {/* 当有自定义颜色时显示重置按钮 */}
          {Object.keys(themeState.customColors).length > 0 && (
            <Button
              size="small"
              block
              danger
              style={{ borderRadius: 6, fontSize: 12 }}
              onClick={resetCustomColors}
            >
              恢复预设配色
            </Button>
          )}
        </div>
      </div>

      {/* 自定义配色编辑器 Modal */}
      <Modal
        title="🎨 自定义配色"
        open={themeEditorOpen}
        onCancel={() => setThemeEditorOpen(false)}
        onOk={() => {
          setCustomColors(editingColors);
          setThemeEditorOpen(false);
        }}
        okText="应用"
        cancelText="取消"
        width={420}
      >
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px', maxHeight: 400, overflow: 'auto' }}>
          {(Object.keys(colors) as (keyof ThemeColors)[]).map((key) => (
            <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 11, color: 'var(--text-secondary)', flex: 1 }}>{key}</span>
              <ColorPicker
                size="small"
                value={editingColors[key] ?? colors[key]}
                onChange={(_, hex) => {
                  setEditingColors((prev) => ({ ...prev, [key]: hex }));
                }}
              />
            </div>
          ))}
        </div>
      </Modal>

      {/* ── 设置 ── */}
      <div className="sidebar-section">
        <div className="section-title"><AppIcon name="settings" size={14} /> 设置</div>
        <div className="settings-list">
          <div className="settings-item" onClick={handleImportExcel}>
            <span>📤 导入 Excel</span>
          </div>
          <div className="settings-item" onClick={handleExportExcel}>
            <span>📥 导出 Excel</span>
          </div>
          <div className="settings-item" onClick={handleOpenExcel}>
            <span>📋 查看 Excel</span>
          </div>
          <div className="settings-item" onClick={handleBatchSavePosters}>
            <span>🖼 持久化所有海报</span>
          </div>
          <div className="settings-item" onClick={handleExportUserData}>
            <span>💾 导出用户数据</span>
          </div>
          <div
            className="settings-item"
            onClick={() => {
              const input = document.createElement('input');
              input.type = 'file';
              input.accept = '.zip';
              input.onchange = (e) => {
                const file = (e.target as HTMLInputElement).files?.[0];
                if (file) handleImportUserData(file);
              };
              input.click();
            }}
          >
            <span>📂 导入用户数据</span>
          </div>
          <div className="settings-item" onClick={handleFixSearchAlias}>
            <span>🔄 修正检索名</span>
          </div>
          <div className="settings-item" onClick={() => dispatch({ type: 'OPEN_MODAL', modal: 'templateManager' })}>
            <span>📐 维度管理</span>
          </div>
          <div style={{ padding: '6px 10px' }}>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 2 }}>
              🖼️ 图片高度: {imgHeight}px
            </div>
            <Slider
              min={200} max={800} step={20}
              value={imgHeight}
              onChange={(v) => dispatch({ type: 'SET_IMG_HEIGHT', payload: v })}
              styles={{ track: { background: 'var(--brand-primary)' }, rail: { background: 'var(--border-primary)' } }}
            />
          </div>

          {/* ── 雷达图设置 ── */}
          <div style={{ padding: '6px 10px' }}>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>
              📊 雷达图范围
            </div>
            <Segmented
              size="small"
              value={radarMode}
              onChange={(v) => dispatch({ type: 'SET_RADAR_MODE', payload: v as 'percentile' | 'fixed' })}
              options={[
                { value: 'percentile', label: '百分比' },
                { value: 'fixed', label: '固定值' },
              ]}
              block
              style={{ marginBottom: 6 }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 11, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>最小值</span>
              <InputNumber
                size="small"
                min={0}
                max={radarMode === 'percentile' ? 50 : 7}
                step={1}
                value={radarMin}
                onChange={(v) => dispatch({ type: 'SET_RADAR_MIN', payload: v ?? 0 })}
                style={{ width: 70 }}
              />
              <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                {radarMode === 'percentile' ? '(0-50%)' : '(0-7分)'}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Sidebar;
