/**
 * 角色语音 —— 客户端服务层
 *
 * 与 server/character-voice.ts 配套。VoiceInfo / FfmpegStatus 的结构要和那边
 * 保持一致（项目惯例：server 与 features 各定义一份，注释互相指向）。
 */
import type { VoiceCandidate } from '../../core/voice-search';

export type { VoiceCandidate };

export interface VoiceSource {
  bvid: string;
  title: string;
  author: string;
  pageUrl: string;
}

export interface VoiceInfo {
  character: string;
  fileName: string;
  url: string;
  seconds: number;
  spans: Array<[number, number]>;
  source: VoiceSource;
  builtAt: string;
}

export interface FfmpegStatus {
  ok: boolean;
  path: string | null;
  version: string | null;
  hint: string;
}

async function readJson(resp: Response): Promise<any> {
  const data = await resp.json().catch(() => null);
  if (!resp.ok) throw new Error((data && data.error) || `HTTP ${resp.status}`);
  return data;
}

/** 本机能不能生成语音（取决于有没有 ffmpeg） */
export async function fetchVoiceStatus(): Promise<FfmpegStatus> {
  const resp = await fetch('/api/character/voice/status');
  return (await readJson(resp)) as FfmpegStatus;
}

/** 搜 B 站上的角色语音视频。只搜索不下载，由人挑一个再生成 */
export async function searchVoice(
  character: string,
  keyword?: string,
  workTitles: string[] = [],
): Promise<VoiceCandidate[]> {
  const resp = await fetch('/api/character/voice/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character, keyword, workTitles }),
  });
  const data = await readJson(resp);
  return (data?.candidates ?? []) as VoiceCandidate[];
}

/**
 * 下载 + 切分 + 拼接。
 *
 * 超时给到 3 分钟：服务端要先把整段视频音频解一遍找静音（10 分钟的源
 * 大约要几秒），再跑一次 concat。比这更慢通常是网络问题。
 */
export async function buildVoice(options: {
  bvid: string;
  character: string;
  targetSeconds?: number;
}): Promise<VoiceInfo> {
  const resp = await fetch('/api/character/voice/build', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
    signal: AbortSignal.timeout(180000),
  });
  const data = await readJson(resp);
  if (!data?.info) throw new Error('服务端没有返回语音信息');
  return data.info as VoiceInfo;
}

/** 已经生成过的语音（没有就是 null） */
export async function fetchVoiceInfo(character: string): Promise<VoiceInfo | null> {
  const qs = new URLSearchParams({ character });
  const resp = await fetch(`/api/character/voice/info?${qs.toString()}`);
  const data = await readJson(resp);
  return (data?.info ?? null) as VoiceInfo | null;
}

/**
 * 播放地址。
 * 带一个 builtAt 后缀：重新生成后 URL 不变，不加会让 <audio> 播到旧的缓存。
 */
export function voiceFileUrl(character: string, version?: string): string {
  const qs = new URLSearchParams({ character });
  if (version) qs.set('t', version);
  return `/api/character/voice/file?${qs.toString()}`;
}

export async function deleteVoice(character: string): Promise<boolean> {
  const qs = new URLSearchParams({ character });
  const resp = await fetch(`/api/character/voice/delete?${qs.toString()}`, { method: 'DELETE' });
  const data = await readJson(resp);
  return !!data?.ok;
}
