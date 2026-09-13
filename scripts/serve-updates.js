/**
 * 本地更新源（仅用于验证热更新流程）
 *
 * 把 release/web-update/ 以 HTTP 静态目录提供：
 *   http://127.0.0.1:8787/updates/latest.json
 *   http://127.0.0.1:8787/updates/AnimeDiary-web-<version>.zip
 *
 * 用法：npm run update:serve
 * 这正是 electron/updater.js 期望的更新源格式，真实发布时换成任意静态托管地址即可。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'release', 'web-update');
const port = Number(process.env.UPDATE_PORT || 8787);
const prefix = '/updates/';

const MIME = {
  '.json': 'application/json; charset=utf-8',
  '.zip': 'application/zip',
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(String(req.url || '').split('?')[0]);
  if (!urlPath.startsWith(prefix)) {
    res.statusCode = 404;
    res.end('Not Found');
    return;
  }
  const rel = urlPath.slice(prefix.length);
  const target = path.resolve(dir, rel);
  if (!target.startsWith(dir) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
    res.statusCode = 404;
    res.end('Not Found');
    return;
  }
  res.setHeader('Content-Type', MIME[path.extname(target).toLowerCase()] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.end(fs.readFileSync(target));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`更新源已启动: http://127.0.0.1:${port}${prefix}`);
  console.log(`目录: ${dir}`);
  if (!fs.existsSync(dir)) {
    console.log('（目录还不存在，先执行 npm run build && npm run update:pack）');
  }
  console.log('保持本窗口运行，然后在应用里点「检查更新」。');
});
