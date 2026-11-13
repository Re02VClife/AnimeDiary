/**
 * server/bangumi-account — Bangumi 账号绑定与收藏写入
 *
 * 与 media-sources 的分工：那个文件只做**匿名只读**（搜索 / 详情 / 角色），
 * 这里负责**带登录态**的部分 —— OAuth 授权码换 token、自动刷新、写收藏。
 *
 * 三个容易踩的点：
 *
 * 1. 授权必须发生在系统浏览器里（Electron 的 setWindowOpenHandler 会把外链交给
 *    shell.openExternal），回调只能靠**本地回环端口**接回来。所以 redirect_uri
 *    必须是 http://127.0.0.1:<固定端口>/...，且要和 Bangumi 应用后台登记的
 *    **完全一致**，否则授权页会直接报 redirect_uri 不匹配。端口不能是随机分配的
 *    （Electron 生产环境自己的服务端口就是随机的），只能让用户注册应用时填死。
 *
 * 2. 写收藏用 POST /v0/users/-/collections/{subject_id}，官方定义为
 *    「不存在则创建，存在则修改」，天然幂等 —— 不需要先 GET 再决定 POST 还是 PATCH。
 *
 * 3. rate 是 0-10 的整数，且 **0 表示「删除评分」而不是 0 分**。
 *    传 0 会把用户之前的评分抹掉，所以低分要钳到 1（见 core/bangumi-score.ts）。
 */
import fs from 'fs';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import type { FetchLike } from './media-sources';

const AUTH_BASE = 'https://bgm.tv';
const API_BASE = 'https://api.bgm.tv';

/** Bangumi 要求带可识别的 UA，缺了会 403 */
const USER_AGENT = 'AnimeDiary/1.3.6 (https://github.com/anime-diary; personal anime scoring app)';

/** 授权回调最多等多久，超时自动关掉本地端口，避免一直占着 */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/** 提前多久判定 token 过期（避免请求发出时刚好失效） */
const REFRESH_AHEAD_MS = 60 * 1000;

export interface BangumiUser {
  id: number;
  username: string;
  nickname: string;
  avatar?: string;
}

/** 落盘结构。token 是本机明文，和浏览器保存登录态没有本质区别 */
interface StoredAccount {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  accessToken?: string;
  refreshToken?: string;
  /** 毫秒时间戳 */
  expiresAt?: number;
  user?: BangumiUser;
}

/** 给界面看的脱敏状态 */
export interface PublicAccountState {
  /** 三个凭据字段都填了才能发起授权 */
  configured: boolean;
  loggedIn: boolean;
  user?: BangumiUser;
  expiresAt?: number;
  /** 授权进行中（本地端口已在等回调） */
  loginPending: boolean;
  clientId?: string;
  redirectUri?: string;
}

export interface CollectionPayload {
  /** 1 想看 / 2 看过 / 3 在看 / 4 搁置 / 5 抛弃 */
  type?: number;
  /** 1-10，不传表示不改评分 */
  rate?: number;
  comment?: string;
  tags?: string[];
  private?: boolean;
  epStatus?: number;
}

export interface UploadResult {
  ok: boolean;
  subjectId: number;
  /** 已存在的收藏被更新时 Bangumi 也返回 204，这里只区分成功/失败 */
  status: number;
  error?: string;
}

export interface BangumiAccountContext {
  DATA_DIR: string;
  fetchImpl?: FetchLike;
}

export function createBangumiAccount({ DATA_DIR, fetchImpl }: BangumiAccountContext) {
  const STORE_PATH = path.join(DATA_DIR, 'bangumi_account.json');
  const httpFetch = (fetchImpl ?? globalThis.fetch) as unknown as typeof globalThis.fetch;

  let loginPending: { state: string; server: http.Server; timer: ReturnType<typeof setTimeout> } | null = null;

  function readStore(): StoredAccount {
    try {
      if (!fs.existsSync(STORE_PATH)) return {};
      return JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8')) as StoredAccount;
    } catch {
      // 文件损坏不该让整个账号功能瘫痪，当成没配置
      return {};
    }
  }

  function writeStore(next: StoredAccount): void {
    const dir = path.dirname(STORE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(next, null, 2), 'utf-8');
  }

  function closeLoginServer(): void {
    if (!loginPending) return;
    clearTimeout(loginPending.timer);
    try { loginPending.server.close(); } catch { /* 已关闭 */ }
    loginPending = null;
  }

  function state(): PublicAccountState {
    const acc = readStore();
    const hasToken = !!acc.accessToken;
    return {
      configured: !!(acc.clientId && acc.clientSecret && acc.redirectUri),
      loggedIn: hasToken && !!acc.user,
      user: acc.user,
      expiresAt: acc.expiresAt,
      loginPending: !!loginPending,
      clientId: acc.clientId,
      redirectUri: acc.redirectUri,
    };
  }

  /** 保存应用凭据。换掉 clientId/secret 会同时清空旧 token（那是另一个应用的授权） */
  function saveCredentials(input: { clientId?: string; clientSecret?: string; redirectUri?: string }): PublicAccountState {
    const acc = readStore();
    const next: StoredAccount = { ...acc };
    if (input.clientId !== undefined) next.clientId = input.clientId.trim();
    if (input.clientSecret !== undefined) next.clientSecret = input.clientSecret.trim();
    if (input.redirectUri !== undefined) next.redirectUri = input.redirectUri.trim();
    if (next.clientId !== acc.clientId || next.clientSecret !== acc.clientSecret) {
      next.accessToken = undefined;
      next.refreshToken = undefined;
      next.expiresAt = undefined;
      next.user = undefined;
    }
    writeStore(next);
    return state();
  }

  function logout(): PublicAccountState {
    closeLoginServer();
    const acc = readStore();
    writeStore({
      clientId: acc.clientId,
      clientSecret: acc.clientSecret,
      redirectUri: acc.redirectUri,
    });
    return state();
  }

  // ── OAuth ──

  interface TokenResponse {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    user_id?: number;
  }

  async function postForm(url: string, form: Record<string, string>): Promise<TokenResponse> {
    const body = new URLSearchParams(form).toString();
    const resp = await httpFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
      body,
    });
    const text = await resp.text();
    if (!resp.ok) {
      // Bangumi 失败时可能返回 HTML，截断避免把整页塞进日志
      throw new Error(`换取 token 失败（HTTP ${resp.status}）：${text.slice(0, 200)}`);
    }
    try {
      return JSON.parse(text) as TokenResponse;
    } catch {
      throw new Error('Bangumi 返回的 token 不是 JSON，可能是网络代理改写了响应');
    }
  }

  async function getMe(token: string): Promise<BangumiUser> {
    const resp = await httpFetch(`${API_BASE}/v0/me`, {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!resp.ok) throw new Error(`获取账号信息失败（HTTP ${resp.status}）`);
    const json = (await resp.json()) as {
      id: number; username: string; nickname?: string;
      avatar?: { medium?: string; large?: string; small?: string };
    };
    return {
      id: json.id,
      username: json.username,
      nickname: json.nickname || json.username,
      avatar: json.avatar?.medium || json.avatar?.large || json.avatar?.small,
    };
  }

  async function exchangeCode(code: string): Promise<TokenResponse> {
    const acc = readStore();
    return postForm(`${AUTH_BASE}/oauth/access_token`, {
      grant_type: 'authorization_code',
      client_id: acc.clientId ?? '',
      client_secret: acc.clientSecret ?? '',
      code,
      redirect_uri: acc.redirectUri ?? '',
    });
  }

  function persistToken(token: TokenResponse): void {
    const acc = readStore();
    const expiresIn = typeof token.expires_in === 'number' && token.expires_in > 0 ? token.expires_in : 0;
    writeStore({
      ...acc,
      accessToken: token.access_token,
      // 有些授权不返回新的 refresh_token，保留旧的
      refreshToken: token.refresh_token ?? acc.refreshToken,
      expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
    });
  }

  async function refreshToken(): Promise<string> {
    const acc = readStore();
    if (!acc.refreshToken) throw new Error('登录已过期，请重新授权');
    const token = await postForm(`${AUTH_BASE}/oauth/access_token`, {
      grant_type: 'refresh_token',
      client_id: acc.clientId ?? '',
      client_secret: acc.clientSecret ?? '',
      refresh_token: acc.refreshToken,
      redirect_uri: acc.redirectUri ?? '',
    });
    persistToken(token);
    return token.access_token;
  }

  /** 拿一个当前可用的 token；快过期就顺手刷新 */
  async function ensureToken(): Promise<string> {
    const acc = readStore();
    if (!acc.accessToken) throw new Error('还没有登录 Bangumi');
    // 没有 expires_at 的视作长期有效（Bangumi 的个人 token 可能不返回 expires_in）
    if (!acc.expiresAt) return acc.accessToken;
    if (Date.now() < acc.expiresAt - REFRESH_AHEAD_MS) return acc.accessToken;

    try {
      return await refreshToken();
    } catch (e) {
      // 刷新失败但旧 token 还没真正过期：先用着，别把用户踢下线
      if (Date.now() < acc.expiresAt) return acc.accessToken;
      writeStore({
        clientId: acc.clientId,
        clientSecret: acc.clientSecret,
        redirectUri: acc.redirectUri,
      });
      throw new Error(`登录已失效，请重新授权：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function htmlPage(title: string, message: string, ok: boolean): string {
    const color = ok ? '#4ade80' : '#f87171';
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${title}</title>
<style>
  body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
       background:#16161a;color:#e5e5e5;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
  .card{max-width:420px;padding:32px 36px;border-radius:14px;background:#1f1f24;
        border:1px solid #2e2e36;text-align:center;line-height:1.7}
  .icon{font-size:38px;margin-bottom:12px;color:${color}}
  h1{font-size:17px;margin:0 0 8px}
  p{font-size:13px;color:#a1a1aa;margin:0}
</style></head><body>
<div class="card">
  <div class="icon">${ok ? '✓' : '✗'}</div>
  <h1>${title}</h1>
  <p>${message}</p>
</div>
</body></html>`;
  }

  /**
   * 发起授权：在本机固定端口起一个临时 HTTP 服务等回调。
   * 返回授权页 URL，由前端交给系统浏览器打开。
   */
  async function startLogin(): Promise<{ url: string }> {
    const acc = readStore();
    if (!acc.clientId || !acc.clientSecret) throw new Error('还没有填写 Bangumi 应用的 App ID / App Secret');
    const redirectUri = (acc.redirectUri ?? '').trim();
    if (!redirectUri) throw new Error('还没有填写回调地址');

    let redirect: URL;
    try {
      redirect = new URL(redirectUri);
    } catch {
      throw new Error('回调地址不是合法的 URL');
    }
    if (redirect.protocol !== 'http:') throw new Error('回调地址必须是 http://127.0.0.1:端口/... 形式');
    if (redirect.hostname !== '127.0.0.1' && redirect.hostname !== 'localhost') {
      throw new Error('回调地址必须是 127.0.0.1 或 localhost —— 授权码要回到本机');
    }
    if (!redirect.port) {
      throw new Error('回调地址必须带固定端口（例如 http://127.0.0.1:8765/callback），端口不能省');
    }

    closeLoginServer();

    const port = Number(redirect.port);
    const callbackPath = redirect.pathname || '/';
    const stateParam = crypto.randomBytes(16).toString('hex');

    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);

      // 浏览器会顺手请求 favicon，别把它当成授权回调
      if (url.pathname === '/favicon.ico') {
        res.statusCode = 204;
        res.end();
        return;
      }
      if (url.pathname !== callbackPath) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(htmlPage('路径不对', `授权回调应该落在 ${callbackPath}`, false));
        return;
      }

      const reply = (ok: boolean, title: string, message: string) => {
        res.statusCode = ok ? 200 : 400;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(htmlPage(title, message, ok));
      };

      const code = url.searchParams.get('code');
      const gotState = url.searchParams.get('state');
      const err = url.searchParams.get('error');

      if (err) {
        reply(false, '授权被拒绝', `Bangumi 返回：${err}`);
        closeLoginServer();
        return;
      }
      if (gotState !== stateParam) {
        // state 对不上说明这个回调不是本次授权流程发起的
        reply(false, '校验失败', 'state 不匹配，这次授权不是从本应用发起的，已忽略。');
        closeLoginServer();
        return;
      }
      if (!code) {
        reply(false, '缺少授权码', '回调里没有 code 参数。');
        closeLoginServer();
        return;
      }

      exchangeCode(code)
        .then(async (token) => {
          const user = await getMe(token.access_token);
          persistToken(token);
          writeStore({ ...readStore(), user });
          reply(true, '绑定成功', `${user.nickname}，可以关闭这个页面回到 AnimeDiary 了。`);
        })
        .catch((e) => {
          reply(false, '绑定失败', e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          // 留一秒让浏览器把响应收完再关端口
          setTimeout(closeLoginServer, 1000);
        });
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (e: NodeJS.ErrnoException) => {
        server.close();
        if (e.code === 'EADDRINUSE') {
          reject(new Error(`端口 ${port} 被占用了。关掉占用它的程序，或者把应用后台和这里的回调地址都改成别的端口。`));
        } else {
          reject(new Error(`本地回调服务启动失败：${e.message}`));
        }
      };
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', onError);
        resolve();
      });
    });

    const timer = setTimeout(() => {
      closeLoginServer();
    }, LOGIN_TIMEOUT_MS);
    loginPending = { state: stateParam, server, timer };

    const authorize = new URL(`${AUTH_BASE}/oauth/authorize`);
    authorize.searchParams.set('client_id', acc.clientId);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('redirect_uri', redirectUri);
    authorize.searchParams.set('state', stateParam);

    return { url: authorize.toString() };
  }

  // ── 收藏 ──

  /** 写收藏（upsert）。单条调用，批量由前端串行发起，便于逐条显示结果 */
  async function uploadCollection(subjectId: number, payload: CollectionPayload): Promise<UploadResult> {
    if (!Number.isInteger(subjectId) || subjectId <= 0) {
      return { ok: false, subjectId, status: 0, error: 'subject_id 非法' };
    }
    let token: string;
    try {
      token = await ensureToken();
    } catch (e) {
      return { ok: false, subjectId, status: 401, error: e instanceof Error ? e.message : String(e) };
    }

    const body: Record<string, unknown> = {};
    if (payload.type !== undefined) body.type = payload.type;
    if (payload.rate !== undefined) body.rate = payload.rate;
    if (payload.comment !== undefined) body.comment = payload.comment;
    if (payload.tags !== undefined) body.tags = payload.tags;
    if (payload.private !== undefined) body.private = payload.private;
    if (payload.epStatus !== undefined) body.ep_status = payload.epStatus;

    try {
      const resp = await httpFetch(`${API_BASE}/v0/users/-/collections/${subjectId}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (resp.ok) return { ok: true, subjectId, status: resp.status };
      const text = (await resp.text()).slice(0, 300);
      return { ok: false, subjectId, status: resp.status, error: text || `HTTP ${resp.status}` };
    } catch (e) {
      return { ok: false, subjectId, status: 0, error: e instanceof Error ? e.message : String(e) };
    }
  }

  return { state, saveCredentials, startLogin, logout, ensureToken, uploadCollection, closeLoginServer };
}
