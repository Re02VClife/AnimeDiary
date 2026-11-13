/**
 * server/proxy-fetch — 一个「读系统代理」的 fetch 兼容层（仅开发/无 net.fetch 时使用）
 *
 * 为什么需要它：`api.bgm.tv` 在境内会被 DNS 污染到 Facebook 的 IP（实测解析出
 * `2a03:2880:...face:b00c...` 与 `128.242.240.61`），直连必然 UND_ERR_CONNECT_TIMEOUT。
 * 而 Node 自带的 fetch(undici) **完全不读系统代理** —— 这正是 AGENTS/注释里反复提到的坑：
 *   - 生产（Electron）传 `net.fetch`，走 Chromium 网络栈，自动遵守系统代理 → 没问题；
 *   - 开发（vite 中间件）没有 fetchImpl，落到全局 fetch → 撞污染。
 *
 * 这里用零依赖的方式补上：读环境变量或 Windows 注册表里的系统代理，
 * 通过 HTTP `CONNECT` 建隧道再手搓 TLS，把请求送出去。
 *
 * 不支持的场景（会明确报错，而不是静默超时）：SOCKS 代理、需要认证的代理。
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { execSync } from 'node:child_process';
import type { FetchLike, ResponseLike } from './media-sources';

/** 缓存：读一次注册表就够了，但允许测试时传 0 刷新 */
let cachedProxy: string | null | undefined;

/** `127.0.0.1:7890` / `http=host:port;https=host:port` / `http://host:port` 统一成 URL */
function toProxyUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
}

function parseProxyServer(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  // 注册表的 ProtocolPrefix 形态：http=127.0.0.1:7890;https=127.0.0.1:7890
  if (text.includes('=')) {
    for (const part of text.split(';')) {
      const [scheme, value] = part.split('=');
      if (!value) continue;
      const name = scheme.trim().toLowerCase();
      if (name === 'https' || name === 'http') return toProxyUrl(value);
    }
    return null;
  }
  return toProxyUrl(text);
}

/**
 * 当前生效的代理：环境变量优先，其次 Windows 的「Internet 选项」。
 * 返回 null 表示直连（Linux/macOS 上只看环境变量）。
 */
export function resolveSystemProxy(): string | null {
  if (cachedProxy !== undefined) return cachedProxy;

  const env =
    process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy
    || process.env.ALL_PROXY || process.env.all_proxy;
  if (env) {
    cachedProxy = toProxyUrl(env);
    return cachedProxy;
  }

  if (process.platform === 'win32') {
    try {
      const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
      const enable = execSync(`reg query "${key}" /v ProxyEnable`, { encoding: 'utf8', windowsHide: true });
      if (/ProxyEnable\s+REG_DWORD\s+0x1/i.test(enable)) {
        const server = execSync(`reg query "${key}" /v ProxyServer`, { encoding: 'utf8', windowsHide: true });
        const m = /ProxyServer\s+REG_SZ\s+(.+)/i.exec(server);
        if (m) {
          cachedProxy = parseProxyServer(m[1].trim());
          return cachedProxy;
        }
      }
    } catch {
      /* 读不到注册表就当没有代理，直连再失败会给出明确错误 */
    }
  }

  cachedProxy = null;
  return null;
}

/** 仅供测试重置缓存 */
export function resetProxyCache(): void {
  cachedProxy = undefined;
}

/** 在代理上开一条到目标主机的 CONNECT 隧道，返回裸 socket */
function openTunnel(
  proxy: URL,
  host: string,
  port: number,
  timeoutMs: number,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(
      { host: proxy.hostname, port: Number(proxy.port) || 80 },
      () => {
        socket.write(
          `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n` +
          'Proxy-Connection: Keep-Alive\r\n\r\n',
        );
      },
    );

    let head = '';
    const onData = (chunk: Buffer) => {
      head += chunk.toString('latin1');
      const end = head.indexOf('\r\n\r\n');
      if (end === -1) {
        if (head.length > 8192) {
          socket.destroy();
          reject(new Error('代理响应异常'));
        }
        return;
      }
      socket.off('data', onData);
      const statusLine = head.slice(0, end).split('\r\n')[0] || '';
      if (!/^HTTP\/1\.[01] 2\d\d/.test(statusLine)) {
        socket.destroy();
        reject(new Error(`代理拒绝建立隧道：${statusLine || '无响应'}`));
        return;
      }
      resolve(socket);
    };

    socket.on('data', onData);
    socket.on('error', (e) => reject(new Error(`连不上代理 ${proxy.hostname}:${proxy.port}（${e.message}）`)));
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error(`连接代理超时（${timeoutMs}ms）`));
    });
  });
}

/** 把响应体收完，转成最小的 Response 契约 */
function toResponse(res: http.IncomingMessage): Promise<ResponseLike> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => {
      const buf = Buffer.concat(chunks);
      const status = res.statusCode ?? 0;
      resolve({
        ok: status >= 200 && status < 300,
        status,
        headers: {
          get: (name: string) => {
            const value = res.headers[name.toLowerCase()];
            return Array.isArray(value) ? value.join(', ') : (value ?? null);
          },
        },
        json: async () => JSON.parse(buf.toString('utf8')),
        text: async () => buf.toString('utf8'),
        arrayBuffer: async () =>
          buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
      });
    });
    res.on('error', reject);
  });
}

/**
 * 造一个走系统代理的 FetchLike。
 * 没有代理时退化为普通 https.request —— 此时若域名被污染仍然会失败，
 * 错误信息里会带上代理状态，便于用户判断「是不是没开代理」。
 */
export function createProxyAwareFetch(timeoutMs = 15_000): FetchLike {
  return async function proxyFetch(url: string, init?: Record<string, unknown>): Promise<ResponseLike> {
    const target = new URL(url);
    const headers: Record<string, string> = {};
    const rawHeaders = (init?.headers ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(rawHeaders)) {
      if (v !== undefined && v !== null) headers[k] = String(v);
    }
    headers.Host = target.host;

    const isHttps = target.protocol === 'https:';
    const port = Number(target.port) || (isHttps ? 443 : 80);
    const path = `${target.pathname}${target.search}`;
    const proxy = resolveSystemProxy();

    try {
      if (!proxy) {
        // 直连：https 交给 Node 自己建 TLS
        return await new Promise<ResponseLike>((resolve, reject) => {
          const mod = isHttps ? https : http;
          const req = mod.request(
            { host: target.hostname, port, path, method: 'GET', headers },
            (res) => { void toResponse(res).then(resolve, reject); },
          );
          req.on('error', reject);
          req.setTimeout(timeoutMs, () => req.destroy(new Error(`请求超时（${timeoutMs}ms）`)));
          req.end();
        });
      }

      const socket = await openTunnel(new URL(proxy), target.hostname, port, timeoutMs);
      const stream = isHttps
        ? await new Promise<tls.TLSSocket>((resolve, reject) => {
          const s = tls.connect({ socket, servername: target.hostname });
          s.once('secureConnect', () => resolve(s));
          s.once('error', (e) => reject(new Error(`TLS 握手失败：${e.message}`)));
        })
        : socket;

      // 隧道已经是加密的了，用 http 模块在它上面读写明文 HTTP 即可
      return await new Promise<ResponseLike>((resolve, reject) => {
        const req = http.request(
          {
            host: target.hostname,
            port,
            path,
            method: 'GET',
            headers,
            createConnection: () => stream,
          },
          (res) => { void toResponse(res).then(resolve, reject); },
        );
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => req.destroy(new Error(`请求超时（${timeoutMs}ms）`)));
        req.end();
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      const hint = proxy
        ? `（已尝试代理 ${proxy}）`
        : '（没有检测到系统代理，可能被 DNS 污染 —— 开代理或在系统设置里配好代理后重试）';
      throw new Error(`网络请求失败：${reason}${hint}`);
    }
  };
}
