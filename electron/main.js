/**
 * AnimeDiary 主进程
 *
 * 两种运行形态：
 *   开发（npm run dev）   → 连 Vite dev server，/api 由 vite.config.ts 的插件提供
 *   打包后（安装版）      → 主进程起一个仅监听 127.0.0.1 的本地服务（electron/api-server.js），
 *                          它复用 server/api-routes.ts 的**同一份** /api 实现
 *
 * 数据位置：
 *   开发   → 项目根目录
 *   打包后 → 「文档/AnimeDiary/」（用户可直接用 Excel 打开、备份、迁移）
 *
 * 热更新：
 *   前端资源可独立更新（electron/updater.js）。启动时优先加载 userData/web-update 下
 *   比内置版本更新的那份，因此「只改前端」时不需要重装，重启即生效。
 */
const { app, BrowserWindow, ipcMain, desktopCapturer, session, shell, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const screenshotDesktop = require('screenshot-desktop');
const { startApiServer } = require('./api-server');
const { ensureExcelFile } = require('./excel-template');
const { resolveWebDir, fetchLatest, downloadUpdate, pruneOldUpdates, isNewer } = require('./updater');

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const isDev = !!DEV_SERVER_URL;

let mainWindow = null;
let apiServer = null;
let appPort = 0;
/** 数据根目录（Excel / images / backups 都在这里） */
let dataDir = '';
let excelPath = '';
let imagesDir = '';
/** 实际加载的前端目录（内置 dist 或已下载的更新） */
let webDir = '';

/** 更新状态（供界面查询） */
let updateState = {
  currentVersion: '0.0.0',
  source: 'builtin',
  latestVersion: null,
  checking: false,
  downloading: false,
  progress: 0,
  downloadedVersion: null,
  error: null,
  notes: '',
};

/** 用于正则转义（截图视频保存的文件名自动编号） */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 数据目录：开发用项目目录，打包后用「文档/AnimeDiary」 */
function resolveDataDir() {
  if (isDev) return path.resolve(__dirname, '..');
  try {
    return path.join(app.getPath('documents'), 'AnimeDiary');
  } catch {
    return path.join(app.getPath('userData'), 'AnimeDiary');
  }
}

// ── 更新源配置（用户可直接编辑这个 JSON） ──
function updateConfigPath() {
  return path.join(app.getPath('userData'), 'update-config.json');
}

function loadUpdateConfig() {
  const fallback = {
    _说明:
      '更新源可以是一个本地文件夹（把 AnimeDiary-web-x.y.z.zip 与 latest.json 放进去即可），' +
      '也可以是 HTTP 静态目录（自建服务 / 局域网共享 / 网盘直链）。autoCheck=false 可关闭启动时自动检查。',
    updateUrl: 'E:\\AnimeDiary-updates',
    autoCheck: true,
  };
  try {
    const file = updateConfigPath();
    if (fs.existsSync(file)) {
      return { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf-8')) };
    }
    fs.writeFileSync(file, JSON.stringify(fallback, null, 2), 'utf-8');
  } catch { /* 配置不可写则用默认值 */ }
  return fallback;
}

function saveUpdateConfig(patch) {
  const next = { ...loadUpdateConfig(), ...patch };
  try {
    fs.writeFileSync(updateConfigPath(), JSON.stringify(next, null, 2), 'utf-8');
  } catch { /* ignore */ }
  return next;
}

function notifyRenderer() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:status', updateState);
  }
}

/** 检查更新；发现新版则下载到本地，下次启动生效 */
async function checkForUpdates(config, silent) {
  if (updateState.checking || updateState.downloading) return updateState;
  updateState = { ...updateState, checking: true, error: null };
  try {
    const latest = await fetchLatest(config.updateUrl);
    updateState = { ...updateState, checking: false, latestVersion: latest.version, notes: latest.notes };

    if (isNewer(latest.version, updateState.currentVersion)) {
      updateState = { ...updateState, downloading: true, progress: 0 };
      notifyRenderer();
      await downloadUpdate({
        latest,
        userDataDir: app.getPath('userData'),
        onProgress: ({ received, total }) => {
          updateState = { ...updateState, progress: total ? Math.round((received / total) * 100) : 0 };
        },
      });
      updateState = { ...updateState, downloading: false, progress: 100, downloadedVersion: latest.version };
    } else {
      updateState = { ...updateState, downloading: false, downloadedVersion: null };
    }
  } catch (e) {
    updateState = { ...updateState, checking: false, downloading: false, error: e.message };
  }
  notifyRenderer();
  return updateState;
}

// ── Excel 读取（IPC，只读；写入一律走 /api 以保留校验与快照） ──
function readExcel() {
  if (!fs.existsSync(excelPath)) throw new Error(`Excel 文件不存在: ${excelPath}`);
  const wb = XLSX.readFile(excelPath);
  const result = {};
  wb.SheetNames.forEach((name) => {
    result[name] = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
  });
  return result;
}

/**
 * 应用浏览器版导出的本地数据（browser-migration.json）
 *
 * 由 server/api-routes.ts 的 /api/_migrate-export 页面生成；
 * 把它放进数据目录后，下次启动会自动写入 localStorage 并改名为 .applied。
 */
async function applyBrowserMigration() {
  const file = path.join(dataDir, 'browser-migration.json');
  if (!fs.existsSync(file) || !mainWindow || mainWindow.isDestroyed()) return;
  try {
    const payload = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const ls = payload.localStorage || {};
    const keys = Object.keys(ls);
    if (keys.length === 0) return;
    const script = keys
      .map((k) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(String(ls[k]))});`)
      .join('\n');
    await mainWindow.webContents.executeJavaScript(script, true);
    fs.renameSync(file, `${file}.applied`);
    console.log(`[AnimeDiary] 已应用浏览器迁移数据：${keys.length} 个键`);
    mainWindow.webContents.reload();
  } catch (e) {
    console.warn('[AnimeDiary] 应用迁移数据失败:', e.message);
  }
}

function createWindow() {
  const iconPath = path.join(__dirname, '..', 'build', 'icon.png');
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'AnimeDiary - 番剧评分管理',
    backgroundColor: '#0d1117',
    // 隐藏系统标题栏，让内容延伸到顶部（更接近 Kazumi 那种干净感）
    titleBarStyle: 'hidden',
    // 右上角仍由系统绘制最小化/最大化/关闭按钮，并保留窗口边缘缩放手势
    titleBarOverlay: {
      color: '#161b22',
      symbolColor: '#e6edf3',
      height: 36,
    },
    ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL(DEV_SERVER_URL);
  } else {
    mainWindow.loadURL(`http://127.0.0.1:${appPort}/`);
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── 单实例锁：避免两个实例抢同一个端口 / 同时写同一个 Excel ──
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(async () => {
  // 去掉默认菜单栏（File / Edit / View / Window / Help）
  Menu.setApplicationMenu(null);

  // 没拿到单实例锁说明已有实例在运行，直接不启动（避免抢端口、抢写同一个 Excel）
  if (!app.hasSingleInstanceLock()) return;

  // 1. 数据目录与首次初始化
  dataDir = resolveDataDir();
  fs.mkdirSync(dataDir, { recursive: true });
  excelPath = path.join(dataDir, '番评分.xlsx');
  imagesDir = path.join(dataDir, 'images');
  const { created } = ensureExcelFile(excelPath);
  if (created) console.log('[AnimeDiary] 已创建空白数据文件:', excelPath);

  // 2. 决定加载哪份前端（已下载的更新优先）
  const userDataDir = app.getPath('userData');
  const web = resolveWebDir({
    builtinDistDir: path.join(__dirname, '..', 'dist'),
    userDataDir,
  });
  webDir = web.dir;
  updateState.currentVersion = web.version;
  updateState.source = web.source;
  pruneOldUpdates(userDataDir, web.version);
  console.log(`[AnimeDiary] 前端版本 ${web.version}（来源：${web.source === 'update' ? '热更新' : '内置'}）`);

  // 3. 生产模式：起本地服务（/api + 静态资源）
  if (!isDev) {
    try {
      const started = await startApiServer({ dataDir, distDir: webDir });
      apiServer = started.server;
      appPort = started.port;
      console.log('[AnimeDiary] 本地服务已启动 http://127.0.0.1:' + appPort);
      console.log('[AnimeDiary] 数据目录:', dataDir);
    } catch (e) {
      dialog.showErrorBox('AnimeDiary 启动失败', `无法启动内置服务：\n${e.message}`);
      app.quit();
      return;
    }
  }

  // 4. 屏幕捕获
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['media', 'display-capture', 'desktopCapture'].includes(permission));
  });
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, cb) => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 1, height: 1 },
    });
    cb({ video: sources[0] || undefined, audio: 'loopback' });
  });

  // 5. Excel IPC（只读）
  ipcMain.handle('excel:read', () => readExcel());
  ipcMain.handle('excel:getInfo', () => {
    if (!fs.existsSync(excelPath)) return { exists: false };
    const stat = fs.statSync(excelPath);
    return { exists: true, path: excelPath, size: stat.size, modifiedAt: stat.mtime.toISOString() };
  });

  // 6. 截图 / 录制
  ipcMain.handle('capture:getSources', async (_event, { types = ['screen', 'window'] } = {}) => {
    const sources = await desktopCapturer.getSources({
      types,
      thumbnailSize: { width: 320, height: 180 },
    });
    return sources.map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }));
  });

  ipcMain.handle('capture:takeScreenshot', async () => {
    try {
      const buf = await screenshotDesktop({ format: 'png' });
      return { dataUrl: `data:image/png;base64,${buf.toString('base64')}`, name: '全屏截图' };
    } catch (e) {
      throw new Error(`截图失败: ${e.message}`);
    }
  });

  ipcMain.handle('capture:saveVideo', async (_event, { animeTitle, buffer, fileName }) => {
    const safeName = String(animeTitle || '').replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名';
    const dir = path.join(imagesDir, safeName);
    fs.mkdirSync(dir, { recursive: true });

    let maxNum = 0;
    const re = new RegExp(`^${escapeRegExp(safeName)}_(\\d+)\\.`);
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(re);
      if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
    }
    const outName = `${safeName}_${maxNum + 1}${fileName ? path.extname(fileName) : '.webm'}`;
    fs.writeFileSync(path.join(dir, outName), Buffer.from(buffer));

    const url = `/api/images/file?anime=${encodeURIComponent(safeName)}&file=${encodeURIComponent(outName)}`;
    return { success: true, fileName: outName, url };
  });

  // 7. 数据目录
  ipcMain.handle('data:getDir', () => dataDir);
  ipcMain.handle('data:openDir', async () => {
    await shell.openPath(dataDir);
    return dataDir;
  });

  // 8. 更新相关
  ipcMain.handle('update:getStatus', () => updateState);
  ipcMain.handle('update:check', async () => checkForUpdates(loadUpdateConfig(), false));
  ipcMain.handle('update:getConfig', () => loadUpdateConfig());
  ipcMain.handle('update:setUrl', (_event, url) => {
    saveUpdateConfig({ updateUrl: String(url || '') });
    return loadUpdateConfig();
  });
  ipcMain.handle('update:restart', () => {
    app.relaunch();
    app.exit(0);
  });

  createWindow();

  // 迁移文件：把浏览器版的本地数据写入本机（文件存在才做，处理完改名）
  if (mainWindow) {
    mainWindow.webContents.once('did-finish-load', () => { applyBrowserMigration(); });
  }

  // 9. 启动后台静默检查（不阻塞界面）
  if (!isDev) {
    const config = loadUpdateConfig();
    if (config.autoCheck && config.updateUrl) {
      setTimeout(() => { checkForUpdates(config, true); }, 3000);
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (apiServer) {
    try { apiServer.close(); } catch { /* ignore */ }
    apiServer = null;
  }
});
