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
const { app, BrowserWindow, ipcMain, desktopCapturer, session, shell, dialog, Menu, screen, clipboard } = require('electron');
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

// ── 窗口状态记忆 ──────────────────────────────────────────────
// 用户把窗口拖到副屏、拉大、最大化，下次打开应该还是那个样子。
// 只存「还原态」的 bounds（最大化时 getNormalBounds 拿到的仍是还原尺寸），
// 否则下次会先开在最大化尺寸再被 maximize() 拽一次，闪一下。
function windowStatePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(windowStatePath(), 'utf-8'));
    if (!s || typeof s.width !== 'number' || typeof s.height !== 'number') return null;
    return s;
  } catch {
    return null; // 首次运行 / 文件损坏 → 用默认尺寸
  }
}

/** 坐标是否还落在某块屏幕里（拔掉副屏后旧坐标可能在屏幕外） */
function isOnScreen(bounds) {
  if (typeof bounds.x !== 'number' || typeof bounds.y !== 'number') return false;
  try {
    return screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return bounds.x < a.x + a.width && bounds.x + bounds.width > a.x
        && bounds.y < a.y + a.height && bounds.y + bounds.height > a.y;
    });
  } catch {
    return false;
  }
}

function saveWindowState(win) {
  if (!win || win.isDestroyed()) return;
  try {
    const b = win.getNormalBounds();
    fs.writeFileSync(windowStatePath(), JSON.stringify({
      width: b.width, height: b.height, x: b.x, y: b.y,
      maximized: win.isMaximized(),
      savedAt: new Date().toISOString(),
    }), 'utf-8');
  } catch { /* 状态记不住不影响使用 */ }
}

/** resize/move 会连续触发，攒 300ms 再落盘 */
function scheduleSaveWindowState(win) {
  if (stateSaveTimer) clearTimeout(stateSaveTimer);
  stateSaveTimer = setTimeout(() => { saveWindowState(win); stateSaveTimer = null; }, 300);
}
let stateSaveTimer = null;

// ── 标题栏 overlay 跟随主题 ────────────────────────────────────
// titleBarOverlay 的颜色是独立于页面绘制的：不主动改，切浅色主题后
// 右上角会留一块深色（实测就是这么发现的）。渲染进程主题变化时通过 IPC 同步。
const TITLEBAR_DEFAULTS = {
  dark: { color: '#161b22', symbolColor: '#e6edf3' },
  light: { color: '#ffffff', symbolColor: '#1f2328' },
};

function applyTitleBarOverlay(mode, colors) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const fallback = TITLEBAR_DEFAULTS[mode === 'light' ? 'light' : 'dark'];
  // 只接受 #RRGGBB：Electron 在这里不吃 rgba()/变量
  const hex = (v) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : null);
  try {
    mainWindow.setTitleBarOverlay({
      color: hex(colors && colors.background) || fallback.color,
      symbolColor: hex(colors && colors.symbol) || fallback.symbolColor,
      height: 36,
    });
  } catch (e) {
    console.warn('[AnimeDiary] 设置标题栏颜色失败:', e.message);
  }
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

/**
 * 右键菜单。
 *
 * Electron 默认不提供任何右键菜单 —— 实测在评价输入框里右键「什么都没有」，
 * 想粘贴一段评价只能靠 Ctrl+V。这里按上下文补：输入框给编辑命令，
 * 链接给「在浏览器打开」，选中文本给复制。
 */
function attachContextMenu(win) {
  win.webContents.on('context-menu', (_event, params) => {
    const items = [];
    if (params.isEditable) {
      const f = params.editFlags || {};
      items.push(
        { label: '撤销', role: 'undo', enabled: !!f.canUndo },
        { label: '重做', role: 'redo', enabled: !!f.canRedo },
        { type: 'separator' },
        { label: '剪切', role: 'cut', enabled: !!f.canCut },
        { label: '复制', role: 'copy', enabled: !!f.canCopy },
        { label: '粘贴', role: 'paste', enabled: !!f.canPaste },
        { type: 'separator' },
        { label: '全选', role: 'selectAll', enabled: !!f.canSelectAll },
      );
    } else if (params.linkURL) {
      items.push(
        { label: '在浏览器中打开', click: () => shell.openExternal(params.linkURL) },
        { label: '复制链接', click: () => clipboard.writeText(params.linkURL) },
      );
    } else if (params.selectionText && params.selectionText.trim()) {
      items.push({ label: '复制', role: 'copy' });
    }
    if (!items.length) return;
    Menu.buildFromTemplate(items).popup({ window: win });
  });
}

function createWindow() {
  const iconPath = path.join(__dirname, '..', 'build', 'icon.png');
  // 上次的窗口位置/大小；坐标落到屏幕外（拔掉副屏）就退回默认尺寸只保留大小
  const saved = loadWindowState();
  const placement = saved && isOnScreen(saved)
    ? { width: saved.width, height: saved.height, x: saved.x, y: saved.y }
    : { width: saved?.width || 1400, height: saved?.height || 900 };

  mainWindow = new BrowserWindow({
    ...placement,
    minWidth: 900,
    minHeight: 600,
    title: 'AnimeDiary - 番剧评分管理',
    backgroundColor: '#0d1117',
    // 隐藏系统标题栏，让内容延伸到顶部（更接近 Kazumi 那种干净感）
    titleBarStyle: 'hidden',
    // 右上角仍由系统绘制最小化/最大化/关闭按钮，并保留窗口边缘缩放手势
    titleBarOverlay: {
      ...TITLEBAR_DEFAULTS.dark,
      height: 36,
    },
    ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (saved?.maximized) mainWindow.maximize();

  if (isDev) {
    mainWindow.loadURL(DEV_SERVER_URL);
  } else {
    mainWindow.loadURL(`http://127.0.0.1:${appPort}/`);
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 兜底：万一有 <a href> 漏了 target=_blank，别把整个应用导航走（菜单被清空后回不来）
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const appOrigin = isDev ? DEV_SERVER_URL : `http://127.0.0.1:${appPort}`;
    if (url.startsWith('http') && !url.startsWith(appOrigin)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  attachContextMenu(mainWindow);

  // DevTools 快捷键。
  // Menu.setApplicationMenu(null) 之后 F12 / Ctrl+Shift+I 全没了 —— 排查线上问题时
  // 只能靠 --remote-debugging-port 挂 CDP，很别扭。这里单独补回来（不加 Ctrl+R，
  // 免得普通用户误触刷新）。
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const isF12 = input.key === 'F12';
    const isInspect = input.control && input.shift && String(input.key).toLowerCase() === 'i';
    if (isF12 || isInspect) {
      event.preventDefault();
      mainWindow.webContents.toggleDevTools();
    }
  });

  // 窗口状态记忆：移动/缩放攒 300ms 落盘，关闭前再存一次
  const remember = () => scheduleSaveWindowState(mainWindow);
  mainWindow.on('resize', remember);
  mainWindow.on('move', remember);
  mainWindow.on('close', () => saveWindowState(mainWindow));

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── 单实例锁：避免两个实例抢同一个端口 / 同时写同一个 Excel ──
// 拿不到锁时**必须留下可读的线索**：以前是纯静默 quit，开发时遇到"安装版还开着"
// 会表现为 `npm run dev` 什么都不打印就退出，极难排查。
if (!app.requestSingleInstanceLock()) {
  console.warn(
    '[AnimeDiary] 已有实例正在运行，本进程退出（单实例锁未获取）。\n'
    + '  · 如果你在开发：先关闭已安装的 AnimeDiary，或给本进程独立的 userData 目录，例如\n'
    + '    npx electron . --user-data-dir=%TEMP%\\animediary-dev\n'
    + '  · 如果你双击了图标：已有窗口已被切到前台。',
  );
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
      const started = await startApiServer({
        dataDir,
        distDir: webDir,
        // 服务端路由实现也走热更新：更新包里的 server/api-routes.cjs 优先，
        // 缺失或加载失败时 api-server 会自动回退到 app.asar 里的内置版本。
        routesPath: path.join(webDir, 'server', 'api-routes.cjs'),
      });
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

  /**
   * 全屏截图。
   *
   * 两个坑：
   *  1. screenshot-desktop 在 Windows 上要把 screenCapture.bat 解压到**固定的**
   *     临时目录再 `cmd /c` 执行 —— 两个请求并发时必然有一个失败（实测打开
   *     截图面板就报错，因为 React StrictMode 把 effect 跑了两遍）。
   *     所以这里做请求合并：同一时刻只跑一次，其余调用复用同一个 Promise。
   *  2. 偶尔会撞到文件占用/杀毒扫描，失败后间隔 350ms 重试一次，成功率显著提高。
   *
   * 失败时**不要把 cmd.exe 的原始报错抛给界面**（会横穿整个窗口且暴露内部路径），
   * 原始信息只写主进程日志。
   */
  let screenshotInFlight = null;
  ipcMain.handle('capture:takeScreenshot', async () => {
    if (screenshotInFlight) return screenshotInFlight;

    screenshotInFlight = (async () => {
      const shoot = async () => {
        const buf = await screenshotDesktop({ format: 'png' });
        return { dataUrl: `data:image/png;base64,${buf.toString('base64')}`, name: '全屏截图' };
      };
      try {
        return await shoot();
      } catch (first) {
        console.warn('[AnimeDiary] 截图失败，350ms 后重试一次:', first.message);
        await new Promise((r) => setTimeout(r, 350));
        try {
          return await shoot();
        } catch (second) {
          console.error('[AnimeDiary] 截图重试仍失败:', second.message);
          throw new Error('系统截图失败，请重试；若持续失败，可用「框选区域」从已有的截图里裁。');
        }
      }
    })();

    try {
      return await screenshotInFlight;
    } finally {
      screenshotInFlight = null;
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

  // 7.5 窗口外观：标题栏右上角的系统按钮是独立绘制的，颜色必须由主进程改
  ipcMain.on('window:set-titlebar-overlay', (_event, payload) => {
    applyTitleBarOverlay(payload && payload.mode, payload && payload.colors);
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
