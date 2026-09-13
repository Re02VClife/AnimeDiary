/**
 * electron-builder 的 afterPack 钩子：写入应用图标与版本信息
 *
 * 为什么需要它：
 *   本机没有代码签名证书，且 Windows 默认不允许普通用户创建符号链接 ——
 *   electron-builder 内置的 winCodeSign 流程会因此在解压阶段失败。
 *   所以 package.json 里关掉了 win.signAndEditExecutable，
 *   改在这里用随项目携带的 rcedit 直接写入图标与版本资源。
 *
 * 若将来配置了签名证书，可把 signAndEditExecutable 改回 true 并删除本钩子。
 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

/** rcedit 位置：优先项目内自带，退回 electron-builder 缓存 */
function resolveRcedit() {
  const inProject = path.resolve(__dirname, '..', 'build', 'rcedit-x64.exe');
  if (fs.existsSync(inProject)) return inProject;
  const fromCache = path.join(
    process.env.LOCALAPPDATA || '',
    'electron-builder',
    'Cache',
    'winCodeSign-2.6.0',
    'rcedit-x64.exe',
  );
  return fs.existsSync(fromCache) ? fromCache : null;
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const exeName = `${context.packager.appInfo.productFilename}.exe`;
  const exePath = path.join(context.appOutDir, exeName);
  const iconPath = path.resolve(__dirname, '..', 'build', 'icon.ico');
  const rcedit = resolveRcedit();

  if (!fs.existsSync(exePath)) {
    console.warn(`[after-pack] 找不到 ${exePath}，跳过`);
    return;
  }
  if (!rcedit || !fs.existsSync(iconPath)) {
    console.warn('[after-pack] 缺少 rcedit 或 build/icon.ico，跳过图标写入');
    return;
  }

  const version = context.packager.appInfo.version;
  execFileSync(rcedit, [
    exePath,
    '--set-icon', iconPath,
    '--set-version-string', 'ProductName', 'AnimeDiary',
    '--set-version-string', 'FileDescription', 'AnimeDiary - 番剧评分管理',
    '--set-version-string', 'CompanyName', 'AnimeDiary',
    '--set-version-string', 'LegalCopyright', 'MIT License',
    '--set-file-version', version,
    '--set-product-version', version,
  ]);

  console.log(`[after-pack] 已写入图标与版本信息：${exeName} v${version}`);
};
