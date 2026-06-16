import { useState, useEffect, useMemo, useRef } from 'react';
import { Modal, InputNumber, Input, Tag, Descriptions, Button, Space, message, Tooltip, Select, Popover, Image } from 'antd';
import { SaveOutlined, PlusOutlined, EditOutlined, LeftOutlined, RightOutlined, PictureOutlined, ImportOutlined } from '@ant-design/icons';
import type { AnimeEntry, AnimeTag, DimensionScore, DimensionReview, AnimeCategory } from '../types';
import { DEFAULT_DIMENSIONS, DIMENSION_LABEL_MAP, CATEGORY_CONFIG } from '../types';
import { fetchPoster } from '../services/excelService';
import { loadImages, saveImage as saveImageToLocal } from '../services/imageService';
import { addToPosterBlacklist, loadPosterBlacklist, savePosterOverride, loadPosterPositions, savePosterPosition } from '../services/storageService';
import RadarChart from './RadarChart';
import ImageManager from './ImageManager';

const { TextArea } = Input;

interface AnimeDetailModalProps {
  anime: AnimeEntry | null;
  open: boolean;
  onClose: () => void;
  onSave: (entry: AnimeEntry) => Promise<void>;
  allAnime?: AnimeEntry[];
  onPosterChange?: (animeId: string, posterUrl: string) => void;
  imgHeight?: number;
}

const AnimeDetailModal: React.FC<AnimeDetailModalProps> = ({
  anime, open, onClose, onSave, allAnime = [], onPosterChange, imgHeight = 360,
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

  // 编辑中的基本信息
  const [editTitle, setEditTitle] = useState('');
  const [editReleaseDate, setEditReleaseDate] = useState('');
  const [editBgmScore, setEditBgmScore] = useState<number | undefined>();
  const [editStudio, setEditStudio] = useState('');
  const [posterUrl, setPosterUrl] = useState('');
  const [allImages, setAllImages] = useState<string[]>([]);
  const [slideIdx, setSlideIdx] = useState(0);
  const [imageManagerOpen, setImageManagerOpen] = useState(false);
  const [posX, setPosX] = useState(50); // 海报焦点 X (0-100)
  const [posY, setPosY] = useState(50); // 海报焦点 Y (0-100)
  const [dragging, setDragging] = useState(false);
  const [previewVisible, setPreviewVisible] = useState(false); // 原图预览
  const [savingPoster, setSavingPoster] = useState(false); // 保存封面中

  /** 将外部封面（AniList CDN）保存到本地 */
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
      setEditTitle(anime.title);
      setEditReleaseDate(anime.releaseDate || '');
      setEditBgmScore(anime.bangumiScore);
      setEditStudio(anime.studio || '');
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
        bangumiScore: editBgmScore,
        studio: editStudio || undefined,
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
          <Input value={editTitle} onChange={(e) => setEditTitle(e.target.value)}
            style={{ fontSize: 18, fontWeight: 600, background: '#0d1117', borderColor: '#30363d', color: '#e6edf3', width: 300 }} />
        ) : (
          <span style={{ fontSize: 18, fontWeight: 600 }}>
            {anime.title}
            {anime.titleJa && <span style={{ fontSize: 13, color: '#8b949e', marginLeft: 8 }}>{anime.titleJa}</span>}
          </span>
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
                    setEditBgmScore(anime.bangumiScore);
                    setEditStudio(anime.studio || '');
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
        <Descriptions.Item label="Bangumi">
          {editing ? (
            <InputNumber size="small" min={0} max={10} step={0.1}
              value={editBgmScore} onChange={(v) => setEditBgmScore(v ?? undefined)}
              style={{ width: 70 }} />
          ) : (anime.bangumiScore ? <span style={{ color: '#fb7299', fontWeight: 600 }}>{anime.bangumiScore}</span> : '-')}
        </Descriptions.Item>
        <Descriptions.Item label="制作组">
          {editing ? (
            <Input size="small" value={editStudio} onChange={(e) => setEditStudio(e.target.value)}
              placeholder="动画公司" style={{ width: 120, background: '#0d1117', borderColor: '#30363d', color: '#e6edf3' }} />
          ) : (anime.studio || '-')}
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
                return (
                  <div key={dim.key} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
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
                      style={{ width: dim.key === 'vibe' ? 64 : 56 }} placeholder="0" />
                    {editing && (
                      <span onClick={() => setEditingDimReview(editingDimReview === dim.key ? null : dim.key)}
                        style={{ cursor: 'pointer', color: hasReview ? '#fb7299' : '#484f58', fontSize: 12 }}>
                        <EditOutlined />
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
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
