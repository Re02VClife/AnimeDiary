/**
 * 前端热更新
 *
 * 思路：把「前端资源（dist）」当作可独立更新的单元。
 *   - 内置资源随安装包发布（app 内的 dist/）
 *   - 更新包是一个 zip，解压到 userData/web-update/<version>/
 *   - 启动时比较两边版本，谁新用谁 —— 所以**只改前端时不需要重新安装，重启即生效**
 *   - 主进程（electron/）或依赖发生变化时，仍需发布新的安装包
 *
 * 更新源只需是一个静态目录/服务器（GitHub Release、网盘直链、局域网共享、自建静态服务都可以）：
 *   <updateUrl>/latest.json
 *     { "version": "1.0.1", "url": "AnimeDiary-web-1.0.1.zip", "notes": "...", "sha256": "..." }
 *   url 为相对路径时，相对 latest.json 所在地址解析；sha256 可选但建议填（校验下载完整性）。
 *
 * 更新包结构：zip 内直接是 dist 的内容（index.html / assets/... / version.json），
 * 或包一层 dist/ 目录也可以（会自动识别）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const UPDATE_ROOT_NAME = 'web-update';

/** 读取某个前端目录的版本信息（dist/version.json） */
function readWebVersion(dir) {
  try {
    const file = path.join(dir, 'version.json');
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return parsed && parsed.version ? parsed : null;
  } catch {
    return null;
  }
}

/** a 是否比 b 新（按点分段比较数字） */
function isNewer(a, b) {
  const pa = String(a || '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * 决定加载哪个前端目录：已下载的更新比内置的新就用更新
 * @returns {{ dir: string, version: string, source: 'builtin'|'update' }}
 */
function resolveWebDir({ builtinDistDir, userDataDir }) {
  const builtin = readWebVersion(builtinDistDir);
  const root = path.join(userDataDir, UPDATE_ROOT_NAME);
  let best = null;
  try {
    if (fs.existsSync(root)) {
      for (const name of fs.readdirSync(root)) {
        if (name.startsWith('.')) continue;
        const dir = path.join(root, name);
        if (!fs.existsSync(path.join(dir, 'index.html'))) continue;
        const v = readWebVersion(dir);
        if (!v) continue;
        if (!best || isNewer(v.version, best.version)) best = { dir, version: v.version };
      }
    }
  } catch { /* 目录不可读就当没有更新 */ }

  if (best && (!builtin || isNewer(best.version, builtin.version))) {
    return { dir: best.dir, version: best.version, source: 'update' };
  }
  return {
    dir: builtinDistDir,
    version: builtin ? builtin.version : '0.0.0',
    source: 'builtin',
  };
}

/**
 * 更新源既可以是 HTTP 静态目录，也可以是一个本地文件夹
 * （个人项目没有服务器时，把 zip + latest.json 丢进文件夹最省事）。
 */
function isLocalSource(url) {
  const u = String(url || '').trim();
  return /^file:\/\//i.test(u) || /^[a-zA-Z]:[\\/]/.test(u) || u.startsWith('\\\\');
}

/** 把本地源规范成文件系统路径 */
function toLocalPath(url) {
  let u = String(url || '').trim();
  if (/^file:\/\//i.test(u)) {
    u = decodeURIComponent(u.replace(/^file:\/\//i, ''));
    if (/^\/[a-zA-Z]:/.test(u)) u = u.slice(1); // file:///E:/x → E:/x
  }
  return u.replace(/[\\/]+$/, '');
}

function normalizeBase(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

/**
 * 拉取更新清单（latest.json）
 * @returns {{version:string, notes:string, zipUrl:string, sha256:string, local:boolean}}
 */
async function fetchLatest(updateUrl, timeoutMs = 8000) {
  const raw = String(updateUrl || '').trim();
  if (!raw) throw new Error('未配置更新源地址');

  const local = isLocalSource(raw);
  const base = local ? toLocalPath(raw) : normalizeBase(raw);
  let data;

  if (local) {
    const file = path.join(base, 'latest.json');
    if (!fs.existsSync(file)) {
      throw new Error(`更新源目录里没有 latest.json：${file}`);
    }
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (e) {
      throw new Error(`latest.json 解析失败：${e.message}`);
    }
  } else {
    const res = await fetch(`${base}/latest.json?t=${Date.now()}`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'Cache-Control': 'no-cache' },
    });
    if (!res.ok) throw new Error(`更新源返回 HTTP ${res.status}`);
    data = await res.json();
  }

  if (!data || !data.version) throw new Error('latest.json 缺少 version 字段');
  const rawUrl = data.url || `AnimeDiary-web-${data.version}.zip`;
  const zipUrl = local
    ? path.join(base, rawUrl)
    : /^https?:\/\//i.test(rawUrl)
      ? rawUrl
      : `${base}/${rawUrl.replace(/^\/+/, '')}`;

  return {
    version: String(data.version),
    notes: data.notes || '',
    zipUrl,
    sha256: String(data.sha256 || '').toLowerCase(),
    local,
  };
}

/**
 * 下载并解压更新包
 * 先解压到临时目录再整体改名，避免"下到一半"的半成品被当成可用版本。
 */
async function downloadUpdate({ latest, userDataDir, onProgress }) {
  let zipBuf;

  if (latest.local) {
    // 本地文件夹更新源：直接读文件
    if (!fs.existsSync(latest.zipUrl)) {
      throw new Error(`更新包不存在：${latest.zipUrl}`);
    }
    zipBuf = fs.readFileSync(latest.zipUrl);
    if (onProgress) onProgress({ received: zipBuf.length, total: zipBuf.length });
  } else {
    const res = await fetch(latest.zipUrl, { signal: AbortSignal.timeout(180000) });
    if (!res.ok) throw new Error(`下载更新包失败 HTTP ${res.status}`);

    const total = Number(res.headers.get('content-length') || 0);
    const chunks = [];
    let received = 0;
    const body = res.body;
    if (body && typeof body[Symbol.asyncIterator] === 'function') {
      for await (const chunk of body) {
        const buf = Buffer.from(chunk);
        chunks.push(buf);
        received += buf.length;
        if (onProgress) onProgress({ received, total });
      }
    } else {
      chunks.push(Buffer.from(await res.arrayBuffer()));
    }
    zipBuf = Buffer.concat(chunks);
  }

  if (latest.sha256) {
    const got = crypto.createHash('sha256').update(zipBuf).digest('hex');
    if (got !== latest.sha256) {
      throw new Error('更新包校验失败（sha256 不匹配），已丢弃');
    }
  }

  const root = path.join(userDataDir, UPDATE_ROOT_NAME);
  fs.mkdirSync(root, { recursive: true });
  const target = path.join(root, latest.version);
  const staging = path.join(root, `.staging-${latest.version}-${Date.now()}`);
  fs.mkdirSync(staging, { recursive: true });

  try {
    new AdmZip(zipBuf).extractAllTo(staging, true);
    const nested = path.join(staging, 'dist');
    const source = fs.existsSync(path.join(nested, 'index.html')) ? nested : staging;
    if (!fs.existsSync(path.join(source, 'index.html'))) {
      throw new Error('更新包内缺少 index.html');
    }
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(source, target);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }

  return { dir: target, version: latest.version };
}

/** 只保留最近 keep 份更新，避免长期占用磁盘 */
function pruneOldUpdates(userDataDir, activeVersion, keep = 3) {
  try {
    const root = path.join(userDataDir, UPDATE_ROOT_NAME);
    if (!fs.existsSync(root)) return;
    const dirs = fs
      .readdirSync(root)
      .filter((n) => !n.startsWith('.'))
      .map((n) => ({ name: n, dir: path.join(root, n) }))
      .filter((d) => fs.existsSync(path.join(d.dir, 'index.html')));
    // 当前使用的版本永远保留，其余按版本号从新到旧保留 keep 份
    dirs.sort((a, b) => (isNewer(a.name, b.name) ? -1 : 1));
    let kept = 0;
    for (const d of dirs) {
      if (d.name === activeVersion) continue;
      kept++;
      if (kept > keep) fs.rmSync(d.dir, { recursive: true, force: true });
    }
  } catch { /* 清理失败不影响使用 */ }
}

module.exports = {
  resolveWebDir,
  fetchLatest,
  downloadUpdate,
  pruneOldUpdates,
  readWebVersion,
  isNewer,
};
