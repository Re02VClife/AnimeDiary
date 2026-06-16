import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import XLSX from 'xlsx';
import AdmZip from 'adm-zip';

// Excel 文件路径
const EXCEL_PATH = 'C:\\Users\\24628\\Desktop\\vscode\\番评分.xlsx';

// ── Vite 插件：Excel 文件 I/O API ──
function excelApiPlugin(): Plugin {
  return {
    name: 'excel-api',
    configureServer(server) {
      // 读取 Excel 文件
      server.middlewares.use('/api/excel/read', (_req, res) => {
        try {
          if (!fs.existsSync(EXCEL_PATH)) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'Excel 文件不存在' }));
            return;
          }
          const wb = XLSX.readFile(EXCEL_PATH);
          const result: Record<string, unknown[][]> = {};
          wb.SheetNames.forEach((name) => {
            const ws = wb.Sheets[name];
            result[name] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
          });
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e instanceof Error ? e.message : '读取失败' }));
        }
      });

      // 写入 Excel 文件
      server.middlewares.use('/api/excel/write', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Method Not Allowed' }));
          return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => { chunks.push(chunk); });
        req.on('end', () => {
          try {
            // 使用 Buffer 拼接确保 UTF-8 中文正确处理
            const body = Buffer.concat(chunks).toString('utf-8');
            const updates = JSON.parse(body);
            if (!Array.isArray(updates)) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: '无效的更新数据' }));
              return;
            }
            const wb = XLSX.readFile(EXCEL_PATH);
            for (const update of updates) {
              const { sheetName, rowIndex, colIndex, value } = update;
              const ws = wb.Sheets[sheetName];
              if (!ws) continue;
              const cellAddr = XLSX.utils.encode_cell({ r: rowIndex, c: colIndex });
              ws[cellAddr] = { t: typeof value === 'number' ? 'n' : 's', v: value };
            }
            const wbOut = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
            fs.writeFileSync(EXCEL_PATH, wbOut);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: true }));
          } catch (e) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: e instanceof Error ? e.message : '写入失败' }));
          }
        });
        req.on('error', () => {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: '请求读取失败' }));
        });
      });

      // 文件信息
      server.middlewares.use('/api/excel/info', (_req, res) => {
        try {
          if (!fs.existsSync(EXCEL_PATH)) {
            res.end(JSON.stringify({ exists: false }));
            return;
          }
          const stat = fs.statSync(EXCEL_PATH);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            exists: true,
            path: EXCEL_PATH,
            size: stat.size,
            modifiedAt: stat.mtime.toISOString(),
          }));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e instanceof Error ? e.message : '读取信息失败' }));
        }
      });

      // ── 直接用系统默认程序打开 Excel 文件 ──
      server.middlewares.use('/api/excel/open', (_req, res) => {
        try {
          const cmd = process.platform === 'win32'
            ? `start "" "${EXCEL_PATH}"`
            : process.platform === 'darwin'
              ? `open "${EXCEL_PATH}"`
              : `xdg-open "${EXCEL_PATH}"`;
          exec(cmd, (err) => {
            if (err) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: '打开失败: ' + err.message }));
            } else {
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ success: true }));
            }
          });
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(e) }));
        }
      });

      // ── Bangumi 搜索代理 + 缓存 ──
      const CACHE_PATH = path.resolve(__dirname, 'bangumi_cache.json');
      // Bangumi API 镜像列表（优先尝试能连通的）
      const BANGUMI_APIS = [
        'https://bangumi.online/api',
        'https://api.bgm.tv',
      ];

      server.middlewares.use('/api/bangumi/search', async (req, res) => {
        const url = new URL(req.url!, 'http://localhost');
        const keyword = url.searchParams.get('keyword') || '';
        if (!keyword) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: '缺少 keyword 参数' }));
          return;
        }

        // 1. 查本地缓存（忽略空格和特殊字符的模糊匹配）
        try {
          if (fs.existsSync(CACHE_PATH)) {
            const cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
            // 精确匹配
            if (cache[keyword]) {
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ list: cache[keyword], cached: true }));
              return;
            }
            // 规范化匹配：去空格去特殊符号
            const norm = (s: string) => s.replace(/[\s\-_:：・().]+/g, '').toLowerCase();
            const kwNorm = norm(keyword);
            const matchedKeys = Object.keys(cache).filter((k) => {
              const kNorm = norm(k);
              return kNorm.includes(kwNorm) || kwNorm.includes(kNorm);
            });
            if (matchedKeys.length > 0) {
              const results = matchedKeys.flatMap((k) => cache[k]).slice(0, 20);
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ list: results, cached: true, partial: true }));
              return;
            }
          }
        } catch (_) { /* 缓存读取失败，继续 */ }

        // 2. 依次尝试镜像站代理请求
        let list: unknown[] = [];
        let connected = false;
        for (const apiBase of BANGUMI_APIS) {
          try {
            const apiUrl = `${apiBase}/search/subject/${encodeURIComponent(keyword)}?type=2&responseGroup=large`;
            console.log('[bangumi] 尝试:', apiBase);
            const resp = await fetch(apiUrl, {
              headers: { 'User-Agent': 'AnimeDiary/0.1 (private)' },
              signal: AbortSignal.timeout(8000),
            });
            if (resp.ok) {
              const data = await resp.json();
              list = (data.list || []).slice(0, 20);
              connected = true;
              console.log('[bangumi] 连接成功:', apiBase, '结果:', list.length);
              break;
            }
          } catch (e) {
            console.log('[bangumi] 镜像不可用:', apiBase);
          }
        }

        if (connected && list.length > 0) {
          // 3. 写入缓存
          try {
            let cache: Record<string, unknown> = {};
            if (fs.existsSync(CACHE_PATH)) {
              cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
            }
            cache[keyword] = list;
            fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf-8');
          } catch (_) { /* 缓存写入失败 */ }
        }

        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ list, cached: false, offline: !connected }));
      });

      // ── AniList 搜索代理 ──
      const ANILIST_CACHE_PATH = path.resolve(__dirname, 'anilist_cache.json');

      // 提供缓存文件读取
      server.middlewares.use('/api/anilist/cache', (_req, res) => {
        try {
          if (fs.existsSync(ANILIST_CACHE_PATH)) {
            const data = fs.readFileSync(ANILIST_CACHE_PATH, 'utf-8');
            res.setHeader('Content-Type', 'application/json');
            res.end(data);
          } else {
            res.end(JSON.stringify({}));
          }
        } catch (_) {
          res.end(JSON.stringify({}));
        }
      });

      server.middlewares.use('/api/anilist/search', async (req, res) => {
        const url = new URL(req.url!, 'http://localhost');
        const keyword = url.searchParams.get('keyword') || '';
        if (!keyword) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: '缺少 keyword 参数' }));
          return;
        }

        // 1. 查缓存
        try {
          if (fs.existsSync(ANILIST_CACHE_PATH)) {
            const cache = JSON.parse(fs.readFileSync(ANILIST_CACHE_PATH, 'utf-8'));
            const norm = (s: string) => s.replace(/[\s\-_:：・().]+/g, '').toLowerCase();
            const kwNorm = norm(keyword);
            for (const [key, val] of Object.entries(cache)) {
              if (norm(key).includes(kwNorm) || kwNorm.includes(norm(key))) {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ list: [val], cached: true }));
                return;
              }
            }
          }
        } catch (_) {}

        // 2. 请求 AniList API
        try {
          const escaped = keyword.replace(/"/g, '\\"').replace(/\n/g, ' ');
          const query = `{Page(page:1,perPage:8){media(search:"${escaped}",type:ANIME){id title{romaji english native}coverImage{large medium}averageScore episodes seasonYear}}}`;
          const resp = await fetch('https://graphql.anilist.co', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ query }),
            signal: AbortSignal.timeout(10000),
          });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const json = await resp.json();
          const list = (json?.data?.Page?.media || []).map((m: Record<string, unknown>) => ({
            id: m.id,
            name: (m as { title: { native?: string; romaji?: string; english?: string } }).title?.native || (m as { title: { romaji?: string } }).title?.romaji || '',
            name_cn: (m as { title: { native?: string } }).title?.native || '',
            images: {
              large: (m as { coverImage: { large?: string } }).coverImage?.large || '',
              common: (m as { coverImage: { medium?: string } }).coverImage?.medium || '',
              medium: (m as { coverImage: { medium?: string } }).coverImage?.medium || '',
              small: (m as { coverImage: { medium?: string } }).coverImage?.medium || '',
            },
            rating: { score: ((m.averageScore as number) || 0) / 10, total: 0 },
            air_date: (m.seasonYear as number) ? String(m.seasonYear) : '',
            eps: (m.episodes as number) || 0,
            summary: '',
          }));

          // 3. 写缓存
          if (list.length > 0) {
            try {
              let cache: Record<string, unknown> = {};
              if (fs.existsSync(ANILIST_CACHE_PATH)) {
                cache = JSON.parse(fs.readFileSync(ANILIST_CACHE_PATH, 'utf-8'));
              }
              cache[keyword] = list[0]; // 缓存最佳匹配
              fs.writeFileSync(ANILIST_CACHE_PATH, JSON.stringify(cache, null, 2), 'utf-8');
            } catch (_) {}
          }

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ list, cached: false }));
        } catch (e) {
          console.error('[anilist] 请求失败:', e);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ list: [], error: 'AniList API 暂时不可用' }));
        }
      });
      // ── 图片代理（解决外部 URL 跨域） ──
      server.middlewares.use('/api/images/proxy', async (req, res) => {
        const url = new URL(req.url!, 'http://localhost');
        const target = url.searchParams.get('url') || '';
        if (!target) { res.statusCode = 400; res.end('缺少 url'); return; }
        try {
          const resp = await fetch(target, { signal: AbortSignal.timeout(15000) });
          if (!resp.ok) { res.statusCode = resp.status; res.end('获取失败'); return; }
          const buffer = Buffer.from(await resp.arrayBuffer());
          const ct = resp.headers.get('content-type') || 'image/jpeg';
          res.setHeader('Content-Type', ct);
          res.setHeader('Cache-Control', 'max-age=86400');
          res.end(buffer);
        } catch {
          res.statusCode = 502;
          res.end('代理请求失败');
        }
      });

      // ── 图片本地存储 API ──
      const IMAGES_DIR = path.resolve(__dirname, 'images');

      // 列出某番剧的图片
      server.middlewares.use('/api/images/list', (req, res) => {
        const url = new URL(req.url!, 'http://localhost');
        const animeTitle = url.searchParams.get('animeTitle') || '';
        if (!animeTitle) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: '缺少 animeTitle' }));
          return;
        }
        const safeName = animeTitle.replace(/[\\/:*?"<>|]/g, '_').trim();
        const dir = path.join(IMAGES_DIR, safeName);
        try {
          if (!fs.existsSync(dir)) { res.end(JSON.stringify([])); return; }
          const files = fs.readdirSync(dir)
            .filter((f) => /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(f))
            .map((f) => {
              const stat = fs.statSync(path.join(dir, f));
              return {
                fileName: f,
                url: `/api/images/file?anime=${encodeURIComponent(safeName)}&file=${encodeURIComponent(f)}`,
                size: stat.size,
                mtime: stat.mtime.toISOString(),
              };
            });
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(files));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: '读取图片列表失败' }));
        }
      });

      // 保存图片到本地
      server.middlewares.use('/api/images/save', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ error: 'Method Not Allowed' })); return; }
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => { chunks.push(chunk); });
        req.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
            const { animeTitle, dataUrl } = body;
            if (!animeTitle || !dataUrl) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: '缺少 animeTitle 或 dataUrl' }));
              return;
            }
            const safeName = animeTitle.replace(/[\\/:*?"<>|]/g, '_').trim();
            const dir = path.join(IMAGES_DIR, safeName);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

            // 自动编号：找到已有文件的最大编号 + 1
            let maxNum = 0;
            if (fs.existsSync(dir)) {
              const existing = fs.readdirSync(dir);
              const re = new RegExp(`^${escapeRegExp(safeName)}_(\\d+)\\.`);
              for (const f of existing) {
                const m = f.match(re);
                if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
              }
            }
            const num = maxNum + 1;
            const ext = dataUrl.startsWith('data:image/png') ? '.png'
              : dataUrl.startsWith('data:image/webp') ? '.webp'
              : dataUrl.startsWith('data:image/gif') ? '.gif'
              : '.jpg';
            const fileName = `${safeName}_${num}${ext}`;
            const filePath = path.join(dir, fileName);

            // 解码 base64 写入文件
            const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, '');
            fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));

            const url = `/api/images/file?anime=${encodeURIComponent(safeName)}&file=${encodeURIComponent(fileName)}`;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: true, fileName, url, filePath: path.relative(__dirname, filePath) }));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e instanceof Error ? e.message : '保存失败' }));
          }
        });
      });

      // 删除本地图片
      server.middlewares.use('/api/images/delete', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ error: 'Method Not Allowed' })); return; }
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => { chunks.push(chunk); });
        req.on('end', () => {
          try {
            const { animeTitle, fileName } = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
            if (!animeTitle || !fileName) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: '缺少参数' }));
              return;
            }
            const safeName = animeTitle.replace(/[\\/:*?"<>|]/g, '_').trim();
            // 安全检查：防止路径穿越
            if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: '文件名非法' }));
              return;
            }
            const filePath = path.join(IMAGES_DIR, safeName, fileName);
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
              res.end(JSON.stringify({ success: true }));
            } else {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: '文件不存在' }));
            }
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e instanceof Error ? e.message : '删除失败' }));
          }
        });
      });

      // 提供图片静态文件
      server.middlewares.use('/api/images/file', (req, res) => {
        const url = new URL(req.url!, 'http://localhost');
        const anime = url.searchParams.get('anime') || '';
        const file = url.searchParams.get('file') || '';
        if (!anime || !file) { res.statusCode = 400; res.end('缺少参数'); return; }
        if (file.includes('..') || file.includes('/') || file.includes('\\')) {
          res.statusCode = 400; res.end('文件名非法'); return;
        }
        const filePath = path.join(IMAGES_DIR, anime, file);
        if (!fs.existsSync(filePath)) { res.statusCode = 404; res.end('文件不存在'); return; }
        const ext = path.extname(file).toLowerCase();
        const mime: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
        res.setHeader('Content-Type', mime[ext] || 'application/octet-stream');
        res.setHeader('Cache-Control', 'max-age=86400');
        res.end(fs.readFileSync(filePath));
      });

      // ── 一键备份：导出 ZIP（data.json + images/）──
      server.middlewares.use('/api/backup/export', async (_req, res) => {
        try {
          const zip = new AdmZip();

          // 1. 添加 images/ 目录（如果存在且有内容）
          if (fs.existsSync(IMAGES_DIR)) {
            const entries = fs.readdirSync(IMAGES_DIR, { withFileTypes: true });
            for (const entry of entries) {
              if (entry.isDirectory()) {
                const animeDir = path.join(IMAGES_DIR, entry.name);
                const files = fs.readdirSync(animeDir);
                for (const f of files) {
                  const filePath = path.join(animeDir, f);
                  if (fs.statSync(filePath).isFile()) {
                    zip.addLocalFile(filePath, `images/${entry.name}`);
                  }
                }
              }
            }
          }

          // 2. 添加空的 data.json 占位（实际数据由前端 localStorage 提供）
          //    前端导出时也会把自己的 data 序列化进去——这里只负责 images 部分
          //    所以 ZIP 先只包含 images，前端下载后需要合并...
          //    更好的方案：前端先上传 data，后端打包。但导出是 GET。
          //    折中：后端只打包 images，前端自己合并 data.json
          //    实际上最简单：前端把 data.json 也生成好，通过 POST 发给后端打包？
          //    不行太复杂。改方案：后端只提供 images.zip，前端自己生成完整 ZIP
          //    用 JSZip 在前端生成完整 ZIP... 引入 JSZip 到前端？

          // ── 最终方案：后端打包 images.zip，前端也生成 data.json，然后前端合并为完整 ZIP ──
          // 太复杂。换成：后端打包 images 为 ZIP，data 走单独的 .animebackup JSON
          // 用户下载两个文件？不好。

          // ── 实际可行方案：后端直接返回 ZIP（含 data 占位 + images）──
          // 前端先调用此 API 获取 ZIP，然后... 不对，前端 data 不在这里。
          // 最简方案：images/ 导出为 ZIP，前端单独导出 data.json。
          // 导入时也一样：上传 ZIP（仅 images），上传 JSON（data）。

          // 但用户要"一键"。让我换个角度：
          // 导出时前端把 data.json 内容作为 query param 或 body 发给后端，
          // 后端打包进 ZIP 一起返回。虽然是 POST 但可以触发下载。
          // 就用 POST + 返回 blob 的方式。

          // 既然导出需要 POST（带 data），那 GET 只做 images 打包...
          // 算了，让我同时支持两个端点：GET /api/backup/images（仅 images.zip）
          // 前端导出时自己打包 data.json + 让用户也下载 images.zip？
          // 不好。让我直接用 adm-zip 在导出时打包全部。

          // 改方案：GET /api/backup/export 只打包 images 为 ZIP 并返回。
          // 前端导出时：1) 下载 images ZIP  2) 下载 data.json → 用户得到两个文件
          // 导入时：1) 上传 images ZIP → 解包  2) 上传 data.json → 恢复

          // 这样不够"一键"。让我改 POST 方案：
          // POST /api/backup/export  body={localStorage:{...},indexedDB:{...}}
          // → 后端把 data 写入 ZIP 中的 data.json，连同 images/ 一起打包返回

          // 导入时也一样：POST /api/backup/import (multipart ZIP)
          // → 后端解包 images/，返回 data.json 给前端恢复

          // 就用这个方案！

          // 由于导出变 POST，前端需要用 fetch + Blob 下载
          // OK 就这么定了。

          // 等等，当前这个 handler 是 GET /api/backup/export，我先让它只打包 images
          // 作为简单版。完整的 POST 方案我稍后再做。

          const buf = zip.toBuffer();
          res.setHeader('Content-Type', 'application/zip');
          res.setHeader('Content-Disposition', 'attachment; filename="AnimeDiary_images.zip"');
          res.setHeader('Content-Length', buf.length);
          res.end(buf);
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: '备份导出失败: ' + (e instanceof Error ? e.message : '') }));
        }
      });

      // ── 一键备份导出（POST：前端发送 data JSON，后端打包 ZIP 返回）──
      server.middlewares.use('/api/backup/export-full', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method Not Allowed'); return; }
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString());
            const zip = new AdmZip();

            // 1. 前端传来的 data.json
            zip.addFile('data.json', Buffer.from(JSON.stringify(body, null, 2), 'utf-8'));

            // 2. images/ 目录
            if (fs.existsSync(IMAGES_DIR)) {
              const entries = fs.readdirSync(IMAGES_DIR, { withFileTypes: true });
              for (const entry of entries) {
                if (entry.isDirectory()) {
                  const animeDir = path.join(IMAGES_DIR, entry.name);
                  const files = fs.readdirSync(animeDir);
                  for (const f of files) {
                    const filePath = path.join(animeDir, f);
                    if (fs.statSync(filePath).isFile()) {
                      zip.addLocalFile(filePath, `images/${entry.name}`);
                    }
                  }
                }
              }
            }

            const buf = zip.toBuffer();
            const date = new Date().toISOString().split('T')[0];
            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Disposition', `attachment; filename="AnimeDiary_backup_${date}.zip"`);
            res.setHeader('Content-Length', buf.length);
            res.end(buf);
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: '导出失败: ' + (e instanceof Error ? e.message : '') }));
          }
        });
      });

      // ── 一键备份导入（POST multipart ZIP，返回 data.json）──
      server.middlewares.use('/api/backup/import', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method Not Allowed'); return; }
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          try {
            // 简易 multipart 解析（只取 ZIP 部分）
            const raw = Buffer.concat(chunks).toString('binary');
            const boundaryMatch = raw.match(/boundary=([^\r\n]+)/);
            if (boundaryMatch) {
              const boundary = boundaryMatch[1];
              const parts = raw.split(`--${boundary}`);
              for (const part of parts) {
                const headerEnd = part.indexOf('\r\n\r\n');
                if (headerEnd === -1) continue;
                const header = part.slice(0, headerEnd);
                if (header.includes('filename=')) {
                  // ZIP 内容在 header 后的两个 \r\n 之后，到下一个 boundary 之前
                  const bodyStart = headerEnd + 4;
                  const bodyEnd = part.lastIndexOf('\r\n--');
                  const zipData = part.slice(bodyStart, bodyEnd > 0 ? bodyEnd : part.length);
                  const zip = new AdmZip(Buffer.from(zipData, 'binary'));

                  // 1. 解包 data.json
                  let dataJson: Record<string, unknown> | null = null;
                  const dataEntry = zip.getEntry('data.json');
                  if (dataEntry) {
                    dataJson = JSON.parse(dataEntry.getData().toString('utf-8'));
                  }

                  // 2. 解包 images/ 到本地
                  const imgEntries = zip.getEntries().filter((e) => e.entryName.startsWith('images/') && !e.isDirectory);
                  for (const img of imgEntries) {
                    // entryName: "images/白箱/白箱_1.png"
                    const relativePath = img.entryName.slice('images/'.length); // "白箱/白箱_1.png"
                    const targetPath = path.join(IMAGES_DIR, relativePath);
                    const targetDir = path.dirname(targetPath);
                    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
                    fs.writeFileSync(targetPath, img.getData());
                  }

                  // 3. 返回 data.json 给前端恢复 localStorage/IndexedDB
                  res.setHeader('Content-Type', 'application/json');
                  res.end(JSON.stringify({ success: true, data: dataJson }));
                  return;
                }
              }
            }
            res.statusCode = 400;
            res.end(JSON.stringify({ error: '无法解析上传文件' }));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: '导入失败: ' + (e instanceof Error ? e.message : '') }));
          }
        });
      });
    },
  };
}

/** 转义正则特殊字符 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default defineConfig({
  plugins: [react(), excelApiPlugin()],
  base: './',
  root: '.',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
