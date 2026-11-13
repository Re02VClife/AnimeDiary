/**
 * 前端访问 /api/bangumi/account 与 /api/bangumi/collection 的薄封装。
 *
 * 上传是**逐条串行**发出的：Bangumi 的写接口没有批量端点，而且用户需要
 * 看到「哪一条失败、为什么失败」。并发发反而会让 429 更难定位。
 */
import type { MatchCandidate } from '../../../core/bangumi-match';

export interface BangumiAccountState {
  configured: boolean;
  loggedIn: boolean;
  loginPending: boolean;
  user?: { id: number; username: string; nickname: string; avatar?: string };
  expiresAt?: number;
  clientId?: string;
  redirectUri?: string;
}

export interface CollectionPayload {
  type?: number;
  rate?: number;
  comment?: string;
  tags?: string[];
  private?: boolean;
  epStatus?: number;
}

export interface UploadResult {
  ok: boolean;
  subjectId: number;
  status: number;
  error?: string;
}

async function readJson(resp: Response): Promise<any> {
  const text = await resp.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`服务返回了非 JSON 内容（HTTP ${resp.status}）`);
  }
}

export async function fetchAccountState(): Promise<BangumiAccountState> {
  const resp = await fetch('/api/bangumi/account');
  const data = await readJson(resp);
  if (!resp.ok) throw new Error(data?.error || `HTTP ${resp.status}`);
  return data as BangumiAccountState;
}

export async function saveCredentials(input: {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
}): Promise<BangumiAccountState> {
  const resp = await fetch('/api/bangumi/account/credentials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const data = await readJson(resp);
  if (!resp.ok) throw new Error(data?.error || `HTTP ${resp.status}`);
  return data as BangumiAccountState;
}

/** 返回授权页 URL。由调用方交给系统浏览器（window.open 在 Electron 里会被转成 shell.openExternal） */
export async function startLogin(): Promise<{ url: string; state: BangumiAccountState }> {
  const resp = await fetch('/api/bangumi/account/login', { method: 'POST' });
  const data = await readJson(resp);
  if (!resp.ok) throw new Error(data?.error || `HTTP ${resp.status}`);
  return { url: data.url, state: data as BangumiAccountState };
}

export async function logout(): Promise<BangumiAccountState> {
  const resp = await fetch('/api/bangumi/account/logout', { method: 'POST' });
  const data = await readJson(resp);
  if (!resp.ok) throw new Error(data?.error || `HTTP ${resp.status}`);
  return data as BangumiAccountState;
}

/** 单条收藏写入（upsert） */
export async function uploadCollection(subjectId: number, payload: CollectionPayload): Promise<UploadResult> {
  const resp = await fetch(`/api/bangumi/collection/${subjectId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await readJson(resp);
  if (!resp.ok && !data?.error) return { ok: false, subjectId, status: resp.status, error: `HTTP ${resp.status}` };
  return data as UploadResult;
}

/**
 * 复用已有的搜索代理（带 24h 缓存、带代理设置）。
 * 返回结构里的 name / name_cn / aliases / air_date 正好对应匹配器的输入。
 */
export async function searchBangumi(keyword: string, signal?: AbortSignal): Promise<MatchCandidate[]> {
  const resp = await fetch(`/api/bangumi/search?keyword=${encodeURIComponent(keyword)}`, { signal });
  const data = await readJson(resp);
  if (!resp.ok) throw new Error(data?.error || `HTTP ${resp.status}`);
  // 搜索接口在网络不通时仍返回 200 + offline:true。当成空结果会让界面显示
  // 「没有候选」，用户根本不知道是代理没开 —— 这里必须显式报错。
  if (data?.offline) {
    throw new Error(`Bangumi 连不上：${data.error || '请求超时'}（需要开代理）`);
  }
  const list = Array.isArray(data?.list) ? data.list : [];
  return list
    .filter((x: any) => typeof x?.id === 'number')
    .map((x: any) => ({
      id: Number(x.id),
      name: String(x.name || ''),
      nameCn: x.name_cn ? String(x.name_cn) : undefined,
      aliases: Array.isArray(x.aliases) ? x.aliases.filter((a: unknown) => typeof a === 'string') : undefined,
      airDate: typeof x.air_date === 'string' ? x.air_date : undefined,
    }));
}
