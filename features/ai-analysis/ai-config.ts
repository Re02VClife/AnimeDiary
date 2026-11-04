/**
 * features/ai-analysis/ai-config — 前端配置镜像
 *
 * 真正的配置（含 API Key）只存在服务端的 {DATA_DIR}/ai-config.json，
 * 这里仅保留一份"够 UI 用"的镜像：provider / model / 是否配了 Key 等。
 * 这样 API Key 不会出现在 localStorage 里被任意脚本读走。
 *
 * 使用方式：
 *   - App 启动时 `initAIConfig()` 拉一次服务端配置；
 *   - 同步判断 `hasAIConfig()` / `loadAIConfig()` 读的是镜像；
 *   - 修改配置用 `saveAIConfig(patch)` 提交到服务端。
 */

import type { AIPermission } from '../../core/ai-permission';
import { normalizeAIPermission } from '../../core/ai-permission';

export interface AIProviderInfo {
  id: string;
  label: string;
  baseUrl: string;
  models: string[];
  needsKey: boolean;
  /** 是否支持 thinking:{type:'disabled'} */
  thinkingParam?: boolean;
  hint?: string;
}

export interface AIConfig {
  provider: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  jsonMode: boolean;
  thinking: 'auto' | 'off';
  /** 深度模式（Bangumi 评论挖掘）开关 */
  deepMode: boolean;
  /** AI 写操作权限（read 只读 / confirm 提议后确认 / write 直接写入） */
  permission: AIPermission;
  hasKey: boolean;
  keyMask: string;
  providers: AIProviderInfo[];
}

const MIRROR_KEY = 'anime_diary_ai_mirror_v2';
const LEGACY_KEY = 'anime_diary_ai_config';

/** 服务端不可达时的兜底（仅用于首次渲染的文案） */
const FALLBACK: AIConfig = {
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  temperature: 0.4,
  maxTokens: 3000,
  timeoutMs: 120000,
  jsonMode: true,
  thinking: 'auto',
  deepMode: false,
  // 兜底取 confirm：既不改变现有「建议 → 你点采纳」的行为，也不会让 AI 悄悄改数据
  permission: 'confirm',
  hasKey: false,
  keyMask: '',
  providers: [
    { id: 'deepseek', label: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat'], needsKey: true },
    { id: 'opencode-go', label: 'OpenCode Go', baseUrl: 'https://opencode.ai/zen/go/v1', models: ['deepseek-v4.1-flash'], needsKey: true },
  ],
};

let mirror: AIConfig | null = null;

function readMirror(): AIConfig | null {
  try {
    const raw = localStorage.getItem(MIRROR_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return { ...FALLBACK, ...parsed, providers: parsed.providers?.length ? parsed.providers : FALLBACK.providers };
  } catch {
    return null;
  }
}

function writeMirror(config: AIConfig): void {
  mirror = config;
  try { localStorage.setItem(MIRROR_KEY, JSON.stringify(config)); } catch { /* 存储满 */ }
}

/** 同步读取当前配置镜像（不含密钥） */
export function loadAIConfig(): AIConfig {
  if (mirror) return mirror;
  mirror = readMirror() || { ...FALLBACK };
  return mirror;
}

/** 是否已配置到"可以发请求"的程度 */
export function hasAIConfig(): boolean {
  const c = loadAIConfig();
  return c.hasKey && c.baseUrl.length > 0 && c.model.length > 0;
}

/**
 * 当前生效的 AI 写操作权限。
 * 所有「AI 要不要改动数据」的判断都必须走这里，不要在组件里各自读 config.permission ——
 * 配置可能来自旧版本文件或手改的 JSON，统一在这里收敛成合法档位。
 */
export function getAIPermission(): AIPermission {
  return normalizeAIPermission(loadAIConfig().permission);
}

interface ServerConfigResponse {
  ok: boolean;
  config: AIConfig;
}

/** 拉取服务端配置（App 启动 / 设置面板打开时调用） */
export async function initAIConfig(): Promise<AIConfig> {
  try {
    const resp = await fetch('/api/ai/config', { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = (await resp.json()) as ServerConfigResponse;
    if (!json?.config) throw new Error('响应缺少 config');
    await migrateLegacyKey();
    writeMirror(json.config);
    return json.config;
  } catch {
    return loadAIConfig();
  }
}

/**
 * 老版本把 apiKey 存在 localStorage：自动搬到服务端后清掉。
 * 只做一次，失败也不阻塞（下次打开再试）。
 */
async function migrateLegacyKey(): Promise<void> {
  let legacy: { baseUrl?: string; apiKey?: string; model?: string; deepMode?: boolean } | null = null;
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return;
    legacy = JSON.parse(raw);
  } catch {
    return;
  }
  if (!legacy) return;

  if (legacy.apiKey) {
    try {
      const resp = await fetch('/api/ai/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'custom',
          baseUrl: legacy.baseUrl || undefined,
          model: legacy.model || undefined,
          apiKey: legacy.apiKey,
          deepMode: legacy.deepMode,
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) return; // 服务端没接受就保留，别把用户唯一的 Key 删了
    } catch {
      return;
    }
  }
  try { localStorage.removeItem(LEGACY_KEY); } catch { /* ignore */ }
}

/** 保存配置：apiKey 留空 = 不修改 */
export async function saveAIConfig(patch: Partial<AIConfig> & { apiKey?: string; clearKey?: boolean }): Promise<AIConfig> {
  const resp = await fetch('/api/ai/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
    signal: AbortSignal.timeout(10000),
  });
  const json = await resp.json();
  if (!resp.ok || !json?.config) {
    throw new Error(json?.error || `保存失败：HTTP ${resp.status}`);
  }
  writeMirror(json.config);
  return json.config;
}

/** 测试连通性（服务端真跑一次结构化请求） */
export async function testAIConnection(): Promise<{
  ok: boolean;
  latencyMs: number;
  model: string;
  provider: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number; reasoningTokens: number; cost?: number };
  sample?: string;
  error?: string;
  errorCode?: string;
}> {
  const resp = await fetch('/api/ai/test', { method: 'POST', signal: AbortSignal.timeout(180000) });
  if (!resp.ok) throw new Error(`测试接口返回 HTTP ${resp.status}`);
  return resp.json();
}

/** 拉取模型列表 */
export async function fetchAIModels(): Promise<{ models: string[]; source: 'remote' | 'preset'; error?: string }> {
  const resp = await fetch('/api/ai/models', { signal: AbortSignal.timeout(20000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

/** 最近调用记录（设置面板展示用量） */
export async function fetchAIUsage(limit = 20): Promise<{
  records: Record<string, unknown>[];
  totals: { calls: number; promptTokens: number; completionTokens: number; cost: number; todayCalls: number; todayCost: number };
}> {
  const resp = await fetch(`/api/ai/usage?limit=${limit}`, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

/** 供测试/预览注入：直接替换镜像（不写服务端） */
export function __setAIConfigForTest(config: AIConfig): void {
  mirror = config;
}
