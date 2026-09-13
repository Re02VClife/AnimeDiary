/**
 * 把 build/icons/*.png 合成为 build/icon.ico
 * ICO 允许直接内嵌 PNG（Vista+），因此不需要额外图形库。
 * 用法：node scripts/make-ico.js
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const iconsDir = path.join(root, 'build', 'icons');
const outPath = path.join(root, 'build', 'icon.ico');

const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map((s) => {
  const p = path.join(iconsDir, `icon-${s}.png`);
  if (!fs.existsSync(p)) throw new Error(`缺少 ${p}，请先运行 scripts/make-icon.ps1`);
  return { size: s, data: fs.readFileSync(p) };
});

const count = images.length;
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type = icon
header.writeUInt16LE(count, 4);

const entries = Buffer.alloc(16 * count);
let offset = 6 + 16 * count;
images.forEach((img, i) => {
  const e = i * 16;
  // 256 在 ICO 目录项里用 0 表示
  const dim = img.size >= 256 ? 0 : img.size;
  entries.writeUInt8(dim, e + 0);
  entries.writeUInt8(dim, e + 1);
  entries.writeUInt8(0, e + 2); // 调色板数
  entries.writeUInt8(0, e + 3); // reserved
  entries.writeUInt16LE(1, e + 4); // planes
  entries.writeUInt16LE(32, e + 6); // 位深
  entries.writeUInt32LE(img.data.length, e + 8);
  entries.writeUInt32LE(offset, e + 12);
  offset += img.data.length;
});

fs.writeFileSync(outPath, Buffer.concat([header, entries, ...images.map((i) => i.data)]));
console.log(`已生成 build/icon.ico（${fs.statSync(outPath).size} 字节，含 ${count} 个尺寸：${sizes.join('/')}）`);
