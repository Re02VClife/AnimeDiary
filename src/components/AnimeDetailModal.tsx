import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Modal, InputNumber, Input, Tag, Descriptions, Button, Space, message, Tooltip, Select, Popover, Image, Typography, Checkbox } from 'antd';
import { SaveOutlined, PlusOutlined, EditOutlined, LeftOutlined, RightOutlined, PictureOutlined, ImportOutlined, ThunderboltOutlined, TagOutlined, SearchOutlined } from '@ant-design/icons';
import type { AnimeEntry, AnimeTag, DimensionScore, DimensionReview, AnimeCategory, BangumiSearchItem } from '../types';
import { DEFAULT_DIMENSIONS, DIMENSION_LABEL_MAP, CATEGORY_CONFIG } from '../types';
import { fetchPoster, savePosterUrlToExcel } from '../services/excelService';
import { loadImages, saveImage as saveImageToLocal } from '../services/imageService';
import { addToPosterBlacklist, loadPosterBlacklist, savePosterOverride, loadPosterPositions, savePosterPosition } from '../services/storageService';
import { singleAnimeAnalysis, autoTag } from '../services/aiSkills';
import type { SingleAnimeAnalysisResult, AutoTagResult } from '../services/aiSkills';
import { hasAIConfig } from '../services/aiConfig';
import RadarChart from './RadarChart';
import ImageManager from './ImageManager';

const { TextArea } = Input;
const { Paragraph } = Typography;

interface AnimeDetailModalProps {
  anime: AnimeEntry | null;
  open: boolean;
  onClose: () => void;
  onSave: (entry: AnimeEntry) => Promise<void>;
  onNavigate?: (anime: AnimeEntry) => void;
  allAnime?: AnimeEntry[];
  onPosterChange?: (animeId: string, posterUrl: string) => void;
  imgHeight?: number;
}

// ═══════════════════════════════════════════════════
// 拖拽滑条子组件
// ═══════════════════════════════════════════════════

interface ScoreSliderProps {
  dimKey: string;
  score: number;
  dimLabel: string;
  isVibe: boolean;
  onChange: (value: number) => void;
  onClose: () => void;
  sliderRef: React.RefObject<HTMLDivElement>;
}

const ScoreSlider: React.FC<ScoreSliderProps> = ({
  dimKey,
  score,
  dimLabel,
  isVibe,
  onChange,
  onClose,
  sliderRef,
}) => {
  const barRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [localScore, setLocalScore] = useState(score);

  // 同步外部 score 变化
  useEffect(() => { setLocalScore(score); }, [score]);

  // 点击外部关闭
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        sliderRef.current &&
        !sliderRef.current.contains(e.target as Node) &&
        !(e.target as HTMLElement).closest('.ant-input-number')
      ) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose, sliderRef]);

  // 键盘 Escape 关闭
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const step = isVibe ? 0.01 : 0.1;
  const precision = isVibe ? 2 : 1;

  /** 根据鼠标位置计算分数 */
  const calcScore = useCallback(
    (clientX: number) => {
      const bar = barRef.current;
      if (!bar) return localScore;
      const rect = bar.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const raw = pct * 10;
      const rounded = Math.round(raw / step) * step;
      return Math.max(0, Math.min(10, +rounded.toFixed(precision)));
    },
    [localScore, step, precision],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      const newScore = calcScore(e.clientX);
      setLocalScore(newScore);
      onChange(newScore);
    },
    [calcScore, onChange],
  );

  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const bar = barRef.current;
      if (!bar) return;
      const rect = bar.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const raw = pct * 10;
      const rounded = Math.round(raw / step) * step;
      const clamped = Math.max(0, Math.min(10, +rounded.toFixed(precision)));
      setLocalScore(clamped);
      onChange(clamped);
    };
    const handleUp = () => { dragging.current = false; };
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    return () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
    };
  }, [step, precision, onChange]);

  const pct = Math.min((localScore / 10) * 100, 100);

  return (
    <div
      ref={sliderRef}
      style={{
        marginTop: 8, padding: '10px 14px',
        background: '#161b22', borderRadius: 8,
        border: '1px solid rgba(251,114,153,0.2)',
        display: 'flex', alignItems: 'center', gap: 12,
      }}
    >
      {/* 维度标签 + 当前值 */}
      <span style={{ fontSize: 12, fontWeight: 600, color: '#e6edf3', minWidth: 36 }}>
        {dimLabel}
      </span>
      <span style={{
        fontSize: 14, fontWeight: 700, color: '#fb7299',
        minWidth: isVibe ? 48 : 36, textAlign: 'center', fontVariantNumeric: 'tabular-nums',
      }}>
        {localScore.toFixed(precision)}
      </span>

      {/* 拖拽进度条 */}
      <div
        ref={barRef}
        onMouseDown={handleMouseDown}
        style={{
          flex: 1, height: 20, borderRadius: 10,
          background: '#21262d', cursor: 'pointer',
          position: 'relative', overflow: 'visible',
          userSelect: 'none',
        }}
      >
        {/* 填充条 */}
        <div
          style={{
            position: 'absolute', left: 0, top: 0, height: '100%',
            width: `${pct}%`,
            background: 'linear-gradient(90deg, #fb7299, #e85d8a)',
            borderRadius: 10,
            transition: dragging.current ? 'none' : 'width 0.1s ease',
          }}
        />
        {/* 拖拽圆点 */}
        <div
          style={{
            position: 'absolute', left: `${pct}%`, top: '50%',
            transform: 'translate(-50%, -50%)',
            width: 16, height: 16, borderRadius: '50%',
            background: '#fff',
            border: '2px solid #fb7299',
            boxShadow: '0 0 6px rgba(251,114,153,0.4)',
            pointerEvents: 'none',
          }}
        />
        {/* 刻度标记 */}
        {[0, 2, 4, 6, 8, 10].map((m) => (
          <div
            key={m}
            style={{
              position: 'absolute', left: `${(m / 10) * 100}%`, top: '50%',
              transform: 'translate(-50%, -50%)',
              width: 2, height: 10, background: 'rgba(255,255,255,0.15)',
              borderRadius: 1, pointerEvents: 'none',
            }}
          />
        ))}
      </div>

      {/* 关闭按钮 */}
      <span
        onClick={onClose}
        style={{
          cursor: 'pointer', color: '#484f58', fontSize: 14,
          width: 20, textAlign: 'center', lineHeight: '20px',
        }}
        title="取消选中 (Esc)"
      >
        ✕
      </span>
    </div>
  );
};

const AnimeDetailModal: React.FC<AnimeDetailModalProps> = ({
  anime, open, onClose, onSave, onNavigate, allAnime = [], onPosterChange, imgHeight = 360,
}) => {
  const [scores, setScores] = useState<DimensionScore[]>([]);
  const [review, setReview] = useState('');
  const [tags, setTags] = useState<AnimeTag[]>([]);
  const [dimReviews, setDimReviews] = useState<DimensionReview[]>([]);
  const [category, setCategory] = useState<AnimeCategory>('watched');
  const [saving, setSaving] = useState(false);
  const [tagInput, setTagInput] = useState('');
  const [showTagPicker, setShowTagPicker] = useState(false);
  const [editingDimReview, setEditingDimReview] = useState<string | null>(null);
  const [editing, setEditing] = useState(false); // 编辑模式开关
  const [sliderDim, setSliderDim] = useState<string | null>(null);
  const sliderRef = useRef<HTMLDivElement>(null);

  // 编辑中的基本信息
  const [editTitle, setEditTitle] = useState('');
  const [editReleaseDate, setEditReleaseDate] = useState('');
  const [editWatchDate, setEditWatchDate] = useState('');
  const [editBgmScore, setEditBgmScore] = useState<number | undefined>();
  const [editAnilistScore, setEditAnilistScore] = useState<number | undefined>();
  const [editStudio, setEditStudio] = useState('');
  const [editFrameCount, setEditFrameCount] = useState<number | undefined>();
  const [editSearchAlias, setEditSearchAlias] = useState('');
  const [editBangumiId, setEditBangumiId] = useState<number | undefined>();
  const [posterUrl, setPosterUrl] = useState('');
  const [allImages, setAllImages] = useState<string[]>([]);
  const [slideIdx, setSlideIdx] = useState(0);
  const [imageManagerOpen, setImageManagerOpen] = useState(false);
  const [posX, setPosX] = useState(50); // 海报焦点 X (0-100)
  const [posY, setPosY] = useState(50); // 海报焦点 Y (0-100)
  const [dragging, setDragging] = useState(false);
  const [previewVisible, setPreviewVisible] = useState(false); // 原图预览
  const [savingPoster, setSavingPoster] = useState(false); // 保存封面中

  // ── 前后番剧导航 ──
  const navIndex = useMemo(() => {
    if (!anime) return -1;
    return allAnime.findIndex((a) => a.id === anime.id);
  }, [anime, allAnime]);

  const prevAnime = navIndex > 0 ? allAnime[navIndex - 1] : null;
  const nextAnime = navIndex >= 0 && navIndex < allAnime.length - 1 ? allAnime[navIndex + 1] : null;

  const handleNavigate = useCallback((target: AnimeEntry) => {
    onNavigate?.(target);
  }, [onNavigate]);

  // AI 深度分析状态
  const [aiAnalysisLoading, setAiAnalysisLoading] = useState(false);
  const [aiAnalysisResult, setAiAnalysisResult] = useState<SingleAnimeAnalysisResult | null>(null);
  const [aiAnalysisError, setAiAnalysisError] = useState<string | null>(null);

  // 智能打 Tag 状态
  const [autoTagLoading, setAutoTagLoading] = useState(false);
  const [autoTagResult, setAutoTagResult] = useState<AutoTagResult | null>(null);

  // 重新检索状态
  const [reSearching, setReSearching] = useState(false);
  const [reSearchResults, setReSearchResults] = useState<(BangumiSearchItem & { source?: 'anilist' | 'bangumi'; searchTerm?: string })[]>([]);
  const [showReSearch, setShowReSearch] = useState(false);

  /** 执行单番深度分析 */
  const handleAIAnalysis = async () => {
    if (!anime || !hasAIConfig()) {
      message.warning('请先在侧栏 AI 设置中配置 API Key');
      return;
    }
    setAiAnalysisLoading(true);
    setAiAnalysisError(null);
    setAiAnalysisResult(null);
    try {
      const result = await singleAnimeAnalysis(anime, allAnime);
      setAiAnalysisResult(result);
    } catch (e) {
      setAiAnalysisError(e instanceof Error ? e.message : '分析失败');
    } finally {
      setAiAnalysisLoading(false);
    }
  };

  /** 执行智能打 Tag */
  const handleAutoTag = async () => {
    if (!anime || !hasAIConfig()) {
      message.warning('请先在侧栏 AI 设置中配置 API Key');
      return;
    }
    setAutoTagLoading(true);
    setAutoTagResult(null);
    try {
      const result = await autoTag(anime);
      setAutoTagResult(result);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '打标签失败');
    } finally {
      setAutoTagLoading(false);
    }
  };

  /** 采纳建议标签 */
  const adoptTag = (name: string) => {
    if (tags.some((t) => t.name === name)) {
      message.warning('标签已存在');
      return;
    }
    setTags((prev) => [...prev, { name, highlighted: true }]);
    setAutoTagResult((prev) => {
      if (!prev) return null;
      return {
        ...prev,
        suggestedTags: prev.suggestedTags.filter((t) => t.name !== name),
      };
    });
    message.success(`已添加标签「${name}」`);
  };

  /** 重新检索：中文名 + 检索名各搜一遍，合并去重 */
  const handleReSearch = async (force = false) => {
    const kw = editTitle.trim();
    const alias = editSearchAlias.trim();
    if (!kw) return;
    setReSearching(true);
    setShowReSearch(true);

    const allResults: (BangumiSearchItem & { source?: 'anilist' | 'bangumi'; searchTerm?: string })[] = [];
    const seenNames = new Set<string>();

    /** 用一个关键词搜索两个 API */
    const searchOne = async (keyword: string, label: string) => {
      const forceParam = force ? '&force=1' : '';
      // AniList
      try {
        const alResp = await fetch(`/api/anilist/search?keyword=${encodeURIComponent(keyword)}${forceParam}`);
        if (alResp.ok) {
          const alData = await alResp.json();
          for (const item of (alData.list || [])) {
            const nameKey = (item.name_cn || item.name).trim();
            if (!seenNames.has(nameKey)) {
              seenNames.add(nameKey);
              allResults.push({ ...item, source: 'anilist' as const, searchTerm: label });
            }
          }
        }
      } catch { /* ignore */ }
      // Bangumi
      try {
        const bgmResp = await fetch(`/api/bangumi/search?keyword=${encodeURIComponent(keyword)}${forceParam}`);
        if (bgmResp.ok) {
          const bgmData = await bgmResp.json();
          for (const item of (bgmData.list || [])) {
            const nameKey = (item.name_cn || item.name).trim();
            if (!seenNames.has(nameKey)) {
              seenNames.add(nameKey);
              allResults.push({ ...item, source: 'bangumi' as const, searchTerm: label });
            }
          }
        }
      } catch { /* ignore */ }
    };

    try {
      // 用中文名搜索
      await searchOne(kw, kw);
      // 用检索名再搜一遍（如果不同）
      if (alias && alias !== kw) {
        await searchOne(alias, alias);
      }
      setReSearchResults(allResults);
    } catch {
      setReSearchResults([]);
      message.info('搜索暂不可用');
    } finally {
      setReSearching(false);
    }
  };

  /** 当前选中的导入项 */
  const [importItem, setImportItem] = useState<(BangumiSearchItem & { source?: 'anilist' | 'bangumi' }) | null>(null);
  const [importChecks, setImportChecks] = useState({
    title: true, searchAlias: true, bgmScore: true, poster: true,
    date: true, summary: true, bangumiId: true,
  });

  /** 执行导入：按勾选字段写入 */
  const doImport = () => {
    const item = importItem;
    if (!item) return;
    const name = item.name_cn || item.name;
    // 按勾选导入各项
    if (importChecks.title && (!editTitle.trim() || editTitle.trim() === anime?.title)) {
      setEditTitle(name);
    }
    if (importChecks.searchAlias && item.name_cn && item.name !== item.name_cn) {
      setEditSearchAlias(item.name);
    }
    if (importChecks.bgmScore && item.rating?.score) {
      setEditBgmScore(item.rating.score);
    }
    if (importChecks.bangumiId && item.id && item.source === 'bangumi') {
      setEditBangumiId(item.id);
    }
    if (importChecks.poster) {
      const poster = item.images?.large || item.images?.common || '';
      if (poster && poster !== posterUrl) {
        setPosterUrl(poster);
        setAllImages((prev) => {
          const filtered = prev.filter((u) => u !== poster);
          return [poster, ...filtered];
        });
        setSlideIdx(0);
      }
    }
    if (importChecks.date && item.air_date && !editReleaseDate) {
      setEditReleaseDate(item.air_date);
    }
    if (importChecks.summary && item.summary && !review.trim()) {
      setReview(item.summary.slice(0, 300));
    }
    setImportItem(null);
    setShowReSearch(false);
    setReSearchResults([]);
    message.success(`已导入「${name}」的信息`);
  };
  const handleSavePoster = async () => {
    if (!anime) return;
    const currentUrl = allImages[slideIdx];
    if (!currentUrl || currentUrl.startsWith('/api/images/')) return; // 已是本地文件
    setSavingPoster(true);
    try {
      // 通过 Vite 代理获取外部图片的 base64（避免跨域）
      const resp = await fetch(`/api/images/proxy?url=${encodeURIComponent(currentUrl)}`);
      if (!resp.ok) throw new Error('获取封面失败');
      const blob = await resp.blob();
      const dataUrl = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(blob);
      });
      const entry = await saveImageToLocal(dataUrl, anime.title);
      // 替换轮播中的封面为本地版本
      setAllImages((prev) => {
        const updated = [...prev];
        updated[slideIdx] = entry.dataUrl;
        return updated;
      });
      setPosterUrl(entry.dataUrl);
      savePosterOverride(anime.id, entry.dataUrl).catch(() => {});
      onPosterChange?.(anime.id, entry.dataUrl);
      // 同步写入 Excel
      savePosterUrlToExcel({ ...anime, posterUrl: entry.dataUrl }).catch(() => {});
      message.success(`封面已保存到本地：${entry.fileName}`);
    } catch (e) {
      message.error('保存封面失败');
    } finally {
      setSavingPoster(false);
    }
  };
  const dragStart = useRef<{ x: number; y: number; px: number; py: number }>({ x: 0, y: 0, px: 50, py: 50 });
  const curPos = useRef({ x: 50, y: 50 });
  const slideTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // 停止轮播
  const stopSlide = () => {
    if (slideTimer.current) { clearInterval(slideTimer.current); slideTimer.current = null; }
  };
  // 启动轮播
  const startSlide = () => {
    stopSlide();
    if (allImages.length > 1) {
      slideTimer.current = setInterval(() => {
        setSlideIdx((prev) => (prev + 1) % allImages.length);
      }, 3000);
    }
  };

  useEffect(() => {
    if (anime) {
      setScores([...anime.scores]);
      setReview(anime.review || '');
      setTags([...anime.tags]);
      setDimReviews(anime.dimensionReviews || []);
      setCategory(anime.category);
      setEditingDimReview(null);
      setEditing(false); // 每次打开默认查看模式
      setSliderDim(null);
      setAiAnalysisResult(null);
      setAiAnalysisError(null);
      setAutoTagResult(null);
      setEditTitle(anime.title);
      setEditReleaseDate(anime.releaseDate || '');
      setEditWatchDate(anime.watchDate || anime.createdAt || '');
      setEditBgmScore(anime.bangumiScore);
      setEditAnilistScore(anime.aniListScore);
      setEditStudio(anime.studio || '');
      setEditFrameCount(anime.frameCount);
      setEditSearchAlias(anime.searchAlias || '');
      setEditBangumiId(anime.bangumiId);
      // 构建图片列表：封面 + 本地存储的图片
      loadImages(anime.title).then(stored => {
        const storedUrls = stored.map((img) => img.dataUrl);
        const imgs = anime.posterUrl ? [anime.posterUrl, ...storedUrls] : storedUrls;
        setAllImages(imgs);
        setSlideIdx(0);
        stopSlide();
        if (imgs.length > 1) startSlide();
      });
      setPosterUrl(anime.posterUrl || '');
      // 加载保存的海报焦点位置
      const positions = loadPosterPositions();
      if (positions[anime.id]) {
        setPosX(positions[anime.id].x);
        setPosY(positions[anime.id].y);
        curPos.current = { x: positions[anime.id].x, y: positions[anime.id].y };
      } else {
        setPosX(50);
        setPosY(50);
        curPos.current = { x: 50, y: 50 };
      }
      // 无海报时懒加载（检查黑名单）
      const bl = loadPosterBlacklist();
      if (!anime.posterUrl && anime.title && !bl.has(anime.id)) {
        fetchPoster(anime.title).then((url) => {
          if (url) {
            setPosterUrl(url);
            setAllImages((prev) => [url, ...prev]);
          }
        });
      }
    }
    return stopSlide;
  }, [anime]);

  // 轮播翻页
  const prevSlide = () => { stopSlide(); setSlideIdx((p) => (p - 1 + allImages.length) % allImages.length); };
  const nextSlide = () => { stopSlide(); setSlideIdx((p) => (p + 1) % allImages.length); };

  // 海报拖拽（用 ref 跟踪实时位置，避免 state 异步问题）
  const handlePosterMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, px: curPos.current.x, py: curPos.current.y };
  };
  const handlePosterMouseMove = (e: React.MouseEvent) => {
    if (!dragStart.current.x) return; // 未在拖拽
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    const nx = Math.round(Math.max(0, Math.min(100, dragStart.current.px + dx)));
    const ny = Math.round(Math.max(0, Math.min(100, dragStart.current.py + dy)));
    curPos.current = { x: nx, y: ny };
    setPosX(nx);
    setPosY(ny);
  };
  const handlePosterMouseUp = () => {
    if (!dragStart.current.x) return;
    dragStart.current.x = 0; // 标记拖拽结束
    setDragging(false);
    if (anime) savePosterPosition(anime.id, curPos.current.x, curPos.current.y);
  };


  // 计算总评
  const overallScore = useMemo(() => {
    const dims = DEFAULT_DIMENSIONS.filter((d) => d.key !== 'overall' && d.weight > 0);
    let tw = 0, ws = 0;
    for (const dim of dims) {
      const score = scores.find((s) => s.dimensionKey === dim.key)?.score ?? 0;
      if (score > 0) { ws += score * dim.weight; tw += dim.weight; }
    }
    return tw > 0 ? (ws / tw).toFixed(2) : '-';
  }, [scores]);

  // 更新维度分数
  const handleScoreChange = (dimKey: string, value: number | null) => {
    setScores((prev) => {
      const existing = prev.find((s) => s.dimensionKey === dimKey);
      if (existing) return prev.map((s) => s.dimensionKey === dimKey ? { ...s, score: value ?? 0 } : s);
      return [...prev, { dimensionKey: dimKey, score: value ?? 0 }];
    });
  };

  const getScore = (dimKey: string): number =>
    scores.find((s) => s.dimensionKey === dimKey)?.score ?? 0;

  /** 中英文宽度感知的右填充：中文算 2 宽，ASCII 算 1 宽 */
  const padRight = (text: string, targetWidth: number): string => {
    let w = 0;
    for (const ch of text) {
      w += /[一-鿿　-〿＀-￯]/.test(ch) ? 2 : 1;
    }
    const pad = Math.max(0, targetWidth * 2 - w);
    return text + ' '.repeat(pad);
  };

  /** 将全部维度评分+专项评价按模板批量插入全局评价底部 */
  const importAllDimsToReview = () => {
    const lines: string[] = [];

    // 总评（首行）
    const overallScore = scores.find((sc) => sc.dimensionKey === 'overall')?.score;
    const overallScoreStr = overallScore && overallScore > 0 ? overallScore.toFixed(2) : '-';
    lines.push(`${padRight('总评', 4)} ${overallScoreStr.padStart(5)}`);

    for (const dim of DEFAULT_DIMENSIONS) {
      if (dim.key === 'overall') continue;
      const s = scores.find((sc) => sc.dimensionKey === dim.key);
      const rawScore = s?.score ?? 0;
      const scoreStr = rawScore > 0 ? rawScore.toFixed(dim.key === 'vibe' ? 2 : 1) : '-';
      const dimReview = dimReviews.find((r) => r.dimensionKey === dim.key)?.content || '';
      lines.push(`${padRight(dim.label, 4)} ${scoreStr.padStart(5)}  ${dimReview}`);
    }
    if (lines.length === 0) return;
    setReview((prev) => {
      const trimmed = prev.trimEnd();
      return trimmed ? `${trimmed}\n${lines.join('\n')}` : lines.join('\n');
    });
    message.success(`已导入 ${lines.length} 个维度评分到评价`);
  };

  // ── 可选标签：从全部番剧中收集，排除已在当前番剧的，按使用次数排序 ──
  const availableTags = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const a of allAnime) {
      for (const t of a.tags) {
        counts[t.name] = (counts[t.name] || 0) + 1;
      }
    }
    const currentNames = new Set(tags.map((t) => t.name));
    return Object.entries(counts)
      .filter(([name]) => !currentNames.has(name))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'));
  }, [allAnime, tags]);

  // Tag 操作
  const toggleTag = (idx: number) => {
    setTags((prev) => prev.map((t, i) => i === idx ? { ...t, highlighted: !t.highlighted } : t));
  };

  const addTag = () => {
    const name = tagInput.trim();
    if (name) {
      // 有输入内容 → 直接添加
      if (tags.some((t) => t.name === name)) { message.warning('标签已存在'); return; }
      setTags((prev) => [...prev, { name, highlighted: true }]);
      setTagInput('');
    } else {
      // 无输入 → 弹出标签选择器
      setShowTagPicker(!showTagPicker);
    }
  };

  /** 从标签选择器中点选标签 */
  const selectTagFromPicker = (name: string) => {
    if (tags.some((t) => t.name === name)) { message.warning('标签已存在'); return; }
    setTags((prev) => [...prev, { name, highlighted: true }]);
    setShowTagPicker(false);
  };

  const removeTag = (idx: number) => {
    setTags((prev) => prev.filter((_, i) => i !== idx));
  };

  // 维度专项评价
  const getDimReview = (dimKey: string): string =>
    dimReviews.find((r) => r.dimensionKey === dimKey)?.content || '';

  const setDimReview = (dimKey: string, content: string) => {
    setDimReviews((prev) => {
      const existing = prev.find((r) => r.dimensionKey === dimKey);
      if (existing) return prev.map((r) => r.dimensionKey === dimKey ? { ...r, content } : r);
      return [...prev, { dimensionKey: dimKey, content }];
    });
  };

  // 保存
  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave({
        ...anime!,
        title: editTitle.trim() || anime!.title,
        scores, review, tags, dimensionReviews: dimReviews, category, posterUrl,
        releaseDate: editReleaseDate || undefined,
        watchDate: editWatchDate || undefined,
        bangumiScore: editBgmScore,
        aniListScore: editAnilistScore,
        studio: editStudio || undefined,
        frameCount: editFrameCount,
        searchAlias: editSearchAlias || undefined,
        bangumiId: editBangumiId,
      });
      message.success('已保存到 Excel');
      setEditing(false);
    } catch (e) {
      message.error('保存失败：' + (e instanceof Error ? e.message : '未知错误'));
    } finally {
      setSaving(false);
    }
  };

  if (!anime) return null;

  const displayDims = DEFAULT_DIMENSIONS.filter((d) => d.key !== 'overall');

  return (
    <Modal
      title={
        editing ? (
          <div>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Input value={editTitle} onChange={(e) => setEditTitle(e.target.value)}
                  style={{ fontSize: 23, fontWeight: 600, background: '#0d1117', borderColor: '#30363d', color: '#e6edf3', width: 300 }} />
                <Button
                  size="small"
                  icon={<SearchOutlined />}
                  loading={reSearching}
                  onClick={() => handleReSearch(false)}
                  style={{ background: '#21262d', borderColor: '#30363d', color: '#8b949e', fontSize: 11 }}
                >
                  重新检索
                </Button>
                <Button
                  size="small"
                  loading={reSearching}
                  onClick={() => handleReSearch(true)}
                  style={{ background: '#21262d', borderColor: '#f85149', color: '#f85149', fontSize: 11 }}
                  title="跳过缓存，强制从 API 重新获取"
                >
                  🔄 强制刷新
                </Button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                {/* BGM ID 角标 */}
                {editBangumiId && (
                  <a
                    href={`https://bgm.tv/subject/${editBangumiId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      fontSize: 10, color: '#fb7299', opacity: 0.6,
                      textDecoration: 'none', flexShrink: 0,
                      fontFamily: 'monospace',
                    }}
                    title="在 Bangumi 查看"
                  >
                    BGM #{editBangumiId}
                  </a>
                )}
                {/* 前/后番剧切换按钮 */}
                <div style={{ display: 'flex', gap: 2, marginLeft: 4, marginRight: 28 }}>
                  <Button
                    size="small"
                    type="text"
                    icon={<LeftOutlined />}
                    disabled={!prevAnime}
                    onClick={() => prevAnime && handleNavigate(prevAnime)}
                    title={prevAnime ? `上一个：${prevAnime.title}` : '已是第一部'}
                    style={{ color: prevAnime ? '#e6edf3' : '#30363d', fontSize: 12, minWidth: 28 }}
                  />
                  <Button
                    size="small"
                    type="text"
                    icon={<RightOutlined />}
                    disabled={!nextAnime}
                    onClick={() => nextAnime && handleNavigate(nextAnime)}
                    title={nextAnime ? `下一个：${nextAnime.title}` : '已是最后一部'}
                    style={{ color: nextAnime ? '#e6edf3' : '#30363d', fontSize: 12, minWidth: 28 }}
                  />
                </div>
              </div>
            </div>
            {/* 检索结果列表 */}
            {showReSearch && (
              <div style={{
                marginTop: 8, maxHeight: 200, overflowY: 'auto',
                background: '#0d1117', border: '1px solid #30363d', borderRadius: 8,
              }}>
                {reSearchResults.length === 0 && !reSearching ? (
                  <div style={{ padding: 12, textAlign: 'center', color: '#484f58', fontSize: 12 }}>
                    未找到结果
                  </div>
                ) : (
                  reSearchResults.map((item, i) => (
                    <div
                      key={i}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '8px 12px',
                        borderBottom: i < reSearchResults.length - 1 ? '1px solid #21262d' : 'none',
                        transition: 'background 0.15s',
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = '#161b22'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                    >
                      {item.images?.small && (
                        <img src={item.images.small} alt=""
                          style={{ width: 40, height: 54, objectFit: 'cover', borderRadius: 4, flexShrink: 0 }} />
                      )}
                      <div
                        style={{ flex: 1, minWidth: 0 }}
                      >
                        <div style={{ fontSize: 12, color: '#e6edf3', fontWeight: 600 }}>
                          {item.name_cn || item.name}
                        </div>
                        {item.name_cn && item.name !== item.name_cn && (
                          <div style={{ fontSize: 10, color: '#8b949e', opacity: 0.7 }}>
                            {item.name}
                          </div>
                        )}
                        <div style={{ fontSize: 10, color: '#484f58', marginTop: 1 }}>
                          {item.air_date || ''} {item.rating?.score ? `· ${item.rating.score}分` : ''}
                          {item.id ? ` · ${item.source === 'anilist' ? 'AL' : 'BGM'}#${item.id}` : ''}
                          {(item as { searchTerm?: string }).searchTerm && (
                            <span style={{ color: '#2eaadc', marginLeft: 4 }}>
                              🔍「{(item as { searchTerm?: string }).searchTerm}」
                            </span>
                          )}
                        </div>
                      </div>
                      {/* 查看详情 Popover */}
                      <Popover
                        trigger="click"
                        placement="left"
                        content={
                          <div style={{ maxWidth: 360, maxHeight: 400, overflowY: 'auto' }}>
                            {item.images?.large && (
                              <img
                                src={item.images.large}
                                alt=""
                                style={{
                                  width: '100%', maxHeight: 200, objectFit: 'cover',
                                  borderRadius: 6, marginBottom: 8,
                                }}
                              />
                            )}
                            <div style={{ fontWeight: 600, fontSize: 14, color: '#e6edf3', marginBottom: 2 }}>
                              {item.name_cn || item.name}
                            </div>
                            {item.name_cn && item.name !== item.name_cn && (
                              <div style={{ fontSize: 11, color: '#8b949e', marginBottom: 6 }}>
                                {item.name}
                              </div>
                            )}
                            <div style={{ display: 'flex', gap: 12, marginBottom: 6, fontSize: 11, color: '#8b949e' }}>
                              {item.air_date && <span>📅 {item.air_date}</span>}
                              {item.eps > 0 && <span>📺 {item.eps}集</span>}
                              {item.rating?.score > 0 && (
                                <span style={{ color: '#fb7299', fontWeight: 600 }}>
                                  ⭐ {item.rating.score}
                                  {item.rating.total > 0 && ` (${item.rating.total}人)`}
                                </span>
                              )}
                            </div>
                            {item.summary && (
                              <Paragraph
                                ellipsis={{ rows: 8, expandable: true, symbol: '展开' }}
                                style={{ fontSize: 11, color: '#8b949e', lineHeight: 1.7, marginBottom: 0 }}
                              >
                                {item.summary}
                              </Paragraph>
                            )}
                            <div style={{ marginTop: 6, fontSize: 10, color: '#484f58' }}>
                              来源：{item.source === 'anilist' ? 'AniList' : 'Bangumi'}
                              {item.id ? ` · #${item.id}` : ''}
                            </div>
                          </div>
                        }
                      >
                        <Button
                          size="small"
                          type="text"
                          onClick={(e) => e.stopPropagation()}
                          title="查看详细信息"
                          style={{
                            color: '#2eaadc', fontSize: 10, padding: '0 4px', flexShrink: 0,
                          }}
                        >
                          详情
                        </Button>
                      </Popover>
                      <Popover
                        trigger="click"
                        placement="bottomRight"
                        open={importItem?.id === item.id}
                        onOpenChange={(v) => {
                          if (v) {
                            setImportItem(item);
                            setImportChecks({
                              title: true, searchAlias: true, bgmScore: true,
                              poster: true, date: true, summary: true, bangumiId: true,
                            });
                          } else {
                            setImportItem(null);
                          }
                        }}
                        content={
                          <div style={{ minWidth: 180 }}>
                            <div style={{ fontSize: 12, fontWeight: 600, color: '#e6edf3', marginBottom: 8 }}>
                              选择导入项
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
                              <Checkbox checked={importChecks.title} onChange={(e) => setImportChecks((c) => ({ ...c, title: e.target.checked }))}>
                                <span style={{ fontSize: 12, color: '#e6edf3' }}>主标题</span>
                                <span style={{ fontSize: 10, color: '#484f58', marginLeft: 4 }}>{item.name_cn || item.name}</span>
                              </Checkbox>
                              {item.name_cn && item.name !== item.name_cn && (
                                <Checkbox checked={importChecks.searchAlias} onChange={(e) => setImportChecks((c) => ({ ...c, searchAlias: e.target.checked }))}>
                                  <span style={{ fontSize: 12, color: '#e6edf3' }}>检索名</span>
                                  <span style={{ fontSize: 10, color: '#484f58', marginLeft: 4 }}>{item.name}</span>
                                </Checkbox>
                              )}
                              {item.rating?.score > 0 && (
                                <Checkbox checked={importChecks.bgmScore} onChange={(e) => setImportChecks((c) => ({ ...c, bgmScore: e.target.checked }))}>
                                  <span style={{ fontSize: 12, color: '#e6edf3' }}>评分</span>
                                  <span style={{ fontSize: 10, color: '#fb7299', marginLeft: 4 }}>{item.rating.score}分</span>
                                </Checkbox>
                              )}
                              {item.images?.large && (
                                <Checkbox checked={importChecks.poster} onChange={(e) => setImportChecks((c) => ({ ...c, poster: e.target.checked }))}>
                                  <span style={{ fontSize: 12, color: '#e6edf3' }}>海报图</span>
                                </Checkbox>
                              )}
                              {item.air_date && (
                                <Checkbox checked={importChecks.date} onChange={(e) => setImportChecks((c) => ({ ...c, date: e.target.checked }))}>
                                  <span style={{ fontSize: 12, color: '#e6edf3' }}>上映日期</span>
                                  <span style={{ fontSize: 10, color: '#484f58', marginLeft: 4 }}>{item.air_date}</span>
                                </Checkbox>
                              )}
                              {item.summary && (
                                <Checkbox checked={importChecks.summary} onChange={(e) => setImportChecks((c) => ({ ...c, summary: e.target.checked }))}>
                                  <span style={{ fontSize: 12, color: '#e6edf3' }}>简介→评价</span>
                                </Checkbox>
                              )}
                              {item.id && item.source === 'bangumi' && (
                                <Checkbox checked={importChecks.bangumiId} onChange={(e) => setImportChecks((c) => ({ ...c, bangumiId: e.target.checked }))}>
                                  <span style={{ fontSize: 12, color: '#e6edf3' }}>BGM ID</span>
                                  <span style={{ fontSize: 10, color: '#484f58', marginLeft: 4 }}>#{item.id}</span>
                                </Checkbox>
                              )}
                            </div>
                            <Button type="primary" block size="small" onClick={(e) => { e.stopPropagation(); doImport(); }}
                              style={{ background: '#fb7299', borderColor: '#fb7299', fontWeight: 600 }}>
                              确认导入
                            </Button>
                          </div>
                        }
                      >
                        <Button
                          size="small"
                          type="primary"
                          onClick={(e) => e.stopPropagation()}
                          style={{
                            background: 'linear-gradient(135deg, #fb7299, #e85d8a)',
                            border: 'none', fontWeight: 600, fontSize: 12, flexShrink: 0,
                            padding: '2px 14px',
                          }}
                        >
                          导入
                        </Button>
                      </Popover>
                    </div>
                  ))
                )}
              </div>
            )}
            {/* 检索名编辑 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
              <Input
                size="small"
                value={editSearchAlias}
                onChange={(e) => setEditSearchAlias(e.target.value)}
                placeholder="检索名（日文原名/别名）"
                style={{
                  width: 300, fontSize: 11,
                  background: '#0d1117', borderColor: '#30363d', color: '#8b949e',
                }}
              />
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
            <div>
              <span style={{ fontSize: 23, fontWeight: 600 }}>
                {anime.title}
              </span>
              {/* 副标题：检索名或日文名 */}
              {(anime.searchAlias || anime.titleJa) && (
                <div style={{ fontSize: 12, color: '#8b949e', opacity: 0.7, marginTop: 2 }}>
                  {anime.searchAlias && anime.searchAlias.trim() !== anime.title.trim()
                    ? anime.searchAlias
                    : anime.titleJa || ''}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
              {/* BGM ID 角标 */}
              {anime.bangumiId && (
                <a
                  href={`https://bgm.tv/subject/${anime.bangumiId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    fontSize: 10, color: '#fb7299', opacity: 0.6,
                    textDecoration: 'none', flexShrink: 0,
                    fontFamily: 'monospace',
                  }}
                  title="在 Bangumi 查看"
                >
                  BGM #{anime.bangumiId}
                </a>
              )}
              {/* 前/后番剧切换按钮 */}
              <div style={{ display: 'flex', gap: 2, marginLeft: 4, marginRight: 28 }}>
                <Button
                  size="small"
                  type="text"
                  icon={<LeftOutlined />}
                  disabled={!prevAnime}
                  onClick={() => prevAnime && handleNavigate(prevAnime)}
                  title={prevAnime ? `上一个：${prevAnime.title}` : '已是第一部'}
                  style={{ color: prevAnime ? '#e6edf3' : '#30363d', fontSize: 12, minWidth: 28 }}
                />
                <Button
                  size="small"
                  type="text"
                  icon={<RightOutlined />}
                  disabled={!nextAnime}
                  onClick={() => nextAnime && handleNavigate(nextAnime)}
                  title={nextAnime ? `下一个：${nextAnime.title}` : '已是最后一部'}
                  style={{ color: nextAnime ? '#e6edf3' : '#30363d', fontSize: 12, minWidth: 28 }}
                />
              </div>
            </div>
          </div>
        )
      }
      open={open}
      onCancel={onClose}
      width={1050}
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: '#8b949e', fontSize: 12 }}>
            {editing ? '修改将直接写回 Excel 文件' : '点击「修改」进入编辑模式'}
          </span>
          <Space>
            {editing ? (
              <>
                <Button onClick={() => {
                  // 取消编辑：恢复原始值
                  if (anime) {
                    setEditTitle(anime.title);
                    setEditReleaseDate(anime.releaseDate || '');
                    setEditWatchDate(anime.watchDate || anime.createdAt || '');
                    setEditBgmScore(anime.bangumiScore);
                    setEditAnilistScore(anime.aniListScore);
                    setEditStudio(anime.studio || '');
                    setEditFrameCount(anime.frameCount);
                    setEditSearchAlias(anime.searchAlias || '');
                    setEditBangumiId(anime.bangumiId);
                    setScores([...anime.scores]);
                    setReview(anime.review || '');
                    setTags([...anime.tags]);
                    setDimReviews(anime.dimensionReviews || []);
                    setCategory(anime.category);
                  }
                  setEditing(false);
                }}>取消</Button>
                <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={handleSave}>
                  保存到 Excel
                </Button>
              </>
            ) : (
              <Button type="primary" icon={<EditOutlined />} onClick={() => setEditing(true)}>
                修改
              </Button>
            )}
          </Space>
        </div>
      }
      styles={{ body: { maxHeight: '75vh', overflowY: 'auto' } }}
    >
      {/* ── 上部：基本信息（横向） ── */}
      <Descriptions size="small" column={4} style={{ marginBottom: 12 }}>
        <Descriptions.Item label="上映">
          {editing ? (
            <Input size="small" value={editReleaseDate} onChange={(e) => setEditReleaseDate(e.target.value)}
              placeholder="如 2021-04" style={{ width: 100, background: '#0d1117', borderColor: '#30363d', color: '#e6edf3' }} />
          ) : (anime.releaseDate || '-')}
        </Descriptions.Item>
        <Descriptions.Item label="观看时间">
          {editing ? (
            <Input size="small" value={editWatchDate} onChange={(e) => setEditWatchDate(e.target.value)}
              placeholder="如 2024-03-15" style={{ width: 110, background: '#0d1117', borderColor: '#30363d', color: '#e6edf3' }} />
          ) : (anime.watchDate || anime.createdAt || '-')}
        </Descriptions.Item>
        <Descriptions.Item label="Bangumi">
          {editing ? (
            <InputNumber size="small" min={0} max={10} step={0.1}
              value={editBgmScore} onChange={(v) => setEditBgmScore(v ?? undefined)}
              style={{ width: 70 }} />
          ) : (anime.bangumiScore ? <span style={{ color: '#fb7299', fontWeight: 600 }}>{anime.bangumiScore}</span> : '-')}
        </Descriptions.Item>
        <Descriptions.Item label="AniList">
          {editing ? (
            <InputNumber size="small" min={0} max={10} step={0.1}
              value={editAnilistScore} onChange={(v) => setEditAnilistScore(v ?? undefined)}
              style={{ width: 70 }} />
          ) : (anime.aniListScore ? <span style={{ color: '#00a1d6', fontWeight: 600 }}>{anime.aniListScore}</span> : '-')}
        </Descriptions.Item>
        <Descriptions.Item label="制作组">
          {editing ? (
            <Input size="small" value={editStudio} onChange={(e) => setEditStudio(e.target.value)}
              placeholder="动画公司" style={{ width: 120, background: '#0d1117', borderColor: '#30363d', color: '#e6edf3' }} />
          ) : (anime.studio || '-')}
        </Descriptions.Item>
        <Descriptions.Item label="张数">
          {editing ? (
            <InputNumber size="small" min={0} step={1}
              value={editFrameCount} onChange={(v) => setEditFrameCount(v ?? undefined)}
              placeholder="中割张数" style={{ width: 90 }} />
          ) : (anime.frameCount ? <span style={{ color: '#e6edf3', fontWeight: 500 }}>{anime.frameCount.toLocaleString()} 张</span> : '-')}
        </Descriptions.Item>
        <Descriptions.Item label="分类">
          <Select
            size="small"
            value={category}
            onChange={(v) => setCategory(v)}
            disabled={!editing}
            style={{ width: 80 }}
            options={Object.entries(CATEGORY_CONFIG).map(([key, cfg]) => ({ value: key, label: cfg.label }))}
          />
        </Descriptions.Item>
      </Descriptions>

      <div style={{ display: 'flex', gap: 24, minHeight: 600 }}>
        {/* ── 左侧 2/3 ── */}
        <div style={{ flex: 2, display: 'flex', flexDirection: 'column' }}>
          {/* 雷达图（上方） */}
          <div style={{ height: 300, marginBottom: 14 }}>
            <RadarChart anime={anime} allAnime={allAnime} />
          </div>

          {/* 维度评分编辑 */}
          <div style={{ marginBottom: 10 }}>
            <span style={{ fontWeight: 600, fontSize: 14, display: 'block', marginBottom: 6 }}>
              📊 维度评分
              <span style={{ fontSize: 16, fontWeight: 700, color: '#fb7299', marginLeft: 12 }}>总评 {overallScore}</span>
              {editing && (
                <Tooltip title="将全部维度评分+专项评价按模板导入到评价底部">
                  <Button size="small" type="text" icon={<ImportOutlined />}
                    onClick={importAllDimsToReview}
                    style={{ color: '#8b949e', marginLeft: 8, fontSize: 12 }}>
                    导入评价
                  </Button>
                </Tooltip>
              )}
            </span>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '4px 10px' }}>
              {displayDims.map((dim) => {
                const score = getScore(dim.key);
                const hasReview = getDimReview(dim.key);
                const isSliderActive = sliderDim === dim.key;
                return (
                  <div
                    key={dim.key}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 4,
                      padding: '2px 4px', borderRadius: 4,
                      background: isSliderActive ? 'rgba(251,114,153,0.08)' : 'transparent',
                      border: isSliderActive ? '1px solid rgba(251,114,153,0.2)' : '1px solid transparent',
                      transition: 'background 0.15s, border 0.15s',
                    }}
                  >
                    <Tooltip title={dim.description}>
                      <span style={{ fontSize: 12, color: '#e6edf3', minWidth: 36, textAlign: 'right', cursor: 'help' }}>
                        {dim.label}
                      </span>
                    </Tooltip>
                    <InputNumber size="small" min={0} max={10}
                      step={dim.key === 'vibe' ? 0.01 : 0.1}
                      precision={dim.key === 'vibe' ? 2 : undefined}
                      value={score || null} onChange={(v) => handleScoreChange(dim.key, v)}
                      disabled={!editing}
                      onFocus={() => { if (editing) setSliderDim(dim.key); }}
                      style={{
                        width: dim.key === 'vibe' ? 64 : 56,
                        borderColor: isSliderActive ? '#fb7299' : undefined,
                      }} placeholder="0" />
                    {editing && (
                      <span onClick={(e) => { e.stopPropagation(); setEditingDimReview(editingDimReview === dim.key ? null : dim.key); }}
                        style={{ cursor: 'pointer', color: hasReview ? '#fb7299' : '#484f58', fontSize: 12 }}>
                        <EditOutlined />
                      </span>
                    )}
                  </div>
                );
              })}
            </div>

            {/* 拖拽滑条（选中维度后出现） */}
            {sliderDim && editing && (
              <ScoreSlider
                dimKey={sliderDim}
                score={getScore(sliderDim)}
                dimLabel={DIMENSION_LABEL_MAP[sliderDim] || sliderDim}
                isVibe={sliderDim === 'vibe'}
                onChange={(v) => handleScoreChange(sliderDim, v)}
                onClose={() => setSliderDim(null)}
                sliderRef={sliderRef}
              />
            )}

            {/* 深度分析按钮（编辑模式） */}
            {editing && (
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #21262d' }}>
                <Button
                  icon={<ThunderboltOutlined />}
                  onClick={handleAIAnalysis}
                  loading={aiAnalysisLoading}
                  size="small"
                  style={{
                    background: 'linear-gradient(135deg, rgba(251,114,153,0.15), rgba(251,114,153,0.04))',
                    borderColor: 'rgba(251,114,153,0.25)',
                    color: '#fb7299',
                    fontWeight: 600,
                    fontSize: 12,
                  }}
                >
                  🤖 深度分析
                </Button>
                <span style={{ fontSize: 10, color: '#484f58', marginLeft: 8 }}>
                  AI 分析这部番为什么打动你（约 800 token / ¥0.002）
                </span>

                {/* 错误提示 */}
                {aiAnalysisError && (
                  <div style={{ marginTop: 8, color: '#f85149', fontSize: 11 }}>
                    {aiAnalysisError}
                    <Button type="link" size="small" onClick={handleAIAnalysis}
                      style={{ color: '#fb7299', fontSize: 11, padding: 0, marginLeft: 6 }}>
                      重试
                    </Button>
                  </div>
                )}

                {/* 分析结果 */}
                {aiAnalysisResult && (
                  <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {/* 核心吸引力 */}
                    {aiAnalysisResult.coreAppeal.length > 0 && (
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 600, color: '#fb7299', marginBottom: 4 }}>
                          🎯 核心吸引力
                        </div>
                        {aiAnalysisResult.coreAppeal.map((item, i) => (
                          <div key={i} style={{
                            background: '#161b22', border: '1px solid #30363d',
                            borderRadius: 6, padding: '8px 12px', marginBottom: 4,
                          }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                              <span style={{ fontSize: 12, fontWeight: 600, color: '#e6edf3' }}>{item.aspect}</span>
                              <Tag color="pink" style={{ fontSize: 9, lineHeight: '16px', margin: 0 }}>
                                {Math.round(item.confidence * 100)}%
                              </Tag>
                            </div>
                            <div style={{ fontSize: 11, color: '#8b949e', lineHeight: 1.5 }}>{item.evidence}</div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* 电波模式 */}
                    {aiAnalysisResult.vibePattern && (
                      <div style={{
                        background: 'linear-gradient(135deg, rgba(0,161,214,0.08), rgba(0,161,214,0.02))',
                        border: '1px solid rgba(0,161,214,0.12)',
                        borderRadius: 6, padding: '8px 12px',
                      }}>
                        <span style={{ fontSize: 11, fontWeight: 600, color: '#00a1d6' }}>📡 电波模式：</span>
                        <span style={{ fontSize: 11, color: '#8b949e' }}>{aiAnalysisResult.vibePattern}</span>
                      </div>
                    )}

                    {/* 社区差异 */}
                    {aiAnalysisResult.communityGap && aiAnalysisResult.communityGap !== '无社区对比数据' && (
                      <div style={{
                        background: 'linear-gradient(135deg, rgba(255,179,71,0.08), rgba(255,179,71,0.02))',
                        border: '1px solid rgba(255,179,71,0.12)',
                        borderRadius: 6, padding: '8px 12px',
                      }}>
                        <span style={{ fontSize: 11, fontWeight: 600, color: '#ffb347' }}>🌐 社区差异：</span>
                        <span style={{ fontSize: 11, color: '#8b949e' }}>{aiAnalysisResult.communityGap}</span>
                      </div>
                    )}

                    {/* 相似番剧 */}
                    {aiAnalysisResult.similarAnime.length > 0 && (
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 600, color: '#a371f7', marginBottom: 4 }}>
                          🔗 电波相近的番
                        </div>
                        {aiAnalysisResult.similarAnime.map((item, i) => (
                          <div key={i} style={{
                            fontSize: 11, color: '#8b949e', lineHeight: 1.6,
                            padding: '2px 8px', borderLeft: '2px solid #a371f7', marginBottom: 3,
                          }}>
                            <span style={{ color: '#e6edf3', fontWeight: 600 }}>{item.title}</span> — {item.why}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 维度专项评价 */}
          {editingDimReview && (
            <div style={{ marginBottom: 10, padding: 8, background: '#1c2128', borderRadius: 6, border: '1px solid #30363d' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#fb7299', marginBottom: 4 }}>
                {DIMENSION_LABEL_MAP[editingDimReview] || editingDimReview} 专项评价
              </div>
              <TextArea value={getDimReview(editingDimReview)}
                onChange={(e) => setDimReview(editingDimReview, e.target.value)}
                placeholder="对该维度的专项评价…" rows={2}
                style={{ background: '#0d1117', borderColor: '#30363d', color: '#e6edf3' }} />
            </div>
          )}

          {/* 全局评价 */}
          <div>
            <span style={{ fontWeight: 600, fontSize: 14, display: 'block', marginBottom: 6 }}>📝 评价</span>
            <TextArea value={review} onChange={(e) => setReview(e.target.value)}
              placeholder="写下你对这部番的评价…" rows={5}
              readOnly={!editing}
              style={{ background: editing ? '#1c2128' : '#161b22', borderColor: '#30363d', color: '#e6edf3' }} />
          </div>
        </div>

        {/* ── 右侧 1/3：海报轮播 + 标签 ── */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* 海报轮播 */}
          <div style={{
            position: 'relative', width: '100%', aspectRatio: '3/4',
            borderRadius: 8, overflow: 'hidden',
            border: '1px solid #30363d', background: 'linear-gradient(135deg, #1a1030, #2d1a2c)',
            cursor: dragging ? 'grabbing' : allImages.length > 0 ? 'grab' : 'default',
          }}
            onMouseDown={handlePosterMouseDown}
            onMouseMove={handlePosterMouseMove}
            onMouseUp={handlePosterMouseUp}
            onMouseLeave={handlePosterMouseUp}
          >
            {allImages.length > 0 ? (
              <img src={allImages[slideIdx]} alt={anime.title}
                draggable={false}
                style={{
                  width: '100%', height: '100%', objectFit: 'cover',
                  objectPosition: `${posX}% ${posY}%`,
                  pointerEvents: 'none',
                }} />
            ) : (
              <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span style={{ fontSize: '4rem', color: '#fb7299', opacity: 0.4 }}>🎬</span>
              </div>
            )}
            {/* 焦点十字准星（拖拽时显示） */}
            {dragging && (
              <div style={{
                position:'absolute', left:`${posX}%`, top:`${posY}%`,
                width:16, height:16, transform:'translate(-50%,-50%)',
                border:'2px solid #fb7299', borderRadius:'50%',
                pointerEvents:'none', zIndex:5,
              }} />
            )}
            {/* 轮播箭头 */}
            {allImages.length > 1 && (<>
              <div onClick={(e)=>{e.stopPropagation();prevSlide();}} style={{ position:'absolute',left:4,top:'50%',transform:'translateY(-50%)',width:26,height:26,borderRadius:'50%',background:'rgba(0,0,0,0.6)',display:'flex',alignItems:'center',justifyContent:'center',cursor:'pointer',color:'#fff',fontSize:13,zIndex:3 }}><LeftOutlined /></div>
              <div onClick={(e)=>{e.stopPropagation();nextSlide();}} style={{ position:'absolute',right:4,top:'50%',transform:'translateY(-50%)',width:26,height:26,borderRadius:'50%',background:'rgba(0,0,0,0.6)',display:'flex',alignItems:'center',justifyContent:'center',cursor:'pointer',color:'#fff',fontSize:13,zIndex:3 }}><RightOutlined /></div>
              <div style={{ position:'absolute',bottom:6,left:'50%',transform:'translateX(-50%)',display:'flex',gap:4,zIndex:3 }}>
                {allImages.map((_,i)=><div key={i} style={{ width:6,height:6,borderRadius:'50%',background:i===slideIdx?'#fb7299':'rgba(255,255,255,0.4)' }} />)}
              </div>
            </>)}
            {allImages[slideIdx]===posterUrl && allImages.length>0 && (
              <div style={{ position:'absolute',top:6,left:6,background:'rgba(251,114,153,0.85)',borderRadius:4,padding:'1px 6px',fontSize:10,color:'#fff',fontWeight:600 }}>封面</div>
            )}
          </div>

          {/* 按钮 */}
          <div style={{ display:'flex',gap:6, flexWrap:'wrap' }}>
            <Button size="small" icon={<PictureOutlined />} onClick={()=>setImageManagerOpen(true)}>图片管理</Button>
            {/* 保存外部封面到本地 */}
            {allImages.length > 0 && allImages[slideIdx]?.startsWith('http') && (
              <Button size="small" loading={savingPoster} onClick={handleSavePoster}>💾 保存封面</Button>
            )}
            {allImages.length > 0 && allImages[slideIdx] && (
              <>
                <Button size="small" onClick={() => setPreviewVisible(true)}>🔍 原图</Button>
                <Image src={allImages[slideIdx]} style={{ display: 'none' }}
                  preview={{ visible: previewVisible, onVisibleChange: (v) => setPreviewVisible(v) }} />
              </>
            )}
          </div>

          {/* 角色 */}
          {anime.characters && anime.characters.length > 0 && (
            <div><Space wrap size={[2,2]}>{anime.characters.map((c,i)=><Tag key={i} color="purple" style={{fontSize:10}}>{c}</Tag>)}</Space></div>
          )}

          {/* 标签编辑 */}
          <div>
            <Space wrap size={[4,4]}>
              {tags.map((t,i)=>(<Tag key={i} color={t.highlighted?'#fb7299':undefined} onClick={()=>toggleTag(i)} closable={editing} onClose={e=>{e.preventDefault();removeTag(i)}} style={{cursor:'pointer',fontSize:11}}>{t.name}</Tag>))}
            </Space>
            {editing && (
            <Space.Compact size="small" style={{marginTop:4}}>
              <Input size="small" placeholder="+标签" value={tagInput}
                onChange={e=>setTagInput(e.target.value)}
                onPressEnter={addTag}
                onFocus={() => setShowTagPicker(false)}
                style={{width:60}} />
              <Popover
                open={showTagPicker}
                onOpenChange={(v) => setShowTagPicker(v)}
                trigger="click"
                placement="bottomLeft"
                content={
                  <div style={{ maxWidth: 260, maxHeight: 240, overflowY: 'auto' }}>
                    {availableTags.length === 0 ? (
                      <span style={{ color: '#8b949e', fontSize: 12 }}>暂无可用标签</span>
                    ) : (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {availableTags.map(([name, count]) => (
                          <Tag key={name}
                            style={{ cursor: 'pointer', fontSize: 11 }}
                            onClick={() => selectTagFromPicker(name)}
                          >
                            {name}
                            <span style={{ fontSize: 10, opacity: 0.5, marginLeft: 2 }}>{count}</span>
                          </Tag>
                        ))}
                      </div>
                    )}
                  </div>
                }
              >
                <Button size="small" icon={<PlusOutlined />} onClick={addTag} />
              </Popover>
            </Space.Compact>
            )}
            {/* 智能打Tag（编辑模式） */}
            {editing && (
              <div style={{ marginTop: 6 }}>
                <Button
                  size="small"
                  icon={<TagOutlined />}
                  onClick={handleAutoTag}
                  loading={autoTagLoading}
                  style={{
                    background: '#21262d', borderColor: '#30363d',
                    color: '#8b949e', fontSize: 11,
                  }}
                >
                  🤖 智能打Tag
                </Button>
                {autoTagResult && autoTagResult.suggestedTags.length > 0 && (
                  <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {autoTagResult.suggestedTags.map((t) => (
                      <Tag
                        key={t.name}
                        color="blue"
                        style={{ cursor: 'pointer', fontSize: 11 }}
                        onClick={() => adoptTag(t.name)}
                        title={t.reason}
                      >
                        + {t.name}
                      </Tag>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

      </div>

      {/* 图片管理弹窗 */}
      <ImageManager
        anime={anime}
        open={imageManagerOpen}
        imgHeight={imgHeight}
        onClose={()=>{
          setImageManagerOpen(false);
          loadImages(anime.title).then(stored => {
            const storedUrls = stored.map(img => img.dataUrl);
            setAllImages(posterUrl ? [posterUrl, ...storedUrls] : storedUrls);
          });
        }}
        onSetPoster={(url)=>{
          setPosterUrl(url);
          savePosterOverride(anime.id, url).catch(e => console.error(e));
          onPosterChange?.(anime.id, url);
          savePosterUrlToExcel({ ...anime, posterUrl: url }).catch(e => console.error(e));
          loadImages(anime.title).then(stored => {
            const storedUrls = stored.map(img => img.dataUrl);
            setAllImages([url, ...storedUrls.filter(u => u !== url)]);
            setSlideIdx(0);
          });
        }}
        onDeletePoster={(url)=>{
          if (posterUrl === url) {
            addToPosterBlacklist(anime.id);
            savePosterOverride(anime.id, '').catch(e => console.error(e));
            onPosterChange?.(anime.id, '');
            loadImages(anime.title).then(stored => {
              const storedUrls = stored.map(img => img.dataUrl);
              const remaining = storedUrls.filter(u => u !== url);
              setPosterUrl(remaining[0] || '');
              setAllImages(remaining);
              setSlideIdx(0);
            });
          }
        }}
      />

    </Modal>
  );
};

export default AnimeDetailModal;
