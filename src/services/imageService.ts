/**
 * 图片存储服务（本地文件版）
 *   通过 Vite API 将图片保存到项目 images/ 目录
 *   命名规则：{番剧名}_{编号}.{ext}
 */
import type { ImageEntry } from '../types';

/** 列出某番剧的本地图片 */
export async function loadImages(animeTitle: string): Promise<ImageEntry[]> {
  try {
    const resp = await fetch(`/api/images/list?animeTitle=${encodeURIComponent(animeTitle)}`);
    if (!resp.ok) return [];
    const files = await resp.json() as { fileName: string; url: string; size: number; mtime: string }[];
    return files.map((f) => ({
      id: `local-${animeTitle}-${f.fileName}`,
      animeId: '',
      animeTitle,
      fileName: f.fileName,
      dataUrl: f.url,
      size: f.size,
      type: 'screenshot' as const,
      createdAt: f.mtime,
    }));
  } catch {
    return [];
  }
}

/** 保存图片到本地（默认原图，>10MB 才提示但不强制压缩） */
export async function saveImage(dataUrl: string, animeTitle: string): Promise<ImageEntry> {
  const resp = await fetch('/api/images/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ animeTitle, dataUrl }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: '保存失败' }));
    throw new Error(err.error || '保存失败');
  }
  const result = await resp.json();
  return {
    id: `local-${animeTitle}-${result.fileName}`,
    animeId: '',
    animeTitle,
    fileName: result.fileName,
    dataUrl: result.url,
    filePath: result.filePath,
    type: 'screenshot',
    createdAt: new Date().toISOString(),
  };
}

/** 删除本地图片 */
export async function deleteImage(animeTitle: string, fileName: string): Promise<void> {
  const resp = await fetch('/api/images/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ animeTitle, fileName }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: '删除失败' }));
    throw new Error(err.error || '删除失败');
  }
}
