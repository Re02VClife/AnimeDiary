/**
 * 生成前端热更新包
 *
 * 用法：npm run build && npm run update:pack
 * 产物：release/web-update/
 *   AnimeDiary-web-<version>.zip   前端资源（dist 的内容）
 *   latest.json                    更新清单（含 sha256）
 *
 * 把这两个文件放进 updateUrl 指向的目录即可，客户端下次启动会自动下载并生效。
 * 注意：只改前端（React 代码、样式）时用它；改了主进程、依赖或 Electron 版本，
 *       需要重新打包安装包。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const root = path.resolve(__dirname, '..');
const distDir = path.join(root, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
const outDir = path.join(root, 'release', 'web-update');

if (!fs.existsSync(path.join(distDir, 'index.html'))) {
  console.error('找不到 dist/index.html，请先执行 npm run build');
  process.exit(1);
}

const zipName = `AnimeDiary-web-${pkg.version}.zip`;
const zip = new AdmZip();
// 包内直接是 dist 的内容（index.html / assets / version.json）
zip.addLocalFolder(distDir);
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

console.log('已生成前端更新包：');
console.log(`  ${path.relative(root, path.join(outDir, zipName))}（${(buf.length / 1024).toFixed(1)} KB）`);
console.log(`  ${path.relative(root, path.join(outDir, 'latest.json'))}`);
console.log(`  版本 ${pkg.version}   sha256 ${sha256.slice(0, 16)}…`);
console.log('\n把这两个文件放进 updateUrl 指向的目录即可（本地验证用 npm run update:serve）。');
