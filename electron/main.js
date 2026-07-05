const { app, BrowserWindow, ipcMain, desktopCapturer, session } = require('electron');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const screenshotDesktop = require('screenshot-desktop');

// 用于正则转义（供截图视频保存的文件名自动编号使用）
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Excel 文件路径（后续可改为可配置）
const EXCEL_PATH = 'C:\\Users\\24628\\Desktop\\vscode\\番评分.xlsx';

// ── 读取 Excel 文件 ──
function readExcel() {
  if (!fs.existsSync(EXCEL_PATH)) {
    throw new Error(`Excel 文件不存在: ${EXCEL_PATH}`);
  }
  const wb = XLSX.readFile(EXCEL_PATH);
  const result = {};
  wb.SheetNames.forEach((name) => {
    const ws = wb.Sheets[name];
    result[name] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  });
  return result;
}

// ── 写回 Excel 文件 ──
// updates: { sheetName, rowIndex, colIndex, value }[]
function writeExcel(updates) {
  if (!fs.existsSync(EXCEL_PATH)) {
    throw new Error(`Excel 文件不存在: ${EXCEL_PATH}`);
  }
  const wb = XLSX.readFile(EXCEL_PATH);

  for (const update of updates) {
    const { sheetName, rowIndex, colIndex, value } = update;
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;

    // 将数字列索引转为 Excel 列字母
    const cellAddr = XLSX.utils.encode_cell({ r: rowIndex, c: colIndex });
    ws[cellAddr] = { t: typeof value === 'number' ? 'n' : 's', v: value };
  }

  XLSX.writeFile(wb, EXCEL_PATH);
  return { success: true };
}

// ── 创建主窗口 ──
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'AnimeDiary - 番剧评分管理',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 开发模式：加载 Vite 开发服务器
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    // 生产模式：加载打包后的文件
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

// ── 注册 IPC 处理器 ──
app.whenReady().then(() => {
  // 授权渲染进程访问媒体捕获
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['media', 'display-capture', 'desktopCapture'].includes(permission));
  });

  // 拦截 getDisplayMedia，提供桌面源（高性能 GPU 捕获）
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, cb) => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 1, height: 1 },
    });
    cb({ video: sources[0] || undefined, audio: 'loopback' });
  });

  // Excel 读取
  ipcMain.handle('excel:read', () => {
    return readExcel();
  });

  // Excel 写入
  ipcMain.handle('excel:write', (_event, updates) => {
    return writeExcel(updates);
  });

  // Excel 文件信息
  ipcMain.handle('excel:getInfo', () => {
    if (!fs.existsSync(EXCEL_PATH)) {
      return { exists: false };
    }
    const stat = fs.statSync(EXCEL_PATH);
    return {
      exists: true,
      path: EXCEL_PATH,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    };
  });

  // ── 截图：获取可捕获的屏幕和窗口列表（含低分辨率缩略图供选择）──
  ipcMain.handle('capture:getSources', async (_event, { types = ['screen', 'window'] } = {}) => {
    const sources = await desktopCapturer.getSources({
      types,
      thumbnailSize: { width: 320, height: 180 },
    });
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      thumbnail: s.thumbnail.toDataURL(),
    }));
  });

  // ── 截图：对指定源获取全分辨率截图（用 OS 原生 API，非 Chromium）──
  ipcMain.handle('capture:takeScreenshot', async () => {
    try {
      const buf = await screenshotDesktop({ format: 'png' });
      const base64 = buf.toString('base64');
      return { dataUrl: `data:image/png;base64,${base64}`, name: '全屏截图' };
    } catch (e) {
      throw new Error(`截图失败: ${e.message}`);
    }
  });

  // ── 录制：保存视频/图片文件到 images/{番剧名}/ 目录 ──
  ipcMain.handle('capture:saveVideo', async (_event, { animeTitle, buffer, fileName }) => {
    const safeName = animeTitle.replace(/[\\/:*?"<>|]/g, '_').trim();
    const dir = path.join(__dirname, '..', 'images', safeName);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // 自动编号：找到已有文件的最大编号 + 1
    let maxNum = 0;
    if (fs.existsSync(dir)) {
      const re = new RegExp(`^${escapeRegExp(safeName)}_(\\d+)\\.`);
      for (const f of fs.readdirSync(dir)) {
        const m = f.match(re);
        if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
      }
    }
    const num = maxNum + 1;
    const ext = fileName ? path.extname(fileName) : '.webm';
    const outName = `${safeName}_${num}${ext}`;
    const filePath = path.join(dir, outName);

    fs.writeFileSync(filePath, Buffer.from(buffer));

    const url = `/api/images/file?anime=${encodeURIComponent(safeName)}&file=${encodeURIComponent(outName)}`;
    return { success: true, fileName: outName, url };
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
