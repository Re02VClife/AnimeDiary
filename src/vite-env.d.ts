/// <reference types="vite/client" />

interface ElectronAPI {
  openFile: (options?: Record<string, unknown>) => Promise<{ canceled: boolean; filePaths: string[] }>;
  openDir: (options?: Record<string, unknown>) => Promise<{ canceled: boolean; filePaths: string[] }>;
  platform: string;
  /** 获取可捕获的屏幕/窗口列表（含低分辨率缩略图） */
  getCaptureSources: (types?: ('screen' | 'window')[]) => Promise<
    { id: string; name: string; thumbnail: string }[]
  >;
  /** 截取全屏截图（OS 原生 API），返回 PNG dataUrl */
  takeScreenshot: () => Promise<{ dataUrl: string; name: string }>;
  /** 保存视频到 images/{番剧名}/ 目录 */
  saveVideo: (animeTitle: string, buffer: number[], fileName?: string) => Promise<
    { success: boolean; fileName: string; url: string }
  >;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
