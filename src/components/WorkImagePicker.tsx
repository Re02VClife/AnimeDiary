/**
 * 从绑定作品选取图片 — 角色卡图片管理用
 *   列出已绑定作品的本地图片库 → 点击进入框选 → 拖拽框选显示范围 → canvas 裁剪保存到角色图片目录
 */
import { useState, useEffect, useRef } from 'react';
import { Modal, Button, Spin, message } from 'antd';
import { LeftOutlined, CheckOutlined, ClearOutlined } from '@ant-design/icons';
import type { ImageEntry } from '../types';
import { loadImages, saveImage } from '../services/imageService';

interface WorkImagePickerProps {
  /** 已绑定的作品名列表 */
  works: string[];
  /** 角色名（裁剪结果保存到该图片目录） */
  characterTitle: string;
  open: boolean;
  onClose: () => void;
  onSaved: (entry: ImageEntry) => void;
}

interface SelRect { x: number; y: number; w: number; h: number }

const WorkImagePicker: React.FC<WorkImagePickerProps> = ({ works, characterTitle, open, onClose, onSaved }) => {
  const [workImages, setWorkImages] = useState<Record<string, ImageEntry[]>>({});
  const [loading, setLoading] = useState(false);
  const [cropTarget, setCropTarget] = useState<ImageEntry | null>(null);
  // 框选状态（相对图片显示区域的像素坐标）
  const [sel, setSel] = useState<SelRect | null>(null);
  const [saving, setSaving] = useState(false);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // 打开时并行加载各绑定作品的图片列表
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    Promise.all(works.map(async (w) => [w, await loadImages(w)] as const))
      .then((pairs) => setWorkImages(Object.fromEntries(pairs)))
      .finally(() => setLoading(false));
  }, [open, works]);

  /** 鼠标位置 → 限制在图片显示区域内的坐标 */
  const clampPos = (e: React.MouseEvent): { x: number; y: number } => {
    const rect = wrapRef.current!.getBoundingClientRect();
    return {
      x: Math.min(Math.max(e.clientX - rect.left, 0), rect.width),
      y: Math.min(Math.max(e.clientY - rect.top, 0), rect.height),
    };
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const p = clampPos(e);
    dragStartRef.current = p;
    setSel({ x: p.x, y: p.y, w: 0, h: 0 });
  };
  const handleMouseMove = (e: React.MouseEvent) => {
    const start = dragStartRef.current;
    if (!start) return;
    const p = clampPos(e);
    setSel({
      x: Math.min(start.x, p.x),
      y: Math.min(start.y, p.y),
      w: Math.abs(p.x - start.x),
      h: Math.abs(p.y - start.y),
    });
  };
  const handleMouseUp = () => { dragStartRef.current = null; };

  const hasSel = !!(sel && sel.w > 4 && sel.h > 4);
  // 选区对应的原图像素尺寸（按钮提示用）
  const selNatural = hasSel && imgRef.current
    ? `${Math.round(sel!.w * imgRef.current.naturalWidth / imgRef.current.clientWidth)} × ${Math.round(sel!.h * imgRef.current.naturalHeight / imgRef.current.clientHeight)}`
    : '';

  /** 裁剪选区（无有效选区 = 整图）并保存到角色图片目录 */
  const handleSave = async () => {
    const img = imgRef.current;
    if (!img || !img.naturalWidth) return;
    const scaleX = img.naturalWidth / img.clientWidth;
    const scaleY = img.naturalHeight / img.clientHeight;
    const r = hasSel ? sel! : { x: 0, y: 0, w: img.clientWidth, h: img.clientHeight };
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(r.w * scaleX));
    canvas.height = Math.max(1, Math.round(r.h * scaleY));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(img, r.x * scaleX, r.y * scaleY, r.w * scaleX, r.h * scaleY, 0, 0, canvas.width, canvas.height);
    setSaving(true);
    try {
      const entry = await saveImage(canvas.toDataURL('image/png'), characterTitle);
      onSaved(entry);
      // 保存后返回选图列表，可继续选取其他图片
      setCropTarget(null);
      setSel(null);
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={cropTarget ? `✂️ 框选显示范围 — ${cropTarget.fileName}` : '🖼️ 从绑定作品选取图片'}
      open={open}
      onCancel={onClose}
      width={900}
      footer={null}
      styles={{ body: { maxHeight: '75vh', overflowY: 'auto' } }}
    >
      {cropTarget ? (
        <div>
          <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Button size="small" icon={<LeftOutlined />} onClick={() => { setCropTarget(null); setSel(null); }}>返回</Button>
            <Button size="small" icon={<ClearOutlined />} disabled={!hasSel} onClick={() => setSel(null)}>清除选区</Button>
            <Button size="small" type="primary" icon={<CheckOutlined />} loading={saving} onClick={handleSave}>
              {hasSel ? `保存选区 (${selNatural})` : '保存整图'}
            </Button>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>在图上拖拽框选要显示的范围，不框选则保存整图</span>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div
              ref={wrapRef}
              style={{ position: 'relative', display: 'inline-block', overflow: 'hidden', cursor: 'crosshair', userSelect: 'none', lineHeight: 0 }}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
            >
              <img
                ref={imgRef}
                src={cropTarget.dataUrl}
                alt={cropTarget.fileName}
                draggable={false}
                style={{ maxWidth: '100%', maxHeight: '58vh', display: 'block' }}
              />
              {/* 选框：虚线边框 + 巨大 box-shadow 压暗选区外（被容器 overflow 裁剪） */}
              {hasSel && (
                <div style={{
                  position: 'absolute', left: sel!.x, top: sel!.y, width: sel!.w, height: sel!.h,
                  border: '2px dashed var(--brand-primary)',
                  boxShadow: '0 0 0 9999px rgba(0,0,0,0.45)',
                  pointerEvents: 'none',
                }} />
              )}
            </div>
          </div>
        </div>
      ) : loading ? (
        <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
      ) : (
        works.map((work) => {
          const imgs = workImages[work] || [];
          return (
            <div key={work} style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>
                {work} <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>（{imgs.length} 张）</span>
              </div>
              {imgs.length === 0 ? (
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>该作品暂无本地图片，可先在其条目的图片管理中添加或截图</div>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {imgs.map((img) => (
                    <img
                      key={img.id}
                      src={img.dataUrl}
                      alt={img.fileName}
                      title={`${img.fileName} — 点击框选`}
                      onClick={() => { setCropTarget(img); setSel(null); }}
                      style={{ height: 110, borderRadius: 6, cursor: 'pointer', border: '1px solid #30363d' }}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })
      )}
    </Modal>
  );
};

export default WorkImagePicker;
