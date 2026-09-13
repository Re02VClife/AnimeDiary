/**
 * 生成前端热更新包
 *
 * 用法：npm run update:pack
 * 产物：release/web-update/
 *   AnimeDiary-web-<version>.zip   前端资源（dist）+ 服务端路由实现
 *   latest.json                    更新清单（含 sha256）
 *
 * 把这两个文件放进 updateUrl 指向的目录即可，客户端下次启动会自动下载并生效。
 *
 * 包里为什么带 server/api-routes.cjs：
 *   装好的应用把服务端代码打进了 app.asar，**改一次后端就得重装**，
 *   这跟「从本地文件夹热更新」的初衷冲突（实测踩过：新加的 /api/character/*
 *   路由在装了 1.0.15 的应用里 404，前端拿到的是非 JSON 响应）。
 *   所以这里把服务端路由实现一起放进更新包，主进程优先加载更新目录里的那一份，
 *   加载失败（文件坏了/导出不对）会自动回退到内置版本，不至于把应用弄成打不开。
 *
 * 仍然需要重装的情况：改了主进程（electron/*.js）、改了依赖、或升级了 Electron。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const root = path.resolve(__dirname, '..');
const distDir = path.join(root, 'dist');
const serverRoutes = path.join(root, 'server', 'api-routes.cjs');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
const outDir = path.join(root, 'release', 'web-update');

if (!fs.existsSync(path.join(distDir, 'index.html'))) {
  console.error('找不到 dist/index.html，请先执行 vite build');
  process.exit(1);
}
if (!fs.existsSync(serverRoutes)) {
  console.error('找不到 server/api-routes.cjs，请先执行 npm run build:api');
  process.exit(1);
}

const zipName = `AnimeDiary-web-${pkg.version}.zip`;
const zip = new AdmZip();
// 包内直接是 dist 的内容（index.html / assets / version.json）
zip.addLocalFolder(distDir);
// 服务端路由实现放到包内的 server/ 下，主进程按 <webDir>/server/api-routes.cjs 找它
zip.addLocalFile(serverRoutes, 'server');
const buf = zip.toBuffer();
const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, zipName), buf);
fs.writeFileSync(
  path.join(outDir, 'latest.json'),
  JSON.stringify(
    {
      version: pkg.version,
      url: zipName,
      sha256,
      notes: process.argv[2] || '',
      releasedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
  'utf-8',
);

console.log('已生成热更新包（前端 + 服务端路由）：');
console.log(`  ${path.relative(root, path.join(outDir, zipName))}（${(buf.length / 1024).toFixed(1)} KB）`);
console.log(`  ${path.relative(root, path.join(outDir, 'latest.json'))}`);
console.log(`  版本 ${pkg.version}   sha256 ${sha256.slice(0, 16)}…`);
console.log(`  含服务端路由 ${path.relative(root, serverRoutes)}`);
console.log('\n把这两个文件放进 updateUrl 指向的目录即可（本地验证用 npm run update:serve）。');
