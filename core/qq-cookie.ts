/**
 * core/qq-cookie — 解析用户从浏览器粘来的 QQ 音乐 Cookie（纯逻辑，无网络无 fs）
 *
 * 为什么需要它：VIP 曲子的播放地址（vkey）只对**登录态**发放，匿名请求一律
 * `result: 104003` + 空 purl。用户已经有绿钻，所以让他把浏览器里 y.qq.com 的
 * Cookie 粘进来，服务端带着它去要地址，就能在应用内直接播，不必跳网页/客户端。
 *
 * 这里只做三件事：把各种粘贴格式归一成一条 Cookie 头、挑出真正有用的键、
 * 把 uin 规整成 vkey 接口要的形态。**不做任何校验请求** —— 对不对由 vkey 说了算。
 */

/** 真正会影响 vkey 的键；其余键（pgv_pvid、ts_uid…）丢掉，少一点泄露面 */
const KEEP_KEYS = [
  'uin', 'p_uin', 'qm_keyst', 'qqmusic_key', 'skey', 'p_skey', 'psrf_qqunionid',
  'psrf_qqopenid', 'psrf_qqaccess_token', 'psrf_qqrefresh_token', 'psrf_musickey_createtime',
  'psrf_access_token_expiresAt', 'login_type', 'wxuin', 'wxopenid', 'wxrefresh_token',
];

export interface ParsedQqCookie {
  /** 归一后的 Cookie 头（只保留白名单键） */
  cookie: string;
  /** 纯数字 uin（vkey 的 comm.uin 用它；原始值可能是 o0123456789） */
  uin: string;
  /** 原始 uin（带 o 前缀那种），用于 Cookie 头 */
  rawUin: string;
  /** 命中的键，便于在界面上说清楚「认到了什么」 */
  keys: string[];
}

export class QqCookieError extends Error {}

/**
 * 解析用户粘贴的内容。支持三种常见形态：
 *   - 整条请求头：`uin=o123; qm_keyst=...; qqmusic_key=...`
 *   - 换行分隔：`uin=o123\nqm_keyst=...`
 *   - 只贴关键几个：`qm_keyst=...; uin=o123`
 */
export function parseQqCookie(input: string): ParsedQqCookie {
  const text = String(input ?? '').trim();
  if (!text) throw new QqCookieError('Cookie 是空的：请把 y.qq.com 的 Cookie 整条粘进来');

  const pairs = new Map<string, string>();
  for (const chunk of text.split(/[;\n\r]+/)) {
    const piece = chunk.trim().replace(/^cookie:\s*/i, '');
    if (!piece) continue;
    const eq = piece.indexOf('=');
    if (eq <= 0) continue;
    const key = piece.slice(0, eq).trim();
    const value = piece.slice(eq + 1).trim();
    if (!key || !value) continue;
    if (!KEEP_KEYS.includes(key)) continue;
    pairs.set(key, value);
  }

  const rawUin = pairs.get('uin') ?? pairs.get('p_uin') ?? '';
  const uin = rawUin.replace(/^o/, '').replace(/\D/g, '');
  const hasKey = pairs.has('qm_keyst') || pairs.has('qqmusic_key');

  if (!hasKey) {
    throw new QqCookieError(
      '没找到 qm_keyst / qqmusic_key：请确认是在 y.qq.com 登录后复制的 Cookie（不是客户端的，也不是 gl.qq.com 的）',
    );
  }
  if (!uin) {
    throw new QqCookieError('没找到 uin：整条 Cookie 一起复制，别只挑 qm_keyst');
  }

  return {
    cookie: Array.from(pairs, ([k, v]) => `${k}=${v}`).join('; '),
    uin,
    rawUin,
    keys: Array.from(pairs.keys()),
  };
}

/** 界面上只显示尾号，避免把账号完整暴露在日志/截图里 */
export function maskUin(uin: string): string {
  const digits = String(uin ?? '').replace(/\D/g, '');
  if (digits.length <= 4) return digits ? '****' : '';
  return `${digits.slice(0, 3)}****${digits.slice(-3)}`;
}
