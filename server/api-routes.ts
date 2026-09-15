/**
 * /api 路由 —— Vite dev server 与 Electron 生产模式**共用同一份实现**
 *
 * 本文件由 scripts/extract-api-routes.js 从 vite.config.ts 的中间件体机械提取而来，
 * 目的是让打包后的桌面应用也拥有完整的后端能力（Excel / 图片 / 备份 / 抓取代理）。
 *
 * 约定：
 *   - 导出 createApiHandler({ DATA_DIR })，返回 connect 风格中间件 (req, res, next)
 *   - 路径前缀匹配与原 connect 语义一致；handler 只读 query，不依赖被剥离的 url
 *   - 一切数据文件（Excel / images / backups / 缓存）都位于 DATA_DIR 下：
 *       dev  → 项目根目录
 *       prod → 用户文档目录 / AnimeDiary
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import XLSX from 'xlsx';
import AdmZip from 'adm-zip';
import { createMediaClient, isAllowedCoverHost, isPublicHttpUrl, describeError } from './media-sources';
import type { FetchLike, MediaSource } from './media-sources';
import { createCharacterClient } from './character-sources';

/** 数据根目录 */
export interface ApiContext {
  DATA_DIR: string;
  /**
   * 网络出口。
   *   Electron 主进程传 `net.fetch` → 走 Chromium 网络栈，**自动遵守系统代理**；
   *   不传则回落到全局 fetch —— 注意 Node 的 fetch(undici) 完全不读系统代理，
   *   这正是打包后 /api/bangumi/* 一直连不上 api.bgm.tv 的根因。
   */
  fetchImpl?: FetchLike;
}

type ApiHandler = (req: any, res: any) => void;

/**
 * 创建 /api 处理器。
 * 命中路由时自行响应；未命中调用 next()，由宿主决定后续
 * （dev: 交给 Vite；prod: 交给静态文件服务或 404）。
 */
export function createApiHandler({ DATA_DIR, fetchImpl }: ApiContext) {
  const EXCEL_PATH = path.join(DATA_DIR, '番评分.xlsx');
  const IMAGES_DIR = path.join(DATA_DIR, 'images');
  const BACKUP_DIR = path.join(DATA_DIR, 'backups');
  /** 多代快照最多保留份数（原 vite.config.ts 的常量） */
  const BACKUP_KEEP = 10;
  /**
   * 番剧元数据/封面获取客户端。
   * 传入宿主注入的 fetchImpl，使请求走上与页面一致（且遵守系统代理）的网络栈。
   */
  const media = createMediaClient({ fetchImpl });
  /**
   * Excel 单元格字符上限（32767）。超限时 SheetJS 会抛出
   * "Text length must not exceed 32767 characters" 并中止整批写入，
   * 用户既看不懂也不知道是哪一条数据的问题，所以写前主动拦截。
   */
  const MAX_CELL_CHARS = 32767;

  const routes: { prefix: string; handler: ApiHandler }[] = [];
  const router = {
    use(prefix: string, handler: ApiHandler) {
      routes.push({ prefix, handler });
    },
  };

  // ── 辅助函数（原 vite.config.ts 内） ──
  /** 列出快照文件（文件名带时间戳，排序即 旧 → 新） */
  function listExcelSnapshots(): string[] {
    try {
      if (!fs.existsSync(BACKUP_DIR)) return [];
      return fs.readdirSync(BACKUP_DIR)
        .filter((f) => f.startsWith('番评分.') && f.endsWith('.xlsx'))
        .sort();
    } catch { return []; }
  }

  /**
   * 写入前留一份多代快照。
   * 只在「当前内容与最新快照不同」时才产生新文件（按内容 hash 去重），
   * 所以频繁保存不会堆出成百上千份；最多保留 BACKUP_KEEP 份，超出删最旧的。
   */
  function snapshotExcel(): void {
    try {
      if (!fs.existsSync(EXCEL_PATH)) return;
      const current = fs.readFileSync(EXCEL_PATH);
      const hash = crypto.createHash('sha1').update(current).digest('hex').slice(0, 12);
      if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

      const existing = listExcelSnapshots();
      const latest = existing[existing.length - 1];
      if (latest) {
        const latestBuf = fs.readFileSync(path.join(BACKUP_DIR, latest));
        if (crypto.createHash('sha1').update(latestBuf).digest('hex').slice(0, 12) === hash) {
          return; // 内容未变，不必再存一份
        }
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      fs.writeFileSync(path.join(BACKUP_DIR, `番评分.${stamp}.${hash}.xlsx`), current);

      const after = listExcelSnapshots();
      while (after.length > BACKUP_KEEP) {
        const oldest = after.shift()!;
        try { fs.unlinkSync(path.join(BACKUP_DIR, oldest)); } catch { /* ignore */ }
      }
    } catch (e) {
      // 快照失败不阻塞写入，但必须可见 —— "以为有备份"比没有备份更危险
      console.warn('[excel] 多代快照失败:', e instanceof Error ? e.message : e);
    }
  }

  // ── 安全与写入辅助 ──

  /**
   * 原子写文件：先写临时文件再 rename，写入前留一份多代快照。
   * 原来直接 writeFileSync 覆盖，写一半崩溃会毁掉整个 Excel。
   */
  function writeFileAtomic(filePath: string, data: Buffer): void {
    // 写入前留多代快照（仅 Excel 主数据；快照自身失败不会阻塞写入，但会打印警告）
    if (filePath === EXCEL_PATH) snapshotExcel();
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.writeFileSync(tmpPath, data);
      fs.renameSync(tmpPath, filePath);
    } catch (e) {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      throw e;
    }
  }

  /**
   * 把若干路径片段拼到 baseDir 下，并确保结果仍在 baseDir 内。
   * 越界（路径穿越）返回 null。用于取代只做字符替换的"安全检查"。
   */
  function resolveInside(baseDir: string, ...parts: string[]): string | null {
    const base = path.resolve(baseDir);
    const target = path.resolve(base, ...parts);
    if (target !== base && !target.startsWith(base + path.sep)) return null;
    return target;
  }

  /** 目录名/子路径片段是否安全：非空、不是 . 或 ..、不含分隔符 */
  function isSafePathSegment(name: unknown): name is string {
    if (typeof name !== 'string') return false;
    const t = name.trim();
    return t.length > 0 && t !== '.' && t !== '..' && !/[\\/]/.test(t);
  }

  // ── 路由注册（原 configureServer 内） ──
        // 读取 Excel 文件
        router.use('/api/excel/read', (_req, res) => {
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
        router.use('/api/excel/write', (req, res) => {
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

              // ── 写前身份校验 ──
              // 客户端把「加载时该行应有的标题」一并送来，这里逐行比对。
              // 不匹配说明 Excel 被外部改过（插行/排序/改标题），此时按旧行号写入会覆盖别的番剧，
              // 所以整批拒绝并回报冲突行，由前端提示用户刷新。
              const expectedRows: { rowIndex: number; title: string; sheetName: string }[] = [];
              for (const u of updates) {
                if (typeof u?.expectedTitle === 'string' && u.expectedTitle) {
                  const dup = expectedRows.some((e) => e.sheetName === u.sheetName && e.title === u.expectedTitle);
                  if (!dup) expectedRows.push({ rowIndex: u.rowIndex, title: u.expectedTitle, sheetName: u.sheetName });
                }
              }
              const conflicts: { rowIndex: number; expected: string; actual: string; ambiguous?: boolean }[] = [];
              for (const info of expectedRows) {
                const wsCheck = wb.Sheets[info.sheetName];
                if (!wsCheck) continue;
                const expected = info.title.trim();
                // 该行标题对得上 → 位置没变，直接用
                const atRow = String(wsCheck[XLSX.utils.encode_cell({ r: info.rowIndex, c: 1 })]?.v ?? '').trim();
                if (atRow === expected) continue;
                // 对不上 → 在全表标题列里唯一地找一次（用户插过/删过/排序过行）
                const range = XLSX.utils.decode_range(wsCheck['!ref'] || 'A1');
                const matches: number[] = [];
                for (let r = Math.max(1, range.s.r); r <= range.e.r; r++) {
                  const t = String(wsCheck[XLSX.utils.encode_cell({ r, c: 1 })]?.v ?? '').trim();
                  if (t === expected) matches.push(r);
                }
                if (matches.length === 1) {
                  // 唯一匹配：把本次写入自动改到新行号，避免写到别的番剧上
                  for (const u of updates) {
                    if (u.sheetName === info.sheetName && u.expectedTitle === info.title) u.rowIndex = matches[0];
                  }
                } else {
                  conflicts.push({
                    rowIndex: info.rowIndex,
                    expected: info.title,
                    actual: atRow,
                    ambiguous: matches.length > 1,
                  });
                }
              }
              if (conflicts.length > 0) {
                res.statusCode = 409;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({
                  error: 'Excel 数据已变化，为避免写错行已取消本次保存',
                  conflicts,
                }));
                return;
              }

              // ── 单元格长度守卫（见 MAX_CELL_CHARS） ──
              const oversized = (updates as { rowIndex: number; colIndex: number; value: unknown }[])
                .find((u) => typeof u.value === 'string' && u.value.length > MAX_CELL_CHARS);
              if (oversized) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({
                  error: `第 ${oversized.rowIndex + 1} 行、第 ${oversized.colIndex + 1} 列的内容过长`
                    + `（${(oversized.value as string).length} 字符，超过 Excel 单元格上限 ${MAX_CELL_CHARS}），已取消本次保存`,
                }));
                return;
              }

              for (const update of updates) {
                const { sheetName, rowIndex, colIndex, value } = update;
                const ws = wb.Sheets[sheetName];
                if (!ws) continue;
                // 使用 sheet_add_aoa 替代直接赋值，它会自动扩展 !ref 范围
                const cellAddr = XLSX.utils.encode_cell({ r: rowIndex, c: colIndex });
                XLSX.utils.sheet_add_aoa(ws, [[value]], { origin: cellAddr });
              }
              const wbOut = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
              writeFileAtomic(EXCEL_PATH, wbOut);
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

        // 追加新行到 Excel（用于新建条目首次保存）
        router.use('/api/excel/append', (req, res) => {
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
              const { sheetName, row } = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
              const wb = XLSX.readFile(EXCEL_PATH);
              const ws = wb.Sheets[sheetName];
              if (!ws) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: 'Sheet 不存在' }));
                return;
              }
              // 找到最后有数据的行号，新行追加到其后
              const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
              const newRowIdx = range.e.r + 1;
              // ── 单元格长度守卫（见 MAX_CELL_CHARS） ──
              const oversizedCell = Object.entries(row as Record<string, unknown>)
                .find(([, v]) => typeof v === 'string' && v.length > MAX_CELL_CHARS);
              if (oversizedCell) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({
                  error: `第 ${parseInt(oversizedCell[0], 10) + 1} 列的内容过长`
                    + `（${(oversizedCell[1] as string).length} 字符，超过 Excel 单元格上限 ${MAX_CELL_CHARS}），已取消本次保存`,
                }));
                return;
              }
              for (const [colIdx, value] of Object.entries(row)) {
                const cellAddr = XLSX.utils.encode_cell({ r: newRowIdx, c: parseInt(colIdx) });
                XLSX.utils.sheet_add_aoa(ws, [[value]], { origin: cellAddr });
              }
              const wbOut = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
              writeFileAtomic(EXCEL_PATH, wbOut);
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ success: true, rowIndex: newRowIdx }));
            } catch (e) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: e instanceof Error ? e.message : '追加失败' }));
            }
          });
        });

        // 用上传的 xlsx 替换数据源文件（「导入 Excel」的落盘实现）
        router.use('/api/excel/replace', (req, res) => {
          if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ error: 'Method Not Allowed' })); return; }
          const chunks: Buffer[] = [];
          req.on('data', (c: Buffer) => chunks.push(c));
          req.on('end', () => {
            try {
              const buf = Buffer.concat(chunks);
              if (buf.length === 0) { res.statusCode = 400; res.end(JSON.stringify({ error: '文件为空' })); return; }
              // 先确认能解析出工作表，避免把损坏/选错的文件写进去
              const wb = XLSX.read(buf, { type: 'buffer' });
              if (!wb.SheetNames || wb.SheetNames.length === 0) {
                res.statusCode = 400; res.end(JSON.stringify({ error: '不是有效的 Excel 文件' })); return;
              }
              writeFileAtomic(EXCEL_PATH, buf); // 内部会先留一份多代快照，可回滚
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ success: true, sheets: wb.SheetNames }));
            } catch (e) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: '解析失败：' + (e instanceof Error ? e.message : '') }));
            }
          });
        });

        // 文件信息
        router.use('/api/excel/info', (_req, res) => {
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
        router.use('/api/excel/open', (_req, res) => {
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
        const CACHE_PATH = path.join(DATA_DIR, 'bangumi_cache.json');
        const BANGUMI_REVIEW_CACHE_PATH = path.join(DATA_DIR, 'bangumi_review_cache.json');
        // Bangumi API 地址。
        // 曾把第三方镜像 'https://bangumi.online/api' 排在首位，但它早已失效，
        // 于是每次请求都要先白等一个 8s 超时才轮到官方域名 —— 现已移除。
        const BANGUMI_APIS = [
          'https://api.bgm.tv',
        ];

        router.use('/api/bangumi/search', async (req, res) => {
          const url = new URL(req.url!, 'http://localhost');
          const keyword = url.searchParams.get('keyword') || '';
          const force = url.searchParams.get('force') === '1';
          if (!keyword) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: '缺少 keyword 参数' }));
            return;
          }

          // 1. 查本地缓存（force=1 时跳过）
          if (!force) { try {
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
          } catch (_) { /* 缓存读取失败，继续 */ } } // if (!force)

          // 2. 走官方 v0 接口（不再用已弃用的 GET /search/subject/{kw}?responseGroup=large）
          //    返回结构保持历史形状（name/name_cn/images/air_date/rating/tags），
          //    因为 AI 分析模块（auto-tag / smart-recommend）与搜索新增弹窗都依赖它。
          let list: unknown[] = [];
          let connected = false;
          let failure = '';
          try {
            const candidates = await media.search('bangumi', keyword, 20);
            connected = true;
            list = candidates.map((c) => ({
              id: Number(c.sourceId),
              name: c.title,
              name_cn: c.titleCn,
              summary: c.summary,
              images: {
                large: c.coverUrl,
                common: c.coverUrl,
                medium: c.coverUrl,
                small: c.coverUrl,
                grid: c.coverUrl,
              },
              air_date: c.releaseDate || '',
              eps: c.episodes ?? 0,
              rating: { score: c.score ?? 0, total: 0, rank: 0 },
              // 历史形状里 tags 是对象数组，auto-tag 只读 .name
              tags: c.tags.map((name) => ({ name, count: 0 })),
              aliases: c.aliases,
              studio: c.studio,
              source: c.source,
              link: c.link,
            }));
          } catch (e) {
            failure = describeError(e);
            console.log('[bangumi] v0 搜索失败:', failure);
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
          res.end(JSON.stringify({ list, cached: false, offline: !connected, error: failure || undefined }));
        });

        // ── Bangumi 评论采集（深度模式用）──
        router.use('/api/bangumi/reviews', async (req, res) => {
          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Method Not Allowed' }));
            return;
          }
          const chunks: Buffer[] = [];
          req.on('data', (c: Buffer) => chunks.push(c));
          req.on('end', async () => {
            try {
              const { titles } = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
              if (!Array.isArray(titles) || titles.length === 0) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: '缺少 titles 数组' }));
                return;
              }

              // 读缓存
              let cache: Record<string, unknown> = {};
              const now = Date.now();
              const TTL = 24 * 60 * 60 * 1000; // 24h
              try {
                if (fs.existsSync(BANGUMI_REVIEW_CACHE_PATH)) {
                  cache = JSON.parse(fs.readFileSync(BANGUMI_REVIEW_CACHE_PATH, 'utf-8'));
                }
              } catch (_) { /* ignore */ }

              const results: Record<string, unknown> = {};
              let cacheUpdated = false;

              for (const title of titles) {
                // 检查缓存
                const cached = cache[title] as { ts?: number; data?: unknown } | undefined;
                if (cached?.data && cached.ts && (now - cached.ts < TTL)) {
                  results[title] = cached.data;
                  continue;
                }

                // 搜索 subject
                let subject: Record<string, unknown> | null = null;
                for (const apiBase of BANGUMI_APIS) {
                  try {
                    const searchUrl = `${apiBase}/search/subject/${encodeURIComponent(title)}?type=2&responseGroup=large`;
                    const resp = await fetch(searchUrl, {
                      headers: { 'User-Agent': 'AnimeDiary/1.0 (private)' },
                      signal: AbortSignal.timeout(8000),
                    });
                    if (resp.ok) {
                      const data = await resp.json();
                      if (data.list?.length > 0) {
                        subject = data.list[0];
                        break;
                      }
                    }
                  } catch { continue; }
                }

                if (!subject) {
                  results[title] = { subjectId: null, error: '未找到' };
                  // 仍写入缓存（短暂缓存避免重复查询）
                  cache[title] = { ts: now, data: results[title] };
                  cacheUpdated = true;
                  continue;
                }

                const sid = (subject as { id: number }).id;
                const summary = (subject as { summary?: string }).summary || '';
                const rating = (subject as { rating?: { score?: number; total?: number } }).rating;
                const tags = (subject as { tags?: Array<{ name: string; count: number }> }).tags || [];
                const name = (subject as { name_cn?: string; name?: string }).name_cn
                  || (subject as { name?: string }).name || title;

                // 构建社区评论数据：摘要 + 标签作为"社区评价"
                const tagNames = tags.slice(0, 15).map((t: { name: string; count: number }) =>
                  `${t.name}(${t.count}人标记)`);

                // 尝试获取更多评论数据（Bangumi subject 相关条目）
                let extraReviews: string[] = [];
                try {
                  // 部分镜像可能支持获取相关评论
                  const subjectUrl = `${BANGUMI_APIS[0]}/subject/${sid}`;
                  const subjectResp = await fetch(subjectUrl, {
                    headers: { 'User-Agent': 'AnimeDiary/1.0 (private)' },
                    signal: AbortSignal.timeout(5000),
                  });
                  if (subjectResp.ok) {
                    const detail = await subjectResp.json();
                    // 收集额外信息作为"评论"
                    if (detail.infobox) {
                      const infobox = detail.infobox as Array<{ key: string; value: string }>;
                      const infoText = infobox
                        .filter((i) => ['话数', '放送开始', '放送星期', '官方网站', '播放结束'].includes(i.key))
                        .map((i) => `${i.key}: ${i.value}`)
                        .join('; ');
                      if (infoText) extraReviews.push(`基本信息: ${infoText}`);
                    }
                  }
                } catch { /* 忽略 */ }

                // 组装社区评价文本
                const communityReviews = [
                  summary ? `Bangumi简介: ${summary.slice(0, 500)}` : null,
                  tagNames.length > 0 ? `社区标签: ${tagNames.join(', ')}` : null,
                  rating?.score ? `Bangumi评分: ${rating.score}/10 (${rating.total || 0}人评分)` : null,
                  ...extraReviews,
                ].filter(Boolean) as string[];

                const data = {
                  subjectId: sid,
                  name,
                  rating: rating || null,
                  tags: tagNames,
                  reviews: communityReviews,
                  reviewCount: communityReviews.length,
                };

                results[title] = data;
                cache[title] = { ts: now, data };
                cacheUpdated = true;

                // 请求间隔 1s（避免限流）
                if (titles.indexOf(title) < titles.length - 1) {
                  await new Promise((r) => setTimeout(r, 1000));
                }
              }

              // 写缓存
              if (cacheUpdated) {
                try {
                  fs.writeFileSync(BANGUMI_REVIEW_CACHE_PATH, JSON.stringify(cache, null, 2), 'utf-8');
                } catch (_) { /* 缓存写入失败 */ }
              }

              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ results, cached: Object.keys(results).length > 0 }));
            } catch (e) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: '评论采集失败: ' + (e instanceof Error ? e.message : '') }));
            }
          });
        });

        // ── Bangumi 发现：按标签批量搜索番剧（推荐引擎用）──
        router.use('/api/bangumi/discover', async (req, res) => {
          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Method Not Allowed' }));
            return;
          }
          const chunks: Buffer[] = [];
          req.on('data', (c: Buffer) => chunks.push(c));
          req.on('end', async () => {
            try {
              const { tags } = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
              if (!Array.isArray(tags) || tags.length === 0) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: '缺少 tags 数组' }));
                return;
              }

              // 去重用的结果集（按 subject id 去重）
              const seen = new Set<number>();
              const allResults: Record<string, unknown>[] = [];

              for (const tag of tags.slice(0, 8)) {
                let connected = false;
                for (const apiBase of BANGUMI_APIS) {
                  try {
                    const searchUrl = `${apiBase}/search/subject/${encodeURIComponent(tag)}?type=2&responseGroup=large`;
                    const resp = await fetch(searchUrl, {
                      headers: { 'User-Agent': 'AnimeDiary/1.0 (private)' },
                      signal: AbortSignal.timeout(8000),
                    });
                    if (resp.ok) {
                      const data = await resp.json();
                      const list = (data.list || []) as Record<string, unknown>[];
                      for (const item of list) {
                        const id = item.id as number;
                        if (id && !seen.has(id)) {
                          seen.add(id);
                          allResults.push({
                            id: item.id,
                            name: item.name || '',
                            name_cn: item.name_cn || '',
                            summary: (item.summary as string) || '',
                            images: item.images || {},
                            rating: item.rating || {},
                            air_date: item.air_date || '',
                            eps: item.eps || 0,
                            // 从哪个标签搜到的
                            matchedTag: tag,
                          });
                        }
                      }
                      connected = true;
                      break;
                    }
                  } catch { continue; }
                }

                // 请求间隔 1s
                if (tags.indexOf(tag) < Math.min(tags.length, 8) - 1) {
                  await new Promise((r) => setTimeout(r, 1000));
                }
              }

              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({
                results: allResults.slice(0, 50),
                total: allResults.length,
                searchedTags: tags.slice(0, 8),
              }));
            } catch (e) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: '发现失败: ' + (e instanceof Error ? e.message : '') }));
            }
          });
        });

        // ── AniList 搜索代理 ──
        const ANILIST_CACHE_PATH = path.join(DATA_DIR, 'anilist_cache.json');

        // 提供缓存文件读取
        router.use('/api/anilist/cache', (_req, res) => {
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

        router.use('/api/anilist/search', async (req, res) => {
          const url = new URL(req.url!, 'http://localhost');
          const keyword = url.searchParams.get('keyword') || '';
          const force = url.searchParams.get('force') === '1';
          if (!keyword) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: '缺少 keyword 参数' }));
            return;
          }

          // 1. 查缓存（force=1 时跳过）
          if (!force) { try {
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
          } catch (_) {} } // if (!force)

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
        // ── 一次性修复：为 Excel 中 POSTER_URL 列为空的条目批量搜索海报 ──
        router.use('/api/fix-posters', async (req, res) => {
          if (!fs.existsSync(EXCEL_PATH)) {
            res.end(JSON.stringify({ error: 'Excel 文件不存在' }));
            return;
          }
          const wb = XLSX.readFile(EXCEL_PATH);
          const ws = wb.Sheets['番剧列表'];
          if (!ws) {
            res.end(JSON.stringify({ error: '找不到「番剧列表」Sheet' }));
            return;
          }
          const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as unknown[][];
          const titleCol = 1;       // B 列
          const posterCol = 37;     // AL 列
          const templateCol = 38;   // AM 列
          const missing: { rowIdx: number; title: string }[] = [];
          for (let i = 1; i < rows.length; i++) {
            const title = String(rows[i][titleCol] || '').trim();
            const poster = String(rows[i][posterCol] || '').trim();
            const templateId = String(rows[i][templateCol] || '').trim();
            // 跳过空行、已有海报的行、角色卡（非番剧条目）
            if (!title || poster || templateId === 'character') continue;
            missing.push({ rowIdx: i, title });
          }
          if (missing.length === 0) {
            res.end(JSON.stringify({ fixed: 0, message: '所有条目已有海报，无需修复' }));
            return;
          }

          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.write(`<html><head><meta charset="utf-8"><style>body{font-family:monospace;font-size:13px;background:#111;color:#ccc;padding:20px} .ok{color:#7f7} .fail{color:#f77} .dim{color:#666}</style></head><body>
  <h2>🔧 批量补海报 — 共 ${missing.length} 条</h2><pre>`);

          let fixed = 0;
          for (const m of missing) {
            let poster = '';
            // 1. 先试 AniList（对英文/罗马音标题效果好）
            try {
              const escaped = m.title.replace(/"/g, '\\"').replace(/\n/g, ' ');
              const query = `{Page(page:1,perPage:1){media(search:"${escaped}",type:ANIME){coverImage{large}}}}`;
              const anResp = await fetch('https://graphql.anilist.co', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query }),
                signal: AbortSignal.timeout(10000),
              });
              const json = await anResp.json();
              poster = (json?.data?.Page?.media?.[0] as { coverImage?: { large?: string } })?.coverImage?.large || '';
            } catch { /* AniList 失败，继续 */ }

            // 2. AniList 未命中 → 尝试 Bangumi（对中文标题效果好）
            if (!poster) {
              for (const apiBase of BANGUMI_APIS) {
                try {
                  const apiUrl = `${apiBase}/search/subject/${encodeURIComponent(m.title)}?type=2&responseGroup=large`;
                  const bgResp = await fetch(apiUrl, {
                    headers: { 'User-Agent': 'AnimeDiary/0.1 (private)' },
                    signal: AbortSignal.timeout(8000),
                  });
                  if (!bgResp.ok) continue;
                  const data = await bgResp.json();
                  const item = data?.list?.[0];
                  if (item?.images?.large) {
                    poster = item.images.large;
                    break;
                  }
                } catch { continue; }
              }
            }

            if (poster) {
              ws[`AL${m.rowIdx + 1}`] = { t: 's', v: poster };
              fixed++;
              res.write(`<span class="ok">✔</span> ${m.title} → ${poster.slice(0, 60)}...\n`);
            } else {
              res.write(`<span class="fail">✘</span> ${m.title} — 未找到海报\n`);
            }
            // 每个等待 1 秒，避免限流
            await new Promise((r) => setTimeout(r, 1000));
          }

          if (fixed > 0) {
            writeFileAtomic(EXCEL_PATH, XLSX.write(wb, { bookType: 'xlsx', type: 'buffer', bookSST: true }));
          }
          res.write(`\n<span class="dim">────────────────────────</span>\n完成：${missing.length} 条缺海报，修复 ${fixed} 条，跳过 ${missing.length - fixed} 条\n`);
          res.end('</pre></body></html>');
        });
        // ── Bangumi v0 标签浏览：按标签查找番剧（推荐引擎用）──
        router.use('/api/bangumi/browse', async (req, res) => {
          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Method Not Allowed' }));
            return;
          }
          const chunks: Buffer[] = [];
          req.on('data', (c: Buffer) => chunks.push(c));
          req.on('end', async () => {
            try {
              const { tags } = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
              if (!Array.isArray(tags) || tags.length === 0) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: '缺少 tags 数组' }));
                return;
              }

              const seen = new Set<number>();
              const allResults: Record<string, unknown>[] = [];

              // Bangumi v0 API 基础地址
              const V0_APIS = [
                'https://api.bgm.tv/v0',
                'https://bangumi.online/api/v0',
              ];

              for (const tag of tags.slice(0, 8)) {
                let connected = false;
                for (const v0Base of V0_APIS) {
                  try {
                    // v0 API: 按标签过滤番剧，按排名排序
                    const browseUrl = `${v0Base}/subjects?tag=${encodeURIComponent(tag)}&type=2&sort=rank&limit=12`;
                    const resp = await fetch(browseUrl, {
                      headers: { 'User-Agent': 'AnimeDiary/1.0 (private)' },
                      signal: AbortSignal.timeout(8000),
                    });
                    if (resp.ok) {
                      const data = await resp.json();
                      const list = (data.data || data || []) as Record<string, unknown>[];
                      for (const item of list) {
                        const id = item.id as number;
                        if (id && !seen.has(id)) {
                          seen.add(id);
                          // v0 API 返回字段名略有不同
                          const images = item.images as Record<string, string> | undefined;
                          allResults.push({
                            id,
                            name: item.name || '',
                            name_cn: item.name_cn || item.name || '',
                            summary: item.summary || '',
                            images: {
                              large: images?.large || '',
                              common: images?.common || images?.medium || '',
                              medium: images?.medium || '',
                              small: images?.small || '',
                            },
                            rating: {
                              score: (item.rating as { score?: number })?.score || 0,
                              total: (item.rating as { total?: number })?.total || 0,
                            },
                            air_date: item.date || item.air_date || '',
                            eps: item.eps || item.eps_count || 0,
                            matchedTag: tag,
                          });
                        }
                      }
                      connected = true;
                      break;
                    }
                  } catch { continue; }
                }

                if (tags.indexOf(tag) < Math.min(tags.length, 8) - 1) {
                  await new Promise((r) => setTimeout(r, 1000));
                }
              }

              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({
                results: allResults.slice(0, 50),
                total: allResults.length,
                searchedTags: tags.slice(0, 8),
                source: 'bangumi_v0',
              }));
            } catch (e) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: '浏览失败: ' + (e instanceof Error ? e.message : '') }));
            }
          });
        });

        // ── AniList 发现：按标签批量搜索番剧（推荐引擎用）──
        router.use('/api/anilist/discover', async (req, res) => {
          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Method Not Allowed' }));
            return;
          }
          const chunks: Buffer[] = [];
          req.on('data', (c: Buffer) => chunks.push(c));
          req.on('end', async () => {
            try {
              const { tags, excludeTitles } = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
              if (!Array.isArray(tags) || tags.length === 0) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: '缺少 tags 数组' }));
                return;
              }

              // Phase A: 搜索用户已有番剧的 AniList ID，用于后续排除
              const excludeIds = new Set<number>();
              if (Array.isArray(excludeTitles) && excludeTitles.length > 0) {
                // 取前 30 部最相关的（按标题长度优先，提高匹配精度）
                const toCheck = excludeTitles
                  .filter((t: string) => t && t.length >= 3)
                  .slice(0, 30);
                for (const title of toCheck) {
                  try {
                    const escaped = String(title).replace(/"/g, '\\"').replace(/\n/g, ' ');
                    const idQuery = `{Page(page:1,perPage:3){media(search:"${escaped}",type:ANIME){id}}}`;
                    const idResp = await fetch('https://graphql.anilist.co', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                      body: JSON.stringify({ query: idQuery }),
                      signal: AbortSignal.timeout(5000),
                    });
                    if (idResp.ok) {
                      const idJson = await idResp.json();
                      const media = (idJson?.data?.Page?.media || []) as Array<{ id: number }>;
                      for (const m of media) {
                        if (m.id) excludeIds.add(m.id);
                      }
                    }
                  } catch { continue; }
                  // 限流
                  await new Promise((r) => setTimeout(r, 300));
                }
              }

              // Phase B: 按标签搜索候选
              const seen = new Set<number>();
              const allResults: Record<string, unknown>[] = [];

              for (const tag of tags.slice(0, 8)) {
                try {
                  const escaped = String(tag).replace(/"/g, '\\"').replace(/\n/g, ' ');
                  const query = `{Page(page:1,perPage:10){media(search:"${escaped}",type:ANIME,sort:SCORE_DESC){id title{romaji english native}coverImage{large medium}averageScore episodes seasonYear description genres tags{name rank}}}}`;
                  const resp = await fetch('https://graphql.anilist.co', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                    body: JSON.stringify({ query }),
                    signal: AbortSignal.timeout(10000),
                  });
                  if (!resp.ok) continue;
                  const json = await resp.json();
                  const list = (json?.data?.Page?.media || []) as Record<string, unknown>[];
                  for (const item of list) {
                    const id = item.id as number;
                    // 跳过用户已有的番剧（AniList ID 匹配）
                    if (id && !seen.has(id) && !excludeIds.has(id)) {
                      seen.add(id);
                      const title = item.title as { native?: string; romaji?: string; english?: string };
                      const cover = item.coverImage as { large?: string; medium?: string };
                      const genreList = (item.genres || []) as string[];
                      const tagList = (item.tags || []) as Array<{ name: string; rank: number }>;
                      allResults.push({
                        id,
                        name: title?.native || title?.romaji || '',
                        name_cn: title?.native || title?.romaji || '',
                        name_en: title?.english || '',
                        summary: (item.description as string) || '',
                        images: {
                          large: cover?.large || '',
                          common: cover?.medium || '',
                          medium: cover?.medium || '',
                          small: cover?.medium || '',
                        },
                        rating: {
                          score: ((item.averageScore as number) || 0) / 10,
                          total: 0,
                        },
                        air_date: (item.seasonYear as number) ? String(item.seasonYear) : '',
                        eps: (item.episodes as number) || 0,
                        genres: genreList,
                        tags: tagList.map((t) => t.name),
                        matchedTag: tag,
                      });
                    }
                  }
                } catch { continue; }

                // 请求间隔 800ms（AniList 限流 90 req/min）
                if (tags.indexOf(tag) < Math.min(tags.length, 8) - 1) {
                  await new Promise((r) => setTimeout(r, 800));
                }
              }

              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({
                results: allResults.slice(0, 50),
                total: allResults.length,
                excludedCount: excludeIds.size,
                searchedTags: tags.slice(0, 8),
                source: 'anilist',
              }));
            } catch (e) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: '发现失败: ' + (e instanceof Error ? e.message : '') }));
            }
          });
        });

        // ══════════════════════════════════════════════════════════════
        // ── 番剧元数据多源获取（Bangumi / Bilibili）──
        //
        // 为什么需要这组接口：Excel 里的数据绝大多数是手工录入的，
        // 而「能不能连上外部数据源」在同一台机器上是会变的 —— Bangumi
        // 全站（api.bgm.tv / lain.bgm.tv）在国内直连时 DNS 被污染、SNI 被阻断，
        // 必须走代理；Bilibili 则国内直连稳定可达。所以这里把「源」做成
        // 一等公民：先把每个源的连通性明确探出来给界面看，再让用户决定用哪个。
        // ══════════════════════════════════════════════════════════════

        /** 连通性探测结果缓存（避免批量补全时每条都重新探测一遍） */
        let probeCache: { at: number; results: unknown[] } | null = null;
        const PROBE_TTL = 5 * 60 * 1000;

        /**
         * 每个源的「连续失败次数」熔断计数。
         *
         * 为什么必须有：探测结果要缓存 5 分钟，而用户的代理是**会中途挂掉的**
         * （实测本机 Clash 节点在几分钟内反复通/断）。一旦 Bangumi 在批量补全
         * 中途失效，缓存却还认为它可用，于是后面每一条都要白等一次超时 ——
         * 190 条 × 9 秒 ≈ 28 分钟，看起来就像卡死了。
         * 连续失败到阈值就把该源摘掉，让批量用剩下的源正常跑完；
         * 点「重新检测」会清零，给它重新证明自己的机会。
         */
        const sourceFailureStreak: Record<string, number> = {};
        const SOURCE_FAILURE_LIMIT = 3;

        async function probeSources(force = false) {
          if (!force && probeCache && Date.now() - probeCache.at < PROBE_TTL) return probeCache.results;
          const results = await media.probeAll();
          probeCache = { at: Date.now(), results };
          if (force) {
            // 用户主动重测 → 给所有源一次全新的机会
            for (const k of Object.keys(sourceFailureStreak)) delete sourceFailureStreak[k];
          }
          return results;
        }

        // 连通性探测：让界面能明确说「Bangumi 现在连不上、Bilibili 可用」，
        // 而不是笼统地报一个失败让用户猜。
        router.use('/api/media/sources', async (req, res) => {
          const url = new URL(req.url!, 'http://localhost');
          try {
            const results = await probeSources(url.searchParams.get('force') === '1');
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ sources: results }));
          } catch (e) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
          }
        });

        // 搜索候选条目
        //   ?source=bangumi|bilibili  → 只查该源（批量补全用这个，快）
        //   ?source=auto（缺省）      → 并行查所有**可用**的源并合并，
        //                              每条候选自带 source 字段，便于人工对照挑选
        router.use('/api/media/search', async (req, res) => {
          const url = new URL(req.url!, 'http://localhost');
          const keyword = (url.searchParams.get('keyword') || '').trim();
          const sourceParam = (url.searchParams.get('source') || 'auto').trim();
          const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '10', 10) || 10, 1), 30);
          if (!keyword) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: '缺少 keyword 参数' }));
            return;
          }
          try {
            const probed = await probeSources();
            const available = (probed as { source: string; ok: boolean }[]).filter((p) => p.ok).map((p) => p.source as MediaSource);
            // 连续失败到阈值的源先摘掉（见 sourceFailureStreak 的说明）
            const healthy = available.filter((s) => (sourceFailureStreak[s] ?? 0) < SOURCE_FAILURE_LIMIT);

            if (sourceParam === 'auto' && healthy.length === 0) {
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({
                keyword,
                candidates: [],
                errors: {
                  all: available.length > 0
                    ? '所有数据源连续失败，已暂停请求以免每条都白等超时。请点「重新检测」或稍后重试。'
                    : '当前没有可用数据源（Bangumi 需要代理；Bilibili 需要能直连 api.bilibili.com）',
                },
                probed,
              }));
              return;
            }

            const targets: MediaSource[] = sourceParam === 'auto' ? healthy : [sourceParam as MediaSource];

            const errors: Record<string, string> = {};
            /**
             * 每个源各自的响应上限。
             *
             * 没有这个上限时，代理抖动会让一次搜索卡到 40 秒以上：Bangumi 单次请求
             * 超时 10s、再重试 1 次，而请求要等所有源都返回才响应 ——
             * Bilibili 早就查完了，用户却还在等 Bangumi 慢慢超时。
             * 这里让"慢的源"到点就放弃，先把能用的结果给出去。
             */
            const SOURCE_DEADLINE_MS = 9000;
            const searchWithDeadline = (src: MediaSource) => {
              let settled = false;
              const task = media.search(src, keyword, limit).then(
                (list) => {
                  settled = true;
                  sourceFailureStreak[src] = 0; // 成功即清零
                  return list;
                },
                (e) => {
                  settled = true;
                  sourceFailureStreak[src] = (sourceFailureStreak[src] ?? 0) + 1;
                  errors[src] = describeError(e);
                  return [] as never[];
                },
              );
              const deadline = new Promise<never[]>((resolve) => {
                setTimeout(() => {
                  if (!settled) {
                    sourceFailureStreak[src] = (sourceFailureStreak[src] ?? 0) + 1;
                    errors[src] = `超时（超过 ${SOURCE_DEADLINE_MS / 1000} 秒未响应）`;
                  }
                  resolve([]);
                }, SOURCE_DEADLINE_MS);
              });
              return Promise.race([task, deadline]);
            };

            const batches = await Promise.all(targets.map(searchWithDeadline));
            res.setHeader('Content-Type', 'application/json');
            res.end(
              JSON.stringify({
                keyword,
                candidates: batches.flat(),
                errors,
                probed,
                skipped: available.filter((s) => !healthy.includes(s)),
              }),
            );
          } catch (e) {
            res.statusCode = 502;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
          }
        });

        // 单条详情：补全搜索列表里拿不到的字段（制作组 / 简介 / 上映年月 / 集数）
        router.use('/api/media/subject', async (req, res) => {
          const url = new URL(req.url!, 'http://localhost');
          const source = (url.searchParams.get('source') || '').trim() as MediaSource;
          const id = (url.searchParams.get('id') || '').trim();
          if (!source || !id) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: '缺少 source 或 id 参数' }));
            return;
          }
          try {
            /**
             * 详情也要有响应上限。
             *
             * 实测：Bangumi 详情在代理抖动时会走满「v0 超时 + 重试 + next 回退」，
             * 单条 20~40 秒。批量补全 146 条踩上这个，写入阶段从 ~2 分钟拖到 11 分钟。
             * 详情只是"锦上添花"（制作组/上映/集数），拿不到就该立刻放弃，
             * 绝不能让它拖住整批 —— 封面下载与写入都不依赖它。
             */
            const DETAIL_DEADLINE_MS = 8000;
            let timedOut = false;
            const candidate = await Promise.race([
              media.detail(source, id),
              new Promise<null>((resolve) => {
                setTimeout(() => { timedOut = true; resolve(null); }, DETAIL_DEADLINE_MS);
              }),
            ]);
            res.setHeader('Content-Type', 'application/json');
            res.end(
              JSON.stringify({
                candidate,
                error: timedOut ? `详情获取超时（超过 ${DETAIL_DEADLINE_MS / 1000} 秒），已跳过该条的详情字段` : undefined,
              }),
            );
          } catch (e) {
            res.statusCode = 502;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: describeError(e) }));
          }
        });

        // ── 封面下载到本地 ──
        //
        // 为什么不直接写外链：实测这台机器上 lain.bgm.tv（BGM 图床）与
        // s4.anilist.co（AniList 图床）都不可达，Excel 里 46 条外链海报因此
        // 全部显示不出来。Kazumi 是直接外链 CDN 的，所以它同样怕 CDN 被墙。
        // 这里反过来做：**一律下载到本地 images/{番剧名}/ 再写本地 URL**，
        // 之后无论外部 CDN 怎么变，海报都不会消失。
        //
        // 附带好处：图片字节不经过渲染进程（以前 base64 塞进 Excel 单元格，
        // 撞上 32767 字符上限导致整批保存失败）。
        router.use('/api/media/fetch-cover', (req, res) => {
          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Method Not Allowed' }));
            return;
          }
          const chunks: Buffer[] = [];
          req.on('data', (chunk: Buffer) => { chunks.push(chunk); });
          req.on('end', async () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
              const animeTitle = String(body.animeTitle || '').trim();
              const coverUrl = String(body.url || '').trim();
              if (!animeTitle || !coverUrl) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: '缺少 animeTitle 或 url' }));
                return;
              }
              // 只允许已知图床，避免这条路由被当成任意 URL 的 SSRF 跳板
              if (!isAllowedCoverHost(coverUrl)) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: '不支持的图片来源（仅允许 Bangumi / Bilibili / AniList 图床）' }));
                return;
              }
              const safeName = animeTitle.replace(/[\\/:*?"<>|]/g, '_').trim();
              if (!isSafePathSegment(safeName)) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: '番剧名非法' }));
                return;
              }

              const { buffer, contentType } = await media.fetchImage(coverUrl);
              const ext =
                contentType === 'image/png' ? '.png'
                  : contentType === 'image/webp' ? '.webp'
                    : contentType === 'image/gif' ? '.gif'
                      : '.jpg';
              // 固定文件名 cover{ext}：重复抓取是覆盖而不是堆文件；
              // ext 变化时清掉同名的其他后缀，避免同一部番留下两张封面。
              const requested = String(body.fileName || `cover${ext}`).trim();
              const fileName = isSafePathSegment(requested) ? requested : `cover${ext}`;
              const dir = path.join(IMAGES_DIR, safeName);
              fs.mkdirSync(dir, { recursive: true });
              for (const other of ['.jpg', '.png', '.webp', '.gif']) {
                if (other === ext) continue;
                const stale = path.join(dir, `cover${other}`);
                if (fs.existsSync(stale)) {
                  try { fs.unlinkSync(stale); } catch { /* 删不掉就算了 */ }
                }
              }
              fs.writeFileSync(path.join(dir, fileName), buffer);

              const localUrl = `/api/images/file?anime=${encodeURIComponent(safeName)}&file=${encodeURIComponent(fileName)}`;
              res.setHeader('Content-Type', 'application/json');
              res.end(
                JSON.stringify({
                  success: true,
                  fileName,
                  url: localUrl,
                  bytes: buffer.length,
                  contentType,
                }),
              );
            } catch (e) {
              res.statusCode = 502;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: e instanceof Error ? e.message : '封面下载失败' }));
            }
          });
        });

        // ── 服务端自身信息（诊断用） ──
        //
        // 为什么需要它：服务端代码打进 app.asar 后是安装时定格的，热更新只换前端，
        // 于是「新加的后端路由在装好的应用里 404」这种问题很难一眼看出。
        // 这个路由把**实际加载的路由文件路径**报出来：落在 app.asar 里就是内置版本，
        // 落在 userData/web-update/<版本>/server/ 下就是热更新的那一份。
        router.use('/api/server-info', (req, res) => {
          res.setHeader('Content-Type', 'application/json');
          let routesFile: string | null = null;
          try {
            routesFile = typeof __filename === 'string' ? __filename : null;
          } catch { /* 某些打包形态下没有 __filename */ }
          res.end(JSON.stringify({
            routesFile,
            fromHotUpdate: !!routesFile && routesFile.includes(`${path.sep}web-update${path.sep}`),
            nodeVersion: process.version,
            pid: process.pid,
            dataDir: DATA_DIR,
          }));
        });

        // ── 角色元数据（角色评分卡） ──
        //
        // 与 /api/media/*（番剧元数据）并列的另一条链路，取数逻辑见 server/character-sources.ts，
        // 纯解析/匹配逻辑见 core/character.ts。三条实测出来的硬约束：
        //
        //   1. 角色可以挂在**任意类型的作品**上：Bangumi 的动画(2)/书籍(1)/游戏(4) 都有角色
        //      （实测黑神话：悟空 122 个、狼与香辛料 34 个）。所以 works 的 type 过滤
        //      由调用方按条目实际类型传，不能写死 type=2。
        //   2. 角色列表**不带中文名**，中文名只存在于角色详情的 infobox 里，
        //      因此 resolve 用 detailBudget 控制补详情的数量，并在名字全部匹配后立刻停止。
        //   3. AniList 只能「补」不能「找」：它用中文名搜角色一律返回 0 条，
        //      且没有游戏条目（withAniList 对游戏会被跳过并给出说明）。
        //
        // 角色立绘的落盘复用 POST /api/media/fetch-cover（传 animeTitle=角色名）——
        // 图床白名单已含 lain.bgm.tv / s4.anilist.co，不必再开一条写文件的路由。
        const character = createCharacterClient({ fetchImpl });

        /**
         * GET /api/character/work?workTitle=&types=2,4
         * 只解析作品，不发角色请求。界面靠它把「找作品」与「抓角色」分步，
         * 否则一次 resolve 要十几秒而中途没有任何反馈。
         */
        router.use('/api/character/work', async (req, res) => {
          res.setHeader('Content-Type', 'application/json');
          try {
            const url = new URL(req.url!, 'http://localhost');
            const workTitle = (url.searchParams.get('workTitle') || '').trim();
            const typesParam = (url.searchParams.get('types') || '').trim();
            if (!workTitle) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: '缺少 workTitle' }));
              return;
            }
            const types = typesParam
              ? typesParam.split(',').map((x) => Number(x)).filter(Number.isFinite)
              : undefined;
            const result = await character.resolveWork(workTitle, types);
            res.end(JSON.stringify({
              work: result.work,
              workScore: result.workScore,
              workLowConfidence: result.workScore < 0.6,
            }));
          } catch (e) {
            res.statusCode = 502;
            res.end(JSON.stringify({ error: describeError(e) }));
          }
        });

        /**
         * POST /api/character/details  body: { ids: string[] }
         * 批量取角色详情（中文名/生日/血型/身高/人设）。由调用方分批，
         * 这样进度条能按角色推进而不是卡在一个几十连抓上。
         */
        router.use('/api/character/details', (req, res) => {
          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Method Not Allowed' }));
            return;
          }
          const chunks: Buffer[] = [];
          req.on('data', (chunk: Buffer) => { chunks.push(chunk); });
          req.on('end', async () => {
            res.setHeader('Content-Type', 'application/json');
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
              const ids = (Array.isArray(body.ids) ? body.ids : [])
                .map((x: unknown) => String(x).trim())
                .filter(Boolean)
                // 单批上限：别让一次请求把节流队列排到几分钟
                .slice(0, 40);
              if (ids.length === 0) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: '缺少 ids' }));
                return;
              }
              const result = await character.getCharacterDetails(ids);
              res.end(JSON.stringify(result));
            } catch (e) {
              res.statusCode = 502;
              res.end(JSON.stringify({ error: describeError(e) }));
            }
          });
        });

        /** GET /api/character/list?subjectId=123 — 某作品的全部角色（1 次请求，含立绘与声优） */
        router.use('/api/character/list', async (req, res) => {
          res.setHeader('Content-Type', 'application/json');
          try {
            const url = new URL(req.url!, 'http://localhost');
            const subjectId = (url.searchParams.get('subjectId') || '').trim();
            if (!subjectId) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: '缺少 subjectId' }));
              return;
            }
            const list = await character.listCharacters(subjectId);
            res.end(JSON.stringify({ subjectId, count: list.length, characters: list }));
          } catch (e) {
            res.statusCode = 502;
            res.end(JSON.stringify({ error: describeError(e) }));
          }
        });

        /** GET /api/character/detail?id=86246&works=1 — 角色详情（infobox → 中文名/生日/血型/身高） */
        router.use('/api/character/detail', async (req, res) => {
          res.setHeader('Content-Type', 'application/json');
          try {
            const url = new URL(req.url!, 'http://localhost');
            const id = (url.searchParams.get('id') || '').trim();
            if (!id) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: '缺少 id' }));
              return;
            }
            const detail = await character.getCharacter(id);
            if (!detail) {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: '角色不存在' }));
              return;
            }
            if (url.searchParams.get('works') === '1') {
              detail.works = await character.getCharacterWorks(id);
            }
            res.end(JSON.stringify({ character: detail }));
          } catch (e) {
            res.statusCode = 502;
            res.end(JSON.stringify({ error: describeError(e) }));
          }
        });

        /** GET /api/character/subjects?id=86246 — 该角色出现在哪些作品里（可回填 char_source） */
        router.use('/api/character/subjects', async (req, res) => {
          res.setHeader('Content-Type', 'application/json');
          try {
            const url = new URL(req.url!, 'http://localhost');
            const id = (url.searchParams.get('id') || '').trim();
            if (!id) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: '缺少 id' }));
              return;
            }
            const works = await character.getCharacterWorks(id);
            res.end(JSON.stringify({ id, count: works.length, works }));
          } catch (e) {
            res.statusCode = 502;
            res.end(JSON.stringify({ error: describeError(e) }));
          }
        });

        /** GET /api/character/person?id=7575 — 声优资料（生日/血型/身高/出生地/事务所） */
        router.use('/api/character/person', async (req, res) => {
          res.setHeader('Content-Type', 'application/json');
          try {
            const url = new URL(req.url!, 'http://localhost');
            const id = (url.searchParams.get('id') || '').trim();
            if (!id) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: '缺少 id' }));
              return;
            }
            const person = await character.getPerson(id);
            if (!person) {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: '声优不存在' }));
              return;
            }
            res.end(JSON.stringify({ person }));
          } catch (e) {
            res.statusCode = 502;
            res.end(JSON.stringify({ error: describeError(e) }));
          }
        });

        /**
         * GET /api/character/search?keyword=芙莉莲 — 角色搜索（兜底用）
         * 不要用它给「用户记录的名字」找人：「蕾娜」有 892 条同名。先锁作品再匹配。
         */
        router.use('/api/character/search', async (req, res) => {
          res.setHeader('Content-Type', 'application/json');
          try {
            const url = new URL(req.url!, 'http://localhost');
            const keyword = (url.searchParams.get('keyword') || '').trim();
            if (!keyword) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: '缺少 keyword' }));
              return;
            }
            const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 10, 1), 30);
            const list = await character.searchCharacters(keyword, limit);
            res.end(JSON.stringify({ keyword, count: list.length, characters: list }));
          } catch (e) {
            res.statusCode = 502;
            res.end(JSON.stringify({ error: describeError(e) }));
          }
        });

        /**
         * POST /api/character/resolve — 一站式：作品 → 角色列表 → 匹配已记录的名字 →（可选）AniList 补字段
         * body: { subjectId? , workTitle?, types?: number[], names?: string[], withAniList?: boolean, detailBudget?: number }
         */
        router.use('/api/character/resolve', (req, res) => {
          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Method Not Allowed' }));
            return;
          }
          const chunks: Buffer[] = [];
          req.on('data', (chunk: Buffer) => { chunks.push(chunk); });
          req.on('end', async () => {
            res.setHeader('Content-Type', 'application/json');
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
              const budget = Number(body.detailBudget);
              const result = await character.resolve({
                subjectId: body.subjectId,
                workTitle: typeof body.workTitle === 'string' ? body.workTitle : undefined,
                types: Array.isArray(body.types) ? body.types.map(Number).filter(Number.isFinite) : undefined,
                names: Array.isArray(body.names) ? body.names.map((n: unknown) => String(n)) : undefined,
                withAniList: body.withAniList !== false,
                detailBudget: Number.isFinite(budget) && budget > 0 ? budget : undefined,
              });
              res.end(JSON.stringify(result));
            } catch (e) {
              res.statusCode = 502;
              res.end(JSON.stringify({ error: describeError(e) }));
            }
          });
        });

        // ── 图片代理（解决外部 URL 跨域） ──
        // 两处修正：
        //   1. 改用注入的 network.fetchImage —— 原先这里用全局 fetch，
        //      Node 的 fetch 不读系统代理，导致 lain.bgm.tv / s4.anilist.co
        //      这类必须走代理的图床在打包后一律加载失败。
        //   2. 加上公网地址校验，堵掉「任意 URL 跳板」这个 SSRF 口子。
        router.use('/api/images/proxy', async (req, res) => {
          const url = new URL(req.url!, 'http://localhost');
          const target = url.searchParams.get('url') || '';
          if (!target) { res.statusCode = 400; res.end('缺少 url'); return; }
          if (!isPublicHttpUrl(target)) {
            res.statusCode = 400;
            res.end('不支持的图片地址（仅允许公网 http/https 地址）');
            return;
          }
          try {
            const { buffer, contentType } = await media.fetchImage(target);
            res.setHeader('Content-Type', contentType);
            res.setHeader('Cache-Control', 'max-age=86400');
            res.end(buffer);
          } catch (e) {
            res.statusCode = 502;
            res.end('代理请求失败: ' + describeError(e));
          }
        });

        // ── 图片本地存储 API ──
        // 列出某番剧的图片
        router.use('/api/images/list', (req, res) => {
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
              .filter((f) => /\.(jpg|jpeg|png|gif|webp|bmp|webm)$/i.test(f))
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
        router.use('/api/images/save', (req, res) => {
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
              res.end(JSON.stringify({ success: true, fileName, url, filePath: path.relative(DATA_DIR, filePath) }));
            } catch (e) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: e instanceof Error ? e.message : '保存失败' }));
            }
          });
        });

        // 删除本地图片
        router.use('/api/images/delete', (req, res) => {
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
              // 目录名沿用保存时的规则（Windows 非法字符替换为 _），
              // 但替换后仍可能是 "." / ".." / 空，这类必须拒绝：
              // 原先只校验 fileName，animeTitle=".." + fileName="番评分.xlsx"
              // 会让下面的 unlinkSync 直接删掉唯一的数据库文件。
              const safeName = animeTitle.replace(/[\\/:*?"<>|]/g, '_').trim();
              if (!isSafePathSegment(safeName) || !isSafePathSegment(fileName)) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: '文件名非法' }));
                return;
              }
              const filePath = resolveInside(IMAGES_DIR, safeName, fileName);
              if (!filePath) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: '路径非法' }));
                return;
              }
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

        // ── 保存录制视频（Web 模式 multipart 上传）──
        router.use('/api/video/save', (req, res) => {
          if (req.method !== 'POST') { res.statusCode = 405; res.end('Method Not Allowed'); return; }
          const chunks: Buffer[] = [];
          req.on('data', (c: Buffer) => chunks.push(c));
          req.on('end', () => {
            try {
              const raw = Buffer.concat(chunks).toString('binary');
              const boundaryMatch = raw.match(/boundary=([^\r\n]+)/);
              if (!boundaryMatch) { res.statusCode = 400; res.end(JSON.stringify({ error: '无效表单' })); return; }
              const boundary = boundaryMatch[1];
              const parts = raw.split(`--${boundary}`);
              let animeTitle = '';
              let fileData: Buffer | null = null;
              let fileName = 'recording.webm';

              for (const part of parts) {
                const headerEnd = part.indexOf('\r\n\r\n');
                if (headerEnd === -1) continue;
                const header = part.slice(0, headerEnd);
                if (header.includes('name="animeTitle"')) {
                  animeTitle = part.slice(headerEnd + 4).trim();
                } else if (header.includes('name="file"')) {
                  const fnMatch = header.match(/filename="([^"]+)"/);
                  if (fnMatch) fileName = fnMatch[1];
                  const bodyStart = headerEnd + 4;
                  const bodyEnd = part.lastIndexOf('\r\n--');
                  fileData = Buffer.from(part.slice(bodyStart, bodyEnd > 0 ? bodyEnd : part.length), 'binary');
                }
              }

              if (!animeTitle || !fileData) { res.statusCode = 400; res.end(JSON.stringify({ error: '缺少参数' })); return; }

              const safeName = animeTitle.replace(/[\\/:*?"<>|]/g, '_').trim();
              const dir = path.join(IMAGES_DIR, safeName);
              if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

              // 自动编号
              let maxNum = 0;
              if (fs.existsSync(dir)) {
                const re = new RegExp(`^${escapeRegExp(safeName)}_(\\d+)\\.`);
                for (const f of fs.readdirSync(dir)) {
                  const m = f.match(re);
                  if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
                }
              }
              const ext = path.extname(fileName) || '.webm';
              const outName = `${safeName}_${maxNum + 1}${ext}`;
              const filePath = path.join(dir, outName);
              fs.writeFileSync(filePath, fileData);

              const url = `/api/images/file?anime=${encodeURIComponent(safeName)}&file=${encodeURIComponent(outName)}`;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ success: true, fileName: outName, url }));
            } catch (e) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: e instanceof Error ? e.message : '保存失败' }));
            }
          });
        });

        // 提供图片静态文件
        router.use('/api/images/file', (req, res) => {
          const url = new URL(req.url!, 'http://localhost');
          const anime = url.searchParams.get('anime') || '';
          const file = url.searchParams.get('file') || '';
          if (!anime || !file) { res.statusCode = 400; res.end('缺少参数'); return; }
          // anime 参数原先完全不校验：?anime=..&file=vite.config.ts 能读走项目里任意文件
          if (!isSafePathSegment(anime) || !isSafePathSegment(file)) {
            res.statusCode = 400; res.end('文件名非法'); return;
          }
          const filePath = resolveInside(IMAGES_DIR, anime, file);
          if (!filePath) { res.statusCode = 400; res.end('路径非法'); return; }
          if (!fs.existsSync(filePath)) { res.statusCode = 404; res.end('文件不存在'); return; }
          const ext = path.extname(file).toLowerCase();
          const mime: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.webm': 'video/webm' };
          res.setHeader('Content-Type', mime[ext] || 'application/octet-stream');
          res.setHeader('Cache-Control', 'max-age=86400');
          res.end(fs.readFileSync(filePath));
        });

        // ── 一键备份：导出 ZIP（data.json + images/）──
        router.use('/api/backup/export', async (_req, res) => {
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
        router.use('/api/backup/export-full', (req, res) => {
          if (req.method !== 'POST') { res.statusCode = 405; res.end('Method Not Allowed'); return; }
          const chunks: Buffer[] = [];
          req.on('data', (c: Buffer) => chunks.push(c));
          req.on('end', () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString());
              const zip = new AdmZip();

              // 1. 前端传来的 data.json
              zip.addFile('data.json', Buffer.from(JSON.stringify(body, null, 2), 'utf-8'));

              // 1.5 主数据：番评分.xlsx（以前漏了，导致"备份"其实不含番剧本体）
              if (fs.existsSync(EXCEL_PATH)) {
                zip.addLocalFile(EXCEL_PATH, 'excel');
              }

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
        router.use('/api/backup/import', (req, res) => {
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

                    // 1.5 恢复主数据 Excel（若备份里带）——writeFileAtomic 会先留一份当前文件的快照
                    const excelEntry = zip.getEntries().find(
                      (e) => !e.isDirectory && e.entryName.startsWith('excel/') && e.entryName.endsWith('.xlsx'),
                    );
                    let excelRestored = false;
                    if (excelEntry) {
                      writeFileAtomic(EXCEL_PATH, excelEntry.getData());
                      excelRestored = true;
                    }

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

      // ── 浏览器 ↔ 桌面版 本地数据迁移（一次性工具）──
      // 两个版本共享同一个 Excel 数据源，但 localStorage / IndexedDB 是各自独立的。
      // 这个页面让浏览器把自己的本地数据交回服务端，桌面版再导入即可。
      router.use('/api/_migrate-export', (_req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>AnimeDiary 本地数据迁移</title>
<style>
body{background:#0d1117;color:#e6edf3;font-family:system-ui,"Microsoft YaHei",sans-serif;padding:40px;line-height:1.8}
h2{margin-top:0}
pre{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;overflow:auto;max-height:55vh;font-size:12px}
.ok{color:#3fb950;font-weight:600}.bad{color:#f85149;font-weight:600}
</style></head><body>
<h2>AnimeDiary 本地数据迁移</h2>
<p id="s">正在读取本机数据…</p>
<pre id="out"></pre>
<script>
(async function () {
  var status = document.getElementById('s');
  var out = document.getElementById('out');
  try {
    // 1. localStorage 里属于本项目的键
    var ls = {};
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf('anime_diary_') === 0) ls[k] = localStorage.getItem(k);
    }
    // 2. IndexedDB：海报覆盖
    //    注意 store 名是 'posters'（DB=anime_diary_poster_overrides，整份 map 存在键 'overrides' 下）——
    //    早先这里误写成 store='overrides'，导致海报覆盖收集为空、迁移后卡片大面积缺图。
    var indexedDBData = {};
    var dbData = await new Promise(function (resolve) {
      var req = indexedDB.open('anime_diary_poster_overrides');
      req.onerror = function () { resolve(null); };
      req.onsuccess = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('posters')) { resolve(null); return; }
        var tx = db.transaction('posters', 'readonly');
        var g = tx.objectStore('posters').get('overrides');
        g.onsuccess = function () { resolve(g.result || null); };
        g.onerror = function () { resolve(null); };
      };
    });
    if (dbData) indexedDBData.posterOverrides = dbData;

    var payload = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      localStorage: ls,
      indexedDB: indexedDBData
    };
    status.textContent = '正在提交到本地服务…';
    var resp = await fetch('/api/_migrate-save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    var result = await resp.json();
    status.innerHTML = '<span class="ok">✓ 已完成</span> —— 可以关闭这个页面了。';
    out.textContent = '已提交 ' + Object.keys(ls).length + ' 个本地键：\\n' +
      Object.keys(ls).join('\\n') +
      '\\n\\n海报覆盖条目: ' + Object.keys(indexedDBData.posterOverrides || {}).length +
      '\\n保存位置: ' + (result.path || '');
  } catch (e) {
    status.innerHTML = '<span class="bad">✗ 失败</span>：' + e.message;
  }
})();
</script></body></html>`);
      });

      router.use('/api/_migrate-save', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end('{}'); return; }
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          try {
            const body = Buffer.concat(chunks).toString('utf-8');
            const target = path.join(DATA_DIR, 'browser-migration.json');
            fs.writeFileSync(target, body, 'utf-8');
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: true, path: target, bytes: body.length }));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
          }
        });
      });

  return function apiHandler(req: any, res: any, next: () => void) {
    const pathname = String(req.url || '').split('?')[0];
    for (const r of routes) {
      if (pathname === r.prefix || pathname.startsWith(r.prefix + '/')) {
        try {
          r.handler(req, res);
        } catch (e) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: e instanceof Error ? e.message : '服务内部错误' }));
        }
        return;
      }
    }
    next();
  };
}

/** 转义正则特殊字符（图片文件名编号使用） */
/** 转义正则特殊字符 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
