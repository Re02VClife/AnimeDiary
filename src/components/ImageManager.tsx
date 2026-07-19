/**
 * 图片管理组件 — 上传/删除/设为海报（本地存储版）
 *   图片保存到项目 images/{番剧名}/ 目录
 *   支持双击查看原图大图
 */
import { useState, useEffect, useRef } from 'react';
import { Modal, Button, Image, Space, message, Popconfirm } from 'antd';
import { PlusOutlined, DeleteOutlined, PushpinOutlined, CameraOutlined, PictureOutlined } from '@ant-design/icons';
import type { AnimeEntry, ImageEntry } from '../types';
import { CHARACTER_TEMPLATE_ID } from '../types';
import { loadImages, saveImage, deleteImage } from '../services/imageService';
import ScreenCapture from './ScreenCapture';
import WorkImagePicker from './WorkImagePicker';

interface ImageManagerProps {
  anime: AnimeEntry;
  open: boolean;
  onClose: () => void;
  onSetPoster?: (url: string) => void;
  onDeletePoster?: (url: string) => void;
  imgHeight?: number;
}

const ImageManager: React.FC<ImageManagerProps> = ({ anime, open, onClose, onSetPoster, onDeletePoster, imgHeight = 360 }) => {
  const [images, setImages] = useState<ImageEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [screenCaptureOpen, setScreenCaptureOpen] = useState(false);
  const [workPickerOpen, setWorkPickerOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 角色卡：已绑定的作品列表（char_source '/' 分隔），供"从作品选取"入口
  const boundWorks = anime.templateId === CHARACTER_TEMPLATE_ID
    ? String(anime.customFields?.char_source || '').split('/').filter(Boolean)
    : [];

  /** 刷新图片列表 */
  const refreshImages = async () => {
    setLoading(true);
    const list = await loadImages(anime.title);
    setImages(list);
    setLoading(false);
  };

  useEffect(() => {
    if (open && anime) { refreshImages(); }
  }, [open, anime]);

  /** 上传图片：直接保存原图到本地，不做压缩 */
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { message.warning('请选择图片文件'); return; }

    const reader = new FileReader();
    reader.onerror = () => {
      message.error('图片读取失败');
      if (fileInputRef.current) fileInputRef.current.value = '';
    };
    reader.onload = async () => {
      try {
        const dataUrl = reader.result as string;
        const entry = await saveImage(dataUrl, anime.title);
        setImages((prev) => [...prev, entry]);
        const sizeMB = (file.size / 1024 / 1024).toFixed(1);
        message.success(`已保存「${entry.fileName}」(${sizeMB}MB)`);
      } catch (err) {
        message.error(err instanceof Error ? err.message : '保存失败');
      }
      if (fileInputRef.current) fileInputRef.current.value = '';
    };
    reader.readAsDataURL(file);
  };

  /** 删除图片 */
  const handleDelete = async (img: ImageEntry) => {
    try {
      await deleteImage(anime.title, img.fileName);
      setImages((prev) => prev.filter((i) => i.id !== img.id));
      // 如果删除的是当前海报，通知父组件
      if (anime.posterUrl === img.dataUrl) {
        onDeletePoster?.(img.dataUrl);
      }
      message.success('已删除');
    } catch (err) {
      message.error('删除失败');
    }
  };

  /** 设为海报 */
  const handleSetPoster = (img: ImageEntry) => {
    onSetPoster?.(img.dataUrl);
    message.success('已设为海报');
  };

  return (
    <Modal
      title={`🖼️ ${anime.title} — 图片管理`}
      open={open}
      onCancel={onClose}
      width={1100}
      footer={null}
      styles={{ body: { maxHeight: '80vh', overflowY: 'auto' } }}
    >
      <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => fileInputRef.current?.click()} loading={loading}>
          添加图片
        </Button>
        <Button icon={<CameraOutlined />} onClick={() => setScreenCaptureOpen(true)}>
          在线截图
        </Button>
        {boundWorks.length > 0 && (
          <Button icon={<PictureOutlined />} onClick={() => setWorkPickerOpen(true)}>
            从作品选取
          </Button>
        )}
        <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFileSelect} />
        <span style={{ color: 'var(--text-secondary)', fontSize: 11 }}>
          支持高清大图 · 在线截图 · 录屏转 GIF
        </span>
      </div>

      {images.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-muted)' }}>
          <span style={{ fontSize: 48, opacity: 0.3, display: 'block', marginBottom: 8 }}>🖼️</span>
          暂无图片 · 点击上方按钮添加
          <div style={{ fontSize: 11, marginTop: 4, color: 'var(--border-primary)' }}>
            图片保存在 images/{anime.title.replace(/[\\/:*?"<>|]/g, '_')}/ 目录
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-start' }}>
          {images.map((img) => (
            <div key={img.id} style={{
              position: 'relative', borderRadius: 8, overflow: 'hidden',
              border: anime.posterUrl === img.dataUrl ? '2px solid #fb7299' : '1px solid #30363d',
              background: 'var(--bg-primary)', flexShrink: 0,
            }}>
              {/* 双击查看原图 */}
              <Image src={img.dataUrl} alt={img.fileName}
                style={{ height: imgHeight, width: 'auto', display: 'block', objectFit: 'contain', cursor: 'pointer' }}
                preview={{
                  mask: <div style={{ fontSize: 12, textAlign: 'center' }}>
                    <div>🔍 点击查看原图</div>
                    {img.size && <div style={{ fontSize: 10, opacity: 0.7 }}>{(img.size / 1024).toFixed(0)}KB</div>}
                  </div>,
                }}
              />
              {/* 海报标记 */}
              {anime.posterUrl === img.dataUrl && (
                <div style={{
                  position: 'absolute', top: 6, left: 6,
                  background: 'var(--brand-primary)', borderRadius: 3, padding: '2px 8px',
                  fontSize: 11, color: '#fff', fontWeight: 600,
                }}>海报</div>
              )}
              {/* 操作按钮 */}
              <div style={{
                padding: '4px 6px',
                display: 'flex', gap: 4, justifyContent: 'space-between', alignItems: 'center',
                background: 'var(--bg-secondary)',
              }}>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 100 }}>
                  {img.fileName}
                </span>
                <Space.Compact size="small">
                  {anime.posterUrl !== img.dataUrl && (
                    <Button size="small" type="primary" icon={<PushpinOutlined />}
                      onClick={() => handleSetPoster(img)}>设为海报</Button>
                  )}
                  <Popconfirm title="删除此图片？" onConfirm={() => handleDelete(img)} okText="删除" cancelText="取消">
                    <Button size="small" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                </Space.Compact>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 在线截图悬浮窗 */}
      {screenCaptureOpen && (
        <ScreenCapture
          animeTitle={anime.title}
          onImageSaved={(entry) => {
            setImages((prev) => [...prev, entry]);
            message.success(`已保存「${entry.fileName}」`);
          }}
          onClose={() => setScreenCaptureOpen(false)}
        />
      )}

      {/* 从绑定作品选取图片（角色卡） */}
      {workPickerOpen && (
        <WorkImagePicker
          works={boundWorks}
          characterTitle={anime.title}
          open={workPickerOpen}
          onClose={() => setWorkPickerOpen(false)}
          onSaved={(entry) => {
            setImages((prev) => [...prev, entry]);
            message.success(`已保存「${entry.fileName}」`);
          }}
        />
      )}
    </Modal>
  );
};

export default ImageManager;
