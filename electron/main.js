const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

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
