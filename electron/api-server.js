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
const { createApiHandler } = require('../server/api-routes.cjs');

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
 * @param {{ dataDir: string, distDir: string, port?: number }} options
 * @returns {Promise<{ server: import('http').Server, port: number }>}
 */
function startApiServer({ dataDir, distDir, port }) {
  if (!fs.existsSync(distDir)) {
    throw new Error(`前端产物目录不存在：${distDir}（请先执行 vite build）`);
  }
  const listenPort = port || FIXED_PORT;
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
