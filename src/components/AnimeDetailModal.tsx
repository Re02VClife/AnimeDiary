import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Modal, InputNumber, Input, Tag, Descriptions, Button, Space, Tooltip, Select, Popover, Image, Typography, Checkbox, Slider, Segmented } from 'antd';
import { SaveOutlined, PlusOutlined, EditOutlined, LeftOutlined, RightOutlined, PictureOutlined, ImportOutlined, ThunderboltOutlined, TagOutlined, SearchOutlined } from '@ant-design/icons';
import type { AnimeEntry, AnimeTag, DimensionScore, DimensionReview, AnimeCategory, BangumiSearchItem, Dimension, DetailLayoutConfig } from '../types';
import { DEFAULT_DIMENSIONS, DIMENSION_LABEL_MAP, CATEGORY_CONFIG, DEFAULT_FIELD_CONFIG, DEFAULT_DETAIL_LAYOUT } from '../types';
import { getTemplate, loadTemplates, updateTemplate } from '../../features/anime-data/template-service';
import { catgirlMessage } from '../theme';
import type { TemplateFieldConfig } from '../types';
import { fetchPoster, savePosterUrlToExcel } from '../../features/anime-data/excel-service';
import { loadImages, saveImage as saveImageToLocal } from '../services/imageService';
import { addToPosterBlacklist, loadPosterBlacklist, savePosterOverride, loadPosterPositions, savePosterPosition } from '../../features/anime-data/storage-service';
import { singleAnimeAnalysis, autoTag } from '../../features/ai-analysis';
import type { SingleAnimeAnalysisResult, AutoTagResult } from '../../features/ai-analysis';
import { hasAIConfig } from '../../features/ai-analysis';
import RadarChart from './RadarChart';
import ImageManager from './ImageManager';
import ScoreSlider from '../../features/anime-detail/ScoreSlider';

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
  editMode?: boolean;
  radarMode?: 'percentile' | 'fixed';
  radarMin?: number;
}

const AnimeDetailModal: React.FC<AnimeDetailModalProps> = ({
  anime, open, onClose, onSave, onNavigate, allAnime = [], onPosterChange, imgHeight = 360,
  editMode = false, radarMode = 'percentile', radarMin,
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
  const [templateId, setTemplateId] = useState<string | undefined>();
  const [customFields, setCustomFields] = useState<Record<string, string | number>>({});
  const [link, setLink] = useState('');
  const [posterUrl, setPosterUrl] = useState('');
  const [allImages, setAllImages] = useState<string[]>([]);
  const [slideIdx, setSlideIdx] = useState(0);
  const [imageManagerOpen, setImageManagerOpen] = useState(false);
  const [posX, setPosX] = useState(50); // 海报焦点 X (0-100)
  const [posY, setPosY] = useState(50); // 海报焦点 Y (0-100)
  const [dragging, setDragging] = useState(false);
  const [previewVisible, setPreviewVisible] = useState(false); // 原图预览
  const [savingPoster, setSavingPoster] = useState(false); // 保存封面中

  // ── 布局自定义状态（编辑模式下可拖动调整） ──
  const [layoutCfg, setLayoutCfg] = useState<DetailLayoutConfig>(DEFAULT_DETAIL_LAYOUT);
  const [dragKey, setDragKey] = useState<string | null>(null); // 正在拖拽的区块 key
  const [dragOverKey, setDragOverKey] = useState<string | null>(null); // 拖拽悬停目标 key
  const [colDividerDragging, setColDividerDragging] = useState(false); // 正在拖动分栏分隔条
  const layoutSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      catgirlMessage.warning('请先在侧栏 AI 设置中配置 API Key');
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
      catgirlMessage.warning('请先在侧栏 AI 设置中配置 API Key');
      return;
    }
    setAutoTagLoading(true);
    setAutoTagResult(null);
    try {
      const result = await autoTag(anime);
      setAutoTagResult(result);
    } catch (e) {
      catgirlMessage.error(e instanceof Error ? e.message : '打标签失败');
    } finally {
      setAutoTagLoading(false);
    }
  };

  /** 采纳建议标签 */
  const adoptTag = (name: string) => {
    if (tags.some((t) => t.name === name)) {
      catgirlMessage.warning('标签已存在');
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
    catgirlMessage.success(`已添加标签「${name}」`);
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
      catgirlMessage.info('搜索暂不可用');
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
    catgirlMessage.success(`已导入「${name}」的信息`);
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
      catgirlMessage.success(`封面已保存到本地：${entry.fileName}`);
    } catch (e) {
      catgirlMessage.error('保存封面失败');
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
      setTemplateId(anime.templateId);
      setCustomFields(anime.customFields || {});
      setLink(anime.link || '');
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

  // editMode 时自动进入编辑状态（用于新增后直接编辑）
  useEffect(() => {
    if (open && editMode && anime) {
      setEditing(true);
    }
  }, [open, editMode, anime]);

  // 切换评分模板时：保留同名维度分数，新维度初始化为 0，旧维度丢弃
  useEffect(() => {
    if (!templateId) return;
    const t = getTemplate(templateId);
    if (!t) return;
    const newKeys = t.dimensions.map((d) => d.key);
    setScores((prev) => {
      const prevMap = new Map(prev.map((s) => [s.dimensionKey, s.score]));
      return newKeys.map((key) => ({
        dimensionKey: key,
        score: prevMap.get(key) ?? 0,
      }));
    });
  }, [templateId]);

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


  // 计算总评（使用当前选中模板的维度和权重）
  const overallScore = useMemo(() => {
    const tid = templateId;
    const t = tid ? getTemplate(tid) : null;
    const templateDims = t?.dimensions || DEFAULT_DIMENSIONS;
    const dims = templateDims.filter((d) => d.key !== 'overall' && d.weight > 0);
    let tw = 0, ws = 0;
    for (const dim of dims) {
      const score = scores.find((s) => s.dimensionKey === dim.key)?.score ?? 0;
      if (score > 0) { ws += score * dim.weight; tw += dim.weight; }
    }
    return tw > 0 ? (ws / tw).toFixed(2) : '-';
  }, [scores, templateId]);

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
    const tid = templateId;
    const t = tid ? getTemplate(tid) : null;
    const templateDims = t?.dimensions || DEFAULT_DIMENSIONS;
    const lines: string[] = [];

    // 总评（首行）
    const overallScoreVal = scores.find((sc) => sc.dimensionKey === 'overall')?.score;
    const overallScoreStr = overallScoreVal && overallScoreVal > 0 ? overallScoreVal.toFixed(2) : '-';
    lines.push(`${padRight('总评', 4)} ${overallScoreStr.padStart(5)}`);

    for (const dim of templateDims) {
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
    catgirlMessage.success(`已导入 ${lines.length} 个维度评分到评价`);
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
      if (tags.some((t) => t.name === name)) { catgirlMessage.warning('标签已存在'); return; }
      setTags((prev) => [...prev, { name, highlighted: true }]);
      setTagInput('');
    } else {
      // 无输入 → 弹出标签选择器
      setShowTagPicker(!showTagPicker);
    }
  };

  /** 从标签选择器中点选标签 */
  const selectTagFromPicker = (name: string) => {
    if (tags.some((t) => t.name === name)) { catgirlMessage.warning('标签已存在'); return; }
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
        templateId, customFields: Object.keys(customFields).length > 0 ? customFields : undefined,
        link: link.trim() || undefined,
        releaseDate: editReleaseDate || undefined,
        watchDate: editWatchDate || undefined,
        bangumiScore: editBgmScore,
        aniListScore: editAnilistScore,
        studio: editStudio || undefined,
        frameCount: editFrameCount,
        searchAlias: editSearchAlias || undefined,
        bangumiId: editBangumiId,
      });
      catgirlMessage.success('已保存到 Excel');
      setEditing(false);
    } catch (e) {
      catgirlMessage.error('保存失败：' + (e instanceof Error ? e.message : '未知错误'));
    } finally {
      setSaving(false);
    }
  };

  // 当前模板的字段配置（依赖本地 templateId 以支持即时切换）
  const templateCfg: TemplateFieldConfig = useMemo(() => {
    try {
      const tid = templateId;
      const t = tid ? getTemplate(tid) : null;
      return t?.fieldConfig || { ...DEFAULT_FIELD_CONFIG, customFields: [] };
    } catch { return { ...DEFAULT_FIELD_CONFIG, customFields: [] }; }
  }, [templateId]);

  // 当前模板的分类标签
  const categoryLabels = useMemo(() => {
    try {
      const tid = templateId;
      const t = tid ? getTemplate(tid) : null;
      if (!t?.categoryLabels || Object.keys(t.categoryLabels).length === 0) return CATEGORY_CONFIG;
      const merged = { ...CATEGORY_CONFIG };
      for (const [k, v] of Object.entries(t.categoryLabels)) {
        if (v && merged[k as AnimeCategory]) merged[k as AnimeCategory] = { ...merged[k as AnimeCategory], label: v };
      }
      return merged;
    } catch { return CATEGORY_CONFIG; }
  }, [templateId]);

  // 当前模板的展示维度（依赖本地 templateId 以支持即时切换）
  const displayDims = useMemo(() => {
    const tid = templateId;
    const t = tid ? getTemplate(tid) : null;
    return (t?.dimensions || DEFAULT_DIMENSIONS).filter((d) => d.key !== 'overall');
  }, [templateId]);

  // 当前模板的布局配置（缺省使用默认布局）
  const templateLayout = useMemo(() => {
    const tid = templateId;
    const t = tid ? getTemplate(tid) : null;
    return t?.layoutConfig || DEFAULT_DETAIL_LAYOUT;
  }, [templateId]);

  // 打开面板 / 切换模板时同步布局配置
  useEffect(() => {
    setLayoutCfg(structuredClone(templateLayout));
  }, [templateLayout]);

  // 布局变更防抖持久化到模板（仅在编辑模式且有模板时）
  useEffect(() => {
    if (!editing || !templateId) return;
    if (layoutSaveTimer.current) clearTimeout(layoutSaveTimer.current);
    layoutSaveTimer.current = setTimeout(() => {
      // 比较当前配置与模板原始配置，避免无变更写入
      if (JSON.stringify(layoutCfg) === JSON.stringify(templateLayout)) return;
      updateTemplate(templateId, { layoutConfig: layoutCfg });
    }, 500);
    return () => { if (layoutSaveTimer.current) clearTimeout(layoutSaveTimer.current); };
  }, [layoutCfg, editing, templateId, templateLayout]);

  // ── 拖拽排序处理 ──
  const handleDragStart = (key: string, column: 'left' | 'right') => (e: React.DragEvent) => {
    e.dataTransfer.setData('text/plain', key);
    e.dataTransfer.effectAllowed = 'move';
    setDragKey(key);
    setDragOverKey(null);
  };

  const handleDragOver = (key: string, column: 'left' | 'right') => (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragKey && dragKey !== key) {
      setDragOverKey(key);
    }
  };

  const handleDrop = (targetKey: string, column: 'left' | 'right') => (e: React.DragEvent) => {
    e.preventDefault();
    const srcKey = e.dataTransfer.getData('text/plain');
    if (!srcKey || srcKey === targetKey) { setDragKey(null); setDragOverKey(null); return; }

    const orderKey = column === 'left' ? 'leftOrder' : 'rightOrder';
    const currentOrder = [...layoutCfg[orderKey]];
    const srcIdx = currentOrder.indexOf(srcKey);
    const tgtIdx = currentOrder.indexOf(targetKey);

    if (srcIdx === -1 || tgtIdx === -1) { setDragKey(null); setDragOverKey(null); return; }

    // 移动源 key 到目标位置
    currentOrder.splice(srcIdx, 1);
    const newTgtIdx = currentOrder.indexOf(targetKey);
    currentOrder.splice(newTgtIdx, 0, srcKey);

    setLayoutCfg((prev) => ({ ...prev, [orderKey]: currentOrder }));
    setDragKey(null);
    setDragOverKey(null);
  };

  const handleDragEnd = () => {
    setDragKey(null);
    setDragOverKey(null);
  };

  // 获取区块在排序数组中的 order 值（用于 CSS order）
  const getSectionOrder = (key: string, column: 'left' | 'right'): number => {
    const orderArr = column === 'left' ? layoutCfg.leftOrder : layoutCfg.rightOrder;
    const idx = orderArr.indexOf(key);
    return idx === -1 ? 99 : idx;
  };

  if (!anime) return null;

  return (
    <Modal
      title={
        editing ? (
          <div>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Input value={editTitle} onChange={(e) => setEditTitle(e.target.value)}
                  style={{ fontSize: 23, fontWeight: 600, background: 'var(--bg-primary)', borderColor: 'var(--border-primary)', color: 'var(--text-primary)', width: 300 }} />
                <Input
                  size="small"
                  value={link}
                  onChange={(e) => setLink(e.target.value)}
                  placeholder="绑定链接（可选）"
                  style={{
                    width: 200, marginTop: 4,
                    background: 'var(--bg-primary)', borderColor: 'var(--border-primary)', color: 'var(--text-secondary)',
                    fontSize: 12,
                  }}
                />
                <Button
                  size="small"
                  icon={<SearchOutlined />}
                  loading={reSearching}
                  onClick={() => handleReSearch(false)}
                  style={{ background: 'var(--bg-quaternary)', borderColor: 'var(--border-primary)', color: 'var(--text-secondary)', fontSize: 11 }}
                >
                  重新检索
                </Button>
                <Button
                  size="small"
                  loading={reSearching}
                  onClick={() => handleReSearch(true)}
                  style={{ background: 'var(--bg-quaternary)', borderColor: 'var(--color-error)', color: 'var(--color-error)', fontSize: 11 }}
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
                      fontSize: 10, color: 'var(--brand-primary)', opacity: 0.6,
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
                    style={{ color: prevAnime ? 'var(--text-primary)' : 'var(--border-primary)', fontSize: 12, minWidth: 28 }}
                  />
                  <Button
                    size="small"
                    type="text"
                    icon={<RightOutlined />}
                    disabled={!nextAnime}
                    onClick={() => nextAnime && handleNavigate(nextAnime)}
                    title={nextAnime ? `下一个：${nextAnime.title}` : '已是最后一部'}
                    style={{ color: nextAnime ? 'var(--text-primary)' : 'var(--border-primary)', fontSize: 12, minWidth: 28 }}
                  />
                </div>
              </div>
            </div>
            {/* 检索结果列表 */}
            {showReSearch && (
              <div style={{
                marginTop: 8, maxHeight: 200, overflowY: 'auto',
                background: 'var(--bg-primary)', border: '1px solid #30363d', borderRadius: 8,
              }}>
                {reSearchResults.length === 0 && !reSearching ? (
                  <div style={{ padding: 12, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
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
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-secondary)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                    >
                      {item.images?.small && (
                        <img src={item.images.small} alt=""
                          style={{ width: 40, height: 54, objectFit: 'cover', borderRadius: 4, flexShrink: 0 }} />
                      )}
                      <div
                        style={{ flex: 1, minWidth: 0 }}
                      >
                        <div style={{ fontSize: 12, color: 'var(--text-primary)', fontWeight: 600 }}>
                          {item.name_cn || item.name}
                        </div>
                        {item.name_cn && item.name !== item.name_cn && (
                          <div style={{ fontSize: 10, color: 'var(--text-secondary)', opacity: 0.7 }}>
                            {item.name}
                          </div>
                        )}
                        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1 }}>
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
                            <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)', marginBottom: 2 }}>
                              {item.name_cn || item.name}
                            </div>
                            {item.name_cn && item.name !== item.name_cn && (
                              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6 }}>
                                {item.name}
                              </div>
                            )}
                            <div style={{ display: 'flex', gap: 12, marginBottom: 6, fontSize: 11, color: 'var(--text-secondary)' }}>
                              {item.air_date && <span>📅 {item.air_date}</span>}
                              {item.eps > 0 && <span>📺 {item.eps}集</span>}
                              {item.rating?.score > 0 && (
                                <span style={{ color: 'var(--brand-primary)', fontWeight: 600 }}>
                                  ⭐ {item.rating.score}
                                  {item.rating.total > 0 && ` (${item.rating.total}人)`}
                                </span>
                              )}
                            </div>
                            {item.summary && (
                              <Paragraph
                                ellipsis={{ rows: 8, expandable: true, symbol: '展开' }}
                                style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.7, marginBottom: 0 }}
                              >
                                {item.summary}
                              </Paragraph>
                            )}
                            <div style={{ marginTop: 6, fontSize: 10, color: 'var(--text-muted)' }}>
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
                            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
                              选择导入项
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
                              <Checkbox checked={importChecks.title} onChange={(e) => setImportChecks((c) => ({ ...c, title: e.target.checked }))}>
                                <span style={{ fontSize: 12, color: 'var(--text-primary)' }}>主标题</span>
                                <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 4 }}>{item.name_cn || item.name}</span>
                              </Checkbox>
                              {item.name_cn && item.name !== item.name_cn && (
                                <Checkbox checked={importChecks.searchAlias} onChange={(e) => setImportChecks((c) => ({ ...c, searchAlias: e.target.checked }))}>
                                  <span style={{ fontSize: 12, color: 'var(--text-primary)' }}>检索名</span>
                                  <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 4 }}>{item.name}</span>
                                </Checkbox>
                              )}
                              {item.rating?.score > 0 && (
                                <Checkbox checked={importChecks.bgmScore} onChange={(e) => setImportChecks((c) => ({ ...c, bgmScore: e.target.checked }))}>
                                  <span style={{ fontSize: 12, color: 'var(--text-primary)' }}>评分</span>
                                  <span style={{ fontSize: 10, color: 'var(--brand-primary)', marginLeft: 4 }}>{item.rating.score}分</span>
                                </Checkbox>
                              )}
                              {item.images?.large && (
                                <Checkbox checked={importChecks.poster} onChange={(e) => setImportChecks((c) => ({ ...c, poster: e.target.checked }))}>
                                  <span style={{ fontSize: 12, color: 'var(--text-primary)' }}>海报图</span>
                                </Checkbox>
                              )}
                              {item.air_date && (
                                <Checkbox checked={importChecks.date} onChange={(e) => setImportChecks((c) => ({ ...c, date: e.target.checked }))}>
                                  <span style={{ fontSize: 12, color: 'var(--text-primary)' }}>上映日期</span>
                                  <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 4 }}>{item.air_date}</span>
                                </Checkbox>
                              )}
                              {item.summary && (
                                <Checkbox checked={importChecks.summary} onChange={(e) => setImportChecks((c) => ({ ...c, summary: e.target.checked }))}>
                                  <span style={{ fontSize: 12, color: 'var(--text-primary)' }}>简介→评价</span>
                                </Checkbox>
                              )}
                              {item.id && item.source === 'bangumi' && (
                                <Checkbox checked={importChecks.bangumiId} onChange={(e) => setImportChecks((c) => ({ ...c, bangumiId: e.target.checked }))}>
                                  <span style={{ fontSize: 12, color: 'var(--text-primary)' }}>BGM ID</span>
                                  <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 4 }}>#{item.id}</span>
                                </Checkbox>
                              )}
                            </div>
                            <Button type="primary" block size="small" onClick={(e) => { e.stopPropagation(); doImport(); }}
                              style={{ background: 'var(--brand-primary)', borderColor: 'var(--brand-primary)', fontWeight: 600 }}>
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
                  background: 'var(--bg-primary)', borderColor: 'var(--border-primary)', color: 'var(--text-secondary)',
                }}
              />
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
            <div>
              {anime.link ? (
                <a href={anime.link} target="_blank" rel="noopener noreferrer"
                  style={{ fontSize: 23, fontWeight: 600, color: 'var(--text-primary)', textDecoration: 'none', borderBottom: '2px dashed #30363d' }}
                  title={`打开：${anime.link}`}>
                  {anime.title} 🔗
                </a>
              ) : (
                <span style={{ fontSize: 23, fontWeight: 600 }}>
                  {anime.title}
                </span>
              )}
              {/* 副标题：检索名或日文名 */}
              {(anime.searchAlias || anime.titleJa) && (
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', opacity: 0.7, marginTop: 2 }}>
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
                    fontSize: 10, color: 'var(--brand-primary)', opacity: 0.6,
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
                  style={{ color: prevAnime ? 'var(--text-primary)' : 'var(--border-primary)', fontSize: 12, minWidth: 28 }}
                />
                <Button
                  size="small"
                  type="text"
                  icon={<RightOutlined />}
                  disabled={!nextAnime}
                  onClick={() => nextAnime && handleNavigate(nextAnime)}
                  title={nextAnime ? `下一个：${nextAnime.title}` : '已是最后一部'}
                  style={{ color: nextAnime ? 'var(--text-primary)' : 'var(--border-primary)', fontSize: 12, minWidth: 28 }}
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
          <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
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
      {/* ── 上部：基本信息（横向，按模板字段配置显示） ── */}
      <Descriptions size="small" column={4} style={{ marginBottom: 12 }}>
        {templateCfg.showReleaseDate && (
          <Descriptions.Item label="上映">
            {editing ? (
              <Input size="small" value={editReleaseDate} onChange={(e) => setEditReleaseDate(e.target.value)}
                placeholder="如 2021-04" style={{ width: 100, background: 'var(--bg-primary)', borderColor: 'var(--border-primary)', color: 'var(--text-primary)' }} />
            ) : (anime.releaseDate || '-')}
          </Descriptions.Item>
        )}
        <Descriptions.Item label="观看时间">
          {editing ? (
            <Input size="small" value={editWatchDate} onChange={(e) => setEditWatchDate(e.target.value)}
              placeholder="如 2024-03-15" style={{ width: 110, background: 'var(--bg-primary)', borderColor: 'var(--border-primary)', color: 'var(--text-primary)' }} />
          ) : (anime.watchDate || anime.createdAt || '-')}
        </Descriptions.Item>
        {templateCfg.showBangumiId && (
          <Descriptions.Item label="Bangumi">
            {editing ? (
              <InputNumber size="small" min={0} max={15} step={0.1}
                value={editBgmScore} onChange={(v) => setEditBgmScore(v ?? undefined)}
                style={{ width: 70 }} />
            ) : (anime.bangumiScore ? <span style={{ color: 'var(--brand-primary)', fontWeight: 600 }}>{anime.bangumiScore}</span> : '-')}
          </Descriptions.Item>
        )}
        {templateCfg.showAnilistScore && (
          <Descriptions.Item label="AniList">
            {editing ? (
              <InputNumber size="small" min={0} max={15} step={0.1}
                value={editAnilistScore} onChange={(v) => setEditAnilistScore(v ?? undefined)}
                style={{ width: 70 }} />
            ) : (anime.aniListScore ? <span style={{ color: 'var(--color-info)', fontWeight: 600 }}>{anime.aniListScore}</span> : '-')}
          </Descriptions.Item>
        )}
        {templateCfg.showStudio && (
          <Descriptions.Item label="制作组">
            {editing ? (
              <Input size="small" value={editStudio} onChange={(e) => setEditStudio(e.target.value)}
                placeholder="制作组" style={{ width: 120, background: 'var(--bg-primary)', borderColor: 'var(--border-primary)', color: 'var(--text-primary)' }} />
            ) : (anime.studio || '-')}
          </Descriptions.Item>
        )}
        {templateCfg.showFrameCount && (
          <Descriptions.Item label="张数">
            {editing ? (
              <InputNumber size="small" min={0} step={1}
                value={editFrameCount} onChange={(v) => setEditFrameCount(v ?? undefined)}
                placeholder="数量" style={{ width: 90 }} />
            ) : (anime.frameCount ? <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{anime.frameCount.toLocaleString()}</span> : '-')}
          </Descriptions.Item>
        )}
        {templateCfg.showEpisodes && (
          <Descriptions.Item label="集数">
            {editing ? (
              <InputNumber size="small" min={0} step={1}
                value={undefined /* TODO: add episodes state */} style={{ width: 70 }} />
            ) : (anime.episodes ? <span>{anime.episodes} 集</span> : '-')}
          </Descriptions.Item>
        )}
        {/* 模板自定义字段 */}
        {(templateCfg.customFields || []).map((cf) => (
          <Descriptions.Item key={cf.key} label={cf.label}>
            {editing ? (
              cf.type === 'number' ? (
                <InputNumber size="small" step={1}
                  value={customFields[cf.key] ? Number(customFields[cf.key]) : undefined}
                  onChange={(v) => setCustomFields((prev) => ({ ...prev, [cf.key]: v ?? '' }))}
                  style={{ width: 90 }} />
              ) : (
                <Input size="small"
                  value={String(customFields[cf.key] || '')}
                  onChange={(e) => setCustomFields((prev) => ({ ...prev, [cf.key]: e.target.value }))}
                  style={{ width: 120, background: 'var(--bg-primary)', borderColor: 'var(--border-primary)', color: 'var(--text-primary)' }} />
              )
            ) : (customFields[cf.key] ? <span style={{ color: 'var(--text-primary)' }}>{customFields[cf.key]}</span> : '-')}
          </Descriptions.Item>
        ))}
        <Descriptions.Item label="分类">
          <Select
            size="small"
            value={category}
            onChange={(v) => setCategory(v)}
            disabled={!editing}
            style={{ width: 80 }}
            options={Object.entries(categoryLabels).map(([key, cfg]) => ({ value: key, label: cfg.label }))}
          />
        </Descriptions.Item>
        <Descriptions.Item label="评分模板">
          <Select
            size="small"
            value={templateId || 'default'}
            onChange={(v) => setTemplateId(v === 'default' ? undefined : v)}
            disabled={!editing}
            style={{ width: 120 }}
            options={loadTemplates().map((t) => ({ value: t.id, label: t.name }))}
          />
        </Descriptions.Item>
      </Descriptions>

      <div style={{ display: 'flex', gap: editing ? 4 : 24, minHeight: 600, position: 'relative' }}>
        {/* ── 左侧栏（宽度可拖动调整） ── */}
        <div style={{ flex: layoutCfg.leftRatio / (100 - layoutCfg.leftRatio), display: 'flex', flexDirection: 'column' }}>
          {/* 雷达图（上方） */}
          <div
            data-section-key="radar"
            style={{
              order: getSectionOrder('radar', 'left'),
              border: dragOverKey === 'radar' ? '2px dashed #fb7299' : '2px solid transparent',
              borderRadius: dragOverKey === 'radar' ? 8 : 0,
              padding: editing ? 4 : 0,
              transition: 'border 0.15s, border-radius 0.15s',
            }}
            onDragOver={editing ? handleDragOver('radar', 'left') : undefined}
            onDrop={editing ? handleDrop('radar', 'left') : undefined}
          >
            {editing && (
              <div draggable onDragStart={handleDragStart('radar', 'left')} onDragEnd={handleDragEnd}
                style={{ cursor: 'grab', color: 'var(--text-muted)', fontSize: 14, textAlign: 'center', padding: '1px 0', userSelect: 'none', lineHeight: 1 }}>
                ⠿
              </div>
            )}
            <div style={{ height: 300, marginBottom: editing ? 0 : 14 }}>
              <RadarChart anime={anime} allAnime={allAnime} templateId={templateId} radarMode={radarMode} radarMin={radarMin} />
            </div>
          </div>

          {/* 维度评分编辑 */}
          <div
            data-section-key="scores"
            style={{
              order: getSectionOrder('scores', 'left'),
              border: dragOverKey === 'scores' ? '2px dashed #fb7299' : '2px solid transparent',
              borderRadius: dragOverKey === 'scores' ? 8 : 0,
              padding: editing ? 4 : 0,
              marginBottom: 10,
              transition: 'border 0.15s, border-radius 0.15s',
            }}
            onDragOver={editing ? handleDragOver('scores', 'left') : undefined}
            onDrop={editing ? handleDrop('scores', 'left') : undefined}
          >
            {editing && (
              <div draggable onDragStart={handleDragStart('scores', 'left')} onDragEnd={handleDragEnd}
                style={{ cursor: 'grab', color: 'var(--text-muted)', fontSize: 14, textAlign: 'center', padding: '1px 0', userSelect: 'none', lineHeight: 1 }}>
                ⠿
              </div>
            )}
            <span style={{ fontWeight: 600, fontSize: 14, display: 'block', marginBottom: 6 }}>
              📊 维度评分
              <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--brand-primary)', marginLeft: 12 }}>总评 {overallScore}</span>
              {editing && (
                <Tooltip title="将全部维度评分+专项评价按模板导入到评价底部">
                  <Button size="small" type="text" icon={<ImportOutlined />}
                    onClick={importAllDimsToReview}
                    style={{ color: 'var(--text-secondary)', marginLeft: 8, fontSize: 12 }}>
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
                      <span style={{ fontSize: 12, color: 'var(--text-primary)', minWidth: 36, textAlign: 'right', cursor: 'help' }}>
                        {dim.label}
                      </span>
                    </Tooltip>
                    <InputNumber size="small" min={0} max={15}
                      step={dim.key === 'vibe' ? 0.01 : 0.1}
                      precision={dim.key === 'vibe' ? 2 : undefined}
                      value={score || null} onChange={(v) => handleScoreChange(dim.key, v)}
                      disabled={!editing}
                      onFocus={() => { if (editing) setSliderDim(dim.key); }}
                      style={{
                        width: dim.key === 'vibe' ? 64 : 56,
                        borderColor: isSliderActive ? 'var(--brand-primary)' : undefined,
                      }} placeholder="0" />
                    {editing && (
                      <span onClick={(e) => { e.stopPropagation(); setEditingDimReview(editingDimReview === dim.key ? null : dim.key); }}
                        style={{ cursor: 'pointer', color: hasReview ? 'var(--brand-primary)' : 'var(--text-muted)', fontSize: 12 }}>
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
                    color: 'var(--brand-primary)',
                    fontWeight: 600,
                    fontSize: 12,
                  }}
                >
                  🤖 深度分析
                </Button>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 8 }}>
                  AI 分析这部番为什么打动你（约 800 token / ¥0.002）
                </span>

                {/* 错误提示 */}
                {aiAnalysisError && (
                  <div style={{ marginTop: 8, color: 'var(--color-error)', fontSize: 11 }}>
                    {aiAnalysisError}
                    <Button type="link" size="small" onClick={handleAIAnalysis}
                      style={{ color: 'var(--brand-primary)', fontSize: 11, padding: 0, marginLeft: 6 }}>
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
                        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--brand-primary)', marginBottom: 4 }}>
                          🎯 核心吸引力
                        </div>
                        {aiAnalysisResult.coreAppeal.map((item, i) => (
                          <div key={i} style={{
                            background: 'var(--bg-secondary)', border: '1px solid #30363d',
                            borderRadius: 6, padding: '8px 12px', marginBottom: 4,
                          }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>{item.aspect}</span>
                              <Tag color="pink" style={{ fontSize: 9, lineHeight: '16px', margin: 0 }}>
                                {Math.round(item.confidence * 100)}%
                              </Tag>
                            </div>
                            <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{item.evidence}</div>
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
                        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-info)' }}>📡 电波模式：</span>
                        <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{aiAnalysisResult.vibePattern}</span>
                      </div>
                    )}

                    {/* 社区差异 */}
                    {aiAnalysisResult.communityGap && aiAnalysisResult.communityGap !== '无社区对比数据' && (
                      <div style={{
                        background: 'linear-gradient(135deg, rgba(255,179,71,0.08), rgba(255,179,71,0.02))',
                        border: '1px solid rgba(255,179,71,0.12)',
                        borderRadius: 6, padding: '8px 12px',
                      }}>
                        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-warning)' }}>🌐 社区差异：</span>
                        <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{aiAnalysisResult.communityGap}</span>
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
                            fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.6,
                            padding: '2px 8px', borderLeft: '2px solid #a371f7', marginBottom: 3,
                          }}>
                            <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{item.title}</span> — {item.why}
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
            <div style={{ marginBottom: 10, padding: 8, background: 'var(--bg-tertiary)', borderRadius: 6, border: '1px solid #30363d' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--brand-primary)', marginBottom: 4 }}>
                {DIMENSION_LABEL_MAP[editingDimReview] || editingDimReview} 专项评价
              </div>
              <TextArea value={getDimReview(editingDimReview)}
                onChange={(e) => setDimReview(editingDimReview, e.target.value)}
                placeholder="对该维度的专项评价…" rows={2}
                style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-primary)', color: 'var(--text-primary)' }} />
            </div>
          )}

          {/* 全局评价 */}
          <div
            data-section-key="review"
            style={{
              order: getSectionOrder('review', 'left'),
              border: dragOverKey === 'review' ? '2px dashed #fb7299' : '2px solid transparent',
              borderRadius: dragOverKey === 'review' ? 8 : 0,
              padding: editing ? 4 : 0,
              transition: 'border 0.15s, border-radius 0.15s',
            }}
            onDragOver={editing ? handleDragOver('review', 'left') : undefined}
            onDrop={editing ? handleDrop('review', 'left') : undefined}
          >
            {editing && (
              <div draggable onDragStart={handleDragStart('review', 'left')} onDragEnd={handleDragEnd}
                style={{ cursor: 'grab', color: 'var(--text-muted)', fontSize: 14, textAlign: 'center', padding: '1px 0', userSelect: 'none', lineHeight: 1 }}>
                ⠿
              </div>
            )}
            <span style={{ fontWeight: 600, fontSize: 14, display: 'block', marginBottom: 6 }}>📝 评价</span>
            <TextArea value={review} onChange={(e) => setReview(e.target.value)}
              placeholder="写下你对这部番的评价…" rows={5}
              readOnly={!editing}
              style={{ background: editing ? 'var(--bg-tertiary)' : 'var(--bg-secondary)', borderColor: 'var(--border-primary)', color: 'var(--text-primary)' }} />
          </div>
        </div>

        {/* 分栏拖拽分隔条（仅编辑模式） */}
        {editing && (
          <div
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('text/plain', 'divider');
              e.dataTransfer.effectAllowed = 'move';
              (e.currentTarget as HTMLElement).style.background = 'var(--brand-primary)';
            }}
            onDrag={(e) => {
              if (e.clientX === 0) return;
              const container = (e.currentTarget as HTMLElement).parentElement;
              if (!container) return;
              const rect = container.getBoundingClientRect();
              const pct = ((e.clientX - rect.left) / rect.width) * 100;
              setLayoutCfg((prev) => ({ ...prev, leftRatio: Math.round(Math.min(80, Math.max(30, pct))) }));
            }}
            onDragEnd={(e) => {
              (e.currentTarget as HTMLElement).style.background = '';
            }}
            style={{
              width: 12, cursor: 'col-resize', flexShrink: 0,
              background: colDividerDragging ? 'var(--brand-primary)' : 'transparent',
              borderRadius: 3, transition: 'background 0.15s',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(251,114,153,0.2)'; }}
            onMouseLeave={(e) => { if (!colDividerDragging) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
            onMouseDown={() => setColDividerDragging(true)}
            onMouseUp={() => setColDividerDragging(false)}
          >
            <div style={{ width: 3, height: 40, borderRadius: 2, background: 'rgba(251,114,153,0.4)' }} />
          </div>
        )}

        {/* ── 右侧栏：海报轮播 + 标签 ── */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* 海报轮播 */}
          <div
            data-section-key="poster"
            style={{
              order: getSectionOrder('poster', 'right'),
              border: dragOverKey === 'poster' ? '2px dashed #fb7299' : '2px solid transparent',
              borderRadius: dragOverKey === 'poster' ? 8 : 0,
              padding: editing ? 4 : 0,
              transition: 'border 0.15s, border-radius 0.15s',
            }}
            onDragOver={editing ? handleDragOver('poster', 'right') : undefined}
            onDrop={editing ? handleDrop('poster', 'right') : undefined}
          >
            {editing && (
              <div draggable onDragStart={handleDragStart('poster', 'right')} onDragEnd={handleDragEnd}
                style={{ cursor: 'grab', color: 'var(--text-muted)', fontSize: 14, textAlign: 'center', padding: '1px 0', userSelect: 'none', lineHeight: 1 }}>
                ⠿
              </div>
            )}
            <div style={{
              position: 'relative', width: `${layoutCfg.posterWidth}%`, aspectRatio: layoutCfg.posterAspectRatio,
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
                <span style={{ fontSize: '4rem', color: 'var(--brand-primary)', opacity: 0.4 }}>🎬</span>
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
                {allImages.map((_,i)=><div key={i} style={{ width:6,height:6,borderRadius:'50%',background:i===slideIdx?'var(--brand-primary)':'rgba(255,255,255,0.4)' }} />)}
              </div>
            </>)}
            {allImages[slideIdx]===posterUrl && allImages.length>0 && (
              <div style={{ position:'absolute',top:6,left:6,background:'rgba(251,114,153,0.85)',borderRadius:4,padding:'1px 6px',fontSize:10,color:'#fff',fontWeight:600 }}>封面</div>
            )}
          </div>
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

          {/* 海报布局控件（仅编辑模式） */}
          {editing && (
            <div style={{ padding: '6px 8px', background: 'var(--bg-tertiary)', borderRadius: 6, border: '1px solid #30363d' }}>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>🖼️ 海报宽度</div>
              <Slider
                min={30} max={100} step={5}
                value={layoutCfg.posterWidth}
                onChange={(v) => setLayoutCfg((prev) => ({ ...prev, posterWidth: v }))}
                tooltip={{ formatter: (v) => `${v}%` }}
                style={{ margin: '0 0 6px' }}
              />
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>宽高比</div>
              <Segmented
                size="small"
                value={layoutCfg.posterAspectRatio}
                onChange={(v) => setLayoutCfg((prev) => ({ ...prev, posterAspectRatio: v as DetailLayoutConfig['posterAspectRatio'] }))}
                options={[
                  { value: '3/4', label: '3:4' },
                  { value: '2/3', label: '2:3' },
                  { value: '16/9', label: '16:9' },
                  { value: '1/1', label: '1:1' },
                ]}
                block
                style={{ background: 'var(--bg-primary)' }}
              />
            </div>
          )}

          {/* 角色（按模板配置显示） */}
          {templateCfg.showCharacters && anime.characters && anime.characters.length > 0 && (
            <div
              data-section-key="characters"
              style={{
                order: getSectionOrder('characters', 'right'),
                border: dragOverKey === 'characters' ? '2px dashed #fb7299' : '2px solid transparent',
                borderRadius: dragOverKey === 'characters' ? 8 : 0,
                padding: editing ? 4 : 0,
                transition: 'border 0.15s, border-radius 0.15s',
              }}
              onDragOver={editing ? handleDragOver('characters', 'right') : undefined}
              onDrop={editing ? handleDrop('characters', 'right') : undefined}
            >
              {editing && (
                <div draggable onDragStart={handleDragStart('characters', 'right')} onDragEnd={handleDragEnd}
                  style={{ cursor: 'grab', color: 'var(--text-muted)', fontSize: 14, textAlign: 'center', padding: '1px 0', userSelect: 'none', lineHeight: 1 }}>
                  ⠿
                </div>
              )}
              <Space wrap size={[2,2]}>{anime.characters.map((c,i)=><Tag key={i} color="purple" style={{fontSize:10}}>{c}</Tag>)}</Space>
            </div>
          )}

          {/* 标签编辑 */}
          <div
            data-section-key="tags"
            style={{
              order: getSectionOrder('tags', 'right'),
              border: dragOverKey === 'tags' ? '2px dashed #fb7299' : '2px solid transparent',
              borderRadius: dragOverKey === 'tags' ? 8 : 0,
              padding: editing ? 4 : 0,
              transition: 'border 0.15s, border-radius 0.15s',
            }}
            onDragOver={editing ? handleDragOver('tags', 'right') : undefined}
            onDrop={editing ? handleDrop('tags', 'right') : undefined}
          >
            {editing && (
              <div draggable onDragStart={handleDragStart('tags', 'right')} onDragEnd={handleDragEnd}
                style={{ cursor: 'grab', color: 'var(--text-muted)', fontSize: 14, textAlign: 'center', padding: '1px 0', userSelect: 'none', lineHeight: 1 }}>
                ⠿
              </div>
            )}
            <div>
            <Space wrap size={[4,4]}>
              {tags.map((t,i)=>(<Tag key={i} color={t.highlighted?'var(--brand-primary)':undefined} onClick={()=>toggleTag(i)} closable={editing} onClose={e=>{e.preventDefault();removeTag(i)}} style={{cursor:'pointer',fontSize:11}}>{t.name}</Tag>))}
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
                      <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>暂无可用标签</span>
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
                    background: 'var(--bg-quaternary)', borderColor: 'var(--border-primary)',
                    color: 'var(--text-secondary)', fontSize: 11,
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
