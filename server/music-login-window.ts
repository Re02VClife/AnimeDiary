/**
 * server/music-login-window — 「一键登录 QQ 音乐」的桌面登录窗
 *
 * 为什么在服务端开窗口，而不是加到 electron/main.js：
 *   打包版里 `/api` 的 handler 就跑在**主进程**里（electron/api-server.js 用
 *   `new Function` 加载热更新目录里的 api-routes.cjs），所以这里 `require('electron')`
 *   拿到的就是主进程 API（实测 BrowserWindow / session 都可用）。
 *   放进服务端最大的好处是**热更新就能生效**，不必为了一个登录窗重打安装包。
 *
 * 流程：开一个独立 session 的窗口 → 用户在里面扫码/登录 y.qq.com →
 *       轮询该 session 的 cookie，拿到 qm_keyst + uin 就立刻关窗并把登录态交给
 *       music client 落盘（music-login.json）。渲染进程全程看不到 Cookie 原文。
 *
 * dev（Vite 跑在纯 Node 里）没有 electron 模块 —— 此时 start() 抛出
 * LoginWindowUnavailable，路由回 501，前端退回「手动粘贴 Cookie」。
 */

import crypto from 'crypto';
import type { MusicClient, MusicLoginStatus } from './music-qq';

export type LoginWindowState = 'pending' | 'done' | 'cancelled' | 'timeout' | 'error';

export interface LoginWindowStatus {
  state: LoginWindowState;
  login?: MusicLoginStatus;
  error?: string;
}

export class LoginWindowUnavailable extends Error {
  constructor(message = '当前环境不支持打开登录窗口（只有桌面版可以）') {
    super(message);
    this.name = 'LoginWindowUnavailable';
  }
}

/** 登录窗最多等 4 分钟：够扫码 + 可能的两步验证，又不至于把窗口挂一整晚 */
const LOGIN_TIMEOUT_MS = 4 * 60 * 1000;
/** 轮询 cookie 的间隔 */
const POLL_MS = 800;
/** 会话保活：前端可能只轮询几次就关掉页面，留 10 分钟够它取结果 */
const SESSION_TTL_MS = 10 * 60 * 1000;

interface LoginSession {
  state: LoginWindowState;
  login?: MusicLoginStatus;
  error?: string;
  startedAt: number;
  win: any;
  timer: ReturnType<typeof setInterval> | null;
  timeout: ReturnType<typeof setTimeout> | null;
}

/** 需要带过去才能换到播放地址的键（与 core/qq-cookie 的白名单一致） */
const COOKIE_KEYS = ['uin', 'p_uin', 'qm_keyst', 'qqmusic_key', 'skey', 'p_skey'];

export interface LoginWindowRunner {
  start(): Promise<{ sessionId: string }>;
  status(sessionId: string): LoginWindowStatus | null;
  /** 用户点了「取消」/ 页面关掉：立即关窗并把状态置为 cancelled */
  cancel(sessionId: string): LoginWindowStatus | null;
  /** 进程退出/测试用：关掉所有窗口 */
  disposeAll(): void;
}

export function createLoginWindowRunner(music: MusicClient): LoginWindowRunner {
  const sessions = new Map<string, LoginSession>();

  function electron(): any {
    if (typeof process === 'undefined' || !process.versions?.electron) {
      throw new LoginWindowUnavailable('当前不是桌面版（浏览器里没有 Electron），请手动粘贴 Cookie');
    }
    try {
      // 必须在运行时 require：dev 的 Node 里没有这个模块
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require('electron');
    } catch {
      throw new LoginWindowUnavailable();
    }
  }

  function sweep(): void {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.startedAt > SESSION_TTL_MS) {
        if (session.timer) clearInterval(session.timer);
        if (session.timeout) clearTimeout(session.timeout);
        try { if (session.win && !session.win.isDestroyed()) session.win.close(); } catch { /* ignore */ }
        sessions.delete(id);
      }
    }
  }

  async function collectCookie(ses: any): Promise<string | null> {
    const all = await ses.cookies.get({});
    const pick = (name: string) => all.find((c: any) => c.name === name && /(^|\.)qq\.com$/.test(c.domain));
    const key = pick('qm_keyst') || pick('qqmusic_key');
    const uin = pick('uin') || pick('p_uin');
    if (!key || !uin) return null;
    const parts: string[] = [];
    for (const name of COOKIE_KEYS) {
      const c = pick(name);
      if (c) parts.push(`${name}=${c.value}`);
    }
    return parts.join('; ');
  }

  async function start(): Promise<{ sessionId: string }> {
    sweep();
    const { BrowserWindow, session, shell } = electron();
    const sessionId = crypto.randomUUID();

    // 独立分区：登录态只存在这个窗口里，不污染应用主 session
    const ses = session.fromPartition('persist:qqmusic-login');
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;

    const win = new BrowserWindow({
      width: 520,
      height: 780,
      parent: parent ?? undefined,
      modal: false,
      show: true,
      autoHideMenuBar: true,
      title: '登录 QQ 音乐（关掉窗口 = 取消）',
      backgroundColor: '#17171c',
      webPreferences: {
        session: ses,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    const sessionState: LoginSession = {
      state: 'pending',
      startedAt: Date.now(),
      win,
      timer: null,
      timeout: null,
    };
    sessions.set(sessionId, sessionState);

    const finish = (state: LoginWindowState, extra?: { login?: MusicLoginStatus; error?: string }) => {
      if (sessionState.state !== 'pending') return;
      sessionState.state = state;
      sessionState.login = extra?.login;
      sessionState.error = extra?.error;
      if (sessionState.timer) clearInterval(sessionState.timer);
      if (sessionState.timeout) clearTimeout(sessionState.timeout);
      sessionState.timer = null;
      sessionState.timeout = null;
      try { if (!win.isDestroyed()) win.close(); } catch { /* 已经关了 */ }
    };

    sessionState.timer = setInterval(async () => {
      if (sessionState.state !== 'pending') return;
      try {
        const cookie = await collectCookie(ses);
        if (!cookie) return;
        // 服务端直接落盘：渲染进程不需要、也不应该看到 Cookie 原文
        const login = music.login(cookie);
        finish('done', { login });
      } catch (e) {
        finish('error', { error: e instanceof Error ? e.message : String(e) });
      }
    }, POLL_MS);

    sessionState.timeout = setTimeout(() => finish('timeout', { error: '登录超时（4 分钟）' }), LOGIN_TIMEOUT_MS);

    win.on('closed', () => {
      // 用户手动关窗 = 取消；已经 done 的话状态早就不是 pending
      finish('cancelled');
      if (sessionState.state === 'cancelled') {
        // 释放窗口引用，避免 GC 不掉
        sessionState.win = null;
      }
    });

    // 加载登录页：y.qq.com 首页右上角有登录入口，扫码即可
    win.loadURL('https://y.qq.com/').catch(() => {
      // 网络挂了也别让窗口白屏：给个可点的提示
      win.loadURL('data:text/html,<body style="font-family:sans-serif;padding:24px;color:#ddd;background:%2317171c">'
        + '<h3>打不开 y.qq.com</h3><p>检查网络后关掉本窗口，再点一次「一键登录」。</p></body>').catch(() => {});
    });

    // 登录流程里 qq.com 可能弹新窗（扫码/授权页）：让它**在窗口内**开，
    // 这样 cookie 仍然落在本 session 里；站外链接才丢给系统浏览器。
    win.webContents.setWindowOpenHandler(({ url }: { url: string }) => {
      if (/^https?:\/\/([^/]+\.)?(qq\.com|qq\.cn)\//i.test(url)) return { action: 'allow' };
      try { shell.openExternal(url); } catch { /* ignore */ }
      return { action: 'deny' };
    });

    return { sessionId };
  }

  function status(sessionId: string): LoginWindowStatus | null {
    const sessionState = sessions.get(sessionId);
    if (!sessionState) return null;
    return { state: sessionState.state, login: sessionState.login, error: sessionState.error };
  }

  function cancel(sessionId: string): LoginWindowStatus | null {
    const sessionState = sessions.get(sessionId);
    if (!sessionState) return null;
    if (sessionState.state === 'pending') {
      sessionState.state = 'cancelled';
      if (sessionState.timer) clearInterval(sessionState.timer);
      if (sessionState.timeout) clearTimeout(sessionState.timeout);
      sessionState.timer = null;
      sessionState.timeout = null;
      try { if (sessionState.win && !sessionState.win.isDestroyed()) sessionState.win.close(); } catch { /* ignore */ }
    }
    return status(sessionId);
  }

  function disposeAll(): void {
    for (const sessionState of sessions.values()) {
      if (sessionState.timer) clearInterval(sessionState.timer);
      if (sessionState.timeout) clearTimeout(sessionState.timeout);
      try { if (sessionState.win && !sessionState.win.isDestroyed()) sessionState.win.close(); } catch { /* ignore */ }
    }
    sessions.clear();
  }

  return { start, status, cancel, disposeAll };
}
