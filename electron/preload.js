const { contextBridge, ipcRenderer } = require('electron');

// 安全地暴露有限的 API 给渲染进程
contextBridge.exposeInMainWorld('electronAPI', {
  // 平台信息
  platform: process.platform,

  // Excel 文件操作
  readExcel: () => ipcRenderer.invoke('excel:read'),
  writeExcel: (updates) => ipcRenderer.invoke('excel:write', updates),
  getExcelInfo: () => ipcRenderer.invoke('excel:getInfo'),

  // 截图/录制
  getCaptureSources: (types) => ipcRenderer.invoke('capture:getSources', { types }),
  takeScreenshot: () => ipcRenderer.invoke('capture:takeScreenshot'),
  saveVideo: (animeTitle, buffer, fileName) =>
    ipcRenderer.invoke('capture:saveVideo', { animeTitle, buffer, fileName }),
});
