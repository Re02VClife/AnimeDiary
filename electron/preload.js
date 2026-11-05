/**
 * 预加载脚本：只把必要且受控的能力暴露给渲染进程。
 *
 * 注意：Excel 的**写入**刻意不提供 IPC 通道 —— 写回必须走 /api/excel/write，
 * 那里有写前身份校验、原子写与多代快照；绕过它会失去这些保护。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 平台信息
  platform: process.platform,

  // Excel（只读）
  readExcel: () => ipcRenderer.invoke('excel:read'),
  getExcelInfo: () => ipcRenderer.invoke('excel:getInfo'),

  // 截图 / 录制
  getCaptureSources: (types) => ipcRenderer.invoke('capture:getSources', { types }),
  takeScreenshot: () => ipcRenderer.invoke('capture:takeScreenshot'),
  saveVideo: (animeTitle, buffer, fileName) =>
    ipcRenderer.invoke('capture:saveVideo', { animeTitle, buffer, fileName }),

  // 数据目录（面板上「打开数据文件夹」用）
  getDataDir: () => ipcRenderer.invoke('data:getDir'),
  openDataDir: () => ipcRenderer.invoke('data:openDir'),

  /**
   * 同步标题栏右上角系统按钮的配色。
   * 那块区域由 Electron 独立绘制，CSS 变量影响不到它 —— 不主动同步的话，
   * 切到浅色主题后右上角会留一块深色（#161b22）补丁。
   * @param {'dark'|'light'} mode
   * @param {{background?: string, symbol?: string}} colors #RRGGBB，非法值主进程会回退默认
   */
  setTitleBarOverlay: (mode, colors) =>
    ipcRenderer.send('window:set-titlebar-overlay', { mode, colors }),

  // 热更新
  getUpdateStatus: () => ipcRenderer.invoke('update:getStatus'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  restartApp: () => ipcRenderer.invoke('update:restart'),
  getUpdateConfig: () => ipcRenderer.invoke('update:getConfig'),
  setUpdateUrl: (url) => ipcRenderer.invoke('update:setUrl', url),
  /** 订阅更新状态变化，返回取消订阅函数 */
  onUpdateStatus: (cb) => {
    const listener = (_e, status) => cb(status);
    ipcRenderer.on('update:status', listener);
    return () => ipcRenderer.removeListener('update:status', listener);
  },
});
