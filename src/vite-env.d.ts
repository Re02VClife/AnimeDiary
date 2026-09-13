/// <reference types="vite/client" />

declare global {
  /** 热更新状态（由主进程 electron/updater.js 维护） */
  interface UpdateStatus {
    /** 当前实际加载的前端版本 */
    currentVersion: string;
    /** 版本来源：内置 dist 还是已下载的热更新 */
    source: 'builtin' | 'update';
    /** 更新源上报告的最新版本（未检查时为 null） */
    latestVersion: string | null;
    checking: boolean;
    downloading: boolean;
    /** 下载进度 0-100 */
    progress: number;
    /** 已下载完成、等待重启生效的版本 */
    downloadedVersion: string | null;
    error: string | null;
    notes: string;
  }

  /** 主进程通过 preload 暴露的能力（见 electron/preload.js） */
  interface ElectronAPI {
    platform: string;

    /** Excel（只读；写入一律走 /api 以保留写前校验与快照） */
    readExcel: () => Promise<Record<string, unknown[][]>>;
    getExcelInfo: () => Promise<{ exists: boolean; path?: string; size?: number; modifiedAt?: string }>;

    /** 获取可捕获的屏幕/窗口列表（含低分辨率缩略图） */
    getCaptureSources: (types?: ('screen' | 'window')[]) => Promise<
      { id: string; name: string; thumbnail: string }[]
    >;
    /** 截取全屏截图（OS 原生 API），返回 PNG dataUrl */
    takeScreenshot: () => Promise<{ dataUrl: string; name: string }>;
    /** 保存视频到「数据目录/images/{番剧名}/」 */
    saveVideo: (animeTitle: string, buffer: number[], fileName?: string) => Promise<
      { success: boolean; fileName: string; url: string }
    >;

    /** 数据目录（打包后为「文档/AnimeDiary」） */
    getDataDir: () => Promise<string>;
    openDataDir: () => Promise<string>;

    /** 热更新 */
    getUpdateStatus: () => Promise<UpdateStatus>;
    checkUpdate: () => Promise<UpdateStatus>;
    restartApp: () => Promise<void>;
    getUpdateConfig: () => Promise<{ updateUrl: string; autoCheck: boolean }>;
    setUpdateUrl: (url: string) => Promise<{ updateUrl: string; autoCheck: boolean }>;
    /** 订阅更新状态变化，返回取消订阅函数 */
    onUpdateStatus: (cb: (status: UpdateStatus) => void) => () => void;
  }

  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
