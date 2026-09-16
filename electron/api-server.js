/**
 * 生产模式的本地服务
 *
 * 打包后的 Electron 没有 Vite dev server，而整个前端的数据层都走 /api/*，
 * 所以这里用**同一份** createApiHandler（server/api-routes）起一个仅监听
 * 127.0.0.1 的 HTTP 服务：/api/* 走接口，其余走 dist 静态文件（SPA 回退）。
 *
 * 这样「开发时能用」和「打包后能用」是同一套后端实现，不会各自漂移。
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const { createFetch } = require('./net-fetch');

/** 内置（安装包里）的路由实现 */
const BUILTIN_ROUTES = path.join(__dirname, '..', 'server', 'api-routes.cjs');

/**
 * 选择用哪一份服务端路由实现。
 *
 * 打包后的 app.asar 里的 server/api-routes.cjs 是**安装时**定格的，
 * 而热更新只换前端 —— 于是新加的后端路由在装好的应用里 404（实测踩过：
 * 前端拿到的是 index.html，报「响应不是合法 JSON」）。
 * 这里优先加载热更新目录里随包携带的那一份。
 *
 * 关键坑：热更新的路由文件在 userData 下，而它 `require('xlsx')` / `require('adm-zip')`
 * 是 external 的 —— 从 userData 往上找不到 node_modules（依赖在 app.asar 里），
 * 直接 require 会 MODULE_NOT_FOUND 并静默回退到内置版本。
 * 所以这里不直接 require，而是用 Module.createRequire 造一个「先按热更新目录解析、
 * 失败再按内置位置解析」的混合 require，把源码喂给 new Function。
 *
 * 保护：文件缺失 / 加载抛错 / 没导出 createApiHandler → 一律回退内置版本，
 * 最坏结果只是新功能用不了，应用仍然打得开。
 */
function resolveRoutesFactory(routesPath, dataDir) {
  if (routesPath && fs.existsSync(routesPath)) {
    try {
      const Module = require('module');
      const source = fs.readFileSync(routesPath, 'utf-8');
      // 优先热更新目录自带的依赖（更新包将来可以自己带 node_modules），
      // 其次回退到 app.asar 里的依赖
      const fromUpdate = Module.createRequire(routesPath);
      const fromBuiltin = Module.createRequire(BUILTIN_ROUTES);
      // AI 抠图的运行时（onnxruntime-node，win32/x64 原生模块 64MB）单独放在
      // 数据目录下，既不进安装包也不进热更新包 —— 详见 server/bg-removal.ts。
      // createRequire 只借用这个路径当解析基准，文件本身不必存在。
      const fromRuntime = dataDir
        ? Module.createRequire(path.join(dataDir, 'runtime', 'noop.js'))
        : null;
      const hybridRequire = (id) => {
        if (fromRuntime) {
          try {
            return fromRuntime(id);
          } catch (e) {
            if (!e || e.code !== 'MODULE_NOT_FOUND') throw e;
          }
        }
        try {
          return fromUpdate(id);
        } catch (e) {
          if (e && e.code === 'MODULE_NOT_FOUND') return fromBuiltin(id);
          throw e;
        }
      };
      const mod = { exports: {} };
      // eslint-disable-next-line no-new-func
      const factory = new Function('require', 'module', 'exports', '__filename', '__dirname', source);
      factory(hybridRequire, mod, mod.exports, routesPath, path.dirname(routesPath));
      if (typeof mod.exports.createApiHandler === 'function') return mod.exports.createApiHandler;
      console.warn('[api-server] 热更新的路由实现没有导出 createApiHandler，回退内置版本');
    } catch (e) {
      console.error('[api-server] 加载热更新的路由实现失败，回退内置版本：', e && e.message);
    }
  }
  return require(BUILTIN_ROUTES).createApiHandler;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.map': 'application/json; charset=utf-8',
};

/** 静态文件（含 SPA 回退），带路径穿越防护 */
function serveStatic(req, res, distDir) {
  let urlPath = '/';
  try {
    urlPath = decodeURIComponent(String(req.url || '/').split('?')[0]);
  } catch {
    urlPath = '/';
  }
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const target = path.resolve(distDir, rel);
  if (target !== distDir && !target.startsWith(distDir + path.sep)) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }
  if (fs.existsSync(target) && fs.statSync(target).isFile()) {
    res.setHeader('Content-Type', MIME[path.extname(target).toLowerCase()] || 'application/octet-stream');
    res.end(fs.readFileSync(target));
    return;
  }
  // SPA 回退：未知路径交给 index.html（前端自己路由）
  const index = path.join(distDir, 'index.html');
  if (fs.existsSync(index)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(fs.readFileSync(index));
  } else {
    res.statusCode = 404;
    res.end('Not Found');
  }
}

/**
 * 固定端口。
 * localStorage 是按 origin 隔离的，而 origin 含端口 —— 如果每次启动换端口，
 * 用户的本地设置（分类覆盖、海报焦点、AI 配置…）就会"凭空消失"。
 * 所以这里固定一个不常用的端口，端口被占用时明确报错而不是静默换端口。
 */
const FIXED_PORT = 51730;

/**
 * 启动本地服务
 * @param {{ dataDir: string, distDir: string, port?: number, routesPath?: string }} options
 *   routesPath：热更新目录里的服务端路由实现（缺省/加载失败则用内置版本）
 * @returns {Promise<{ server: import('http').Server, port: number }>}
 */
function startApiServer({ dataDir, distDir, port, routesPath }) {
  if (!fs.existsSync(distDir)) {
    throw new Error(`前端产物目录不存在：${distDir}（请先执行 vite build）`);
  }
  const listenPort = port || FIXED_PORT;
  const createApiHandler = resolveRoutesFactory(routesPath, dataDir);
  if (routesPath) {
    console.log(`[api-server] 路由实现：${fs.existsSync(routesPath) ? routesPath : '内置（更新目录里没有）'}`);
  }
  const apiHandler = createApiHandler({
    DATA_DIR: dataDir,
    // 服务端网络出口。详见 electron/net-fetch.js：国内域名直连、
    // 国外域名走 Chromium（自动遵守系统代理），两个源的正确走法正好相反。
    fetchImpl: createFetch(),
  });
  const server = http.createServer((req, res) => {
    // 命中 /api/* 则由共用的处理器自行响应，否则回落到静态文件
    apiHandler(req, res, () => serveStatic(req, res, distDir));
  });

  return new Promise((resolve, reject) => {
    server.once('error', (e) => {
      if (e && e.code === 'EADDRINUSE') {
        reject(new Error(
          `本地端口 ${listenPort} 已被占用（通常说明 AnimeDiary 已经开着一个窗口）。\n` +
          `请先关闭已运行的 AnimeDiary，或在任务管理器里结束残留的 AnimeDiary 进程后重试。`,
        ));
      } else {
        reject(e);
      }
    });
    server.listen(listenPort, '127.0.0.1', () => {
      resolve({ server, port: listenPort });
    });
  });
}

module.exports = { startApiServer };
