/**
 * server/ai-gateway — 本地 LLM 网关（唯一出网口）
 *
 * 为什么 AI 调用必须放在服务端：
 *   1. 浏览器直连第三方 API 会撞 CORS。实测 `opencode.ai/zen/go` 的
 *      OPTIONS 预检直接 404（DeepSeek 官方则允许），也就是说 **OpenCode 的
 *      deepseek-v4.1-flash 在浏览器里根本调不通**，只能由本地服务代发；
 *   2. 网关会强制要求 `x-opencode-session` 头，否则 400 MissingSessionID；
 *   3. API Key 不该躺在 localStorage 里被任意脚本读走，落盘更好管理；
 *   4. 超时/重试/退避/用量记账只做一次，不必每个 Skill 各写一遍。
 *
 * 本文件不做 prompt 逻辑，只负责「发请求 → 归一化响应」。
 */
import fs from 'fs';
import path from 'path';
import type { FetchLike } from './media-sources';

// ─────────────────────────────────────────────────────────────
// Provider 预设
// ─────────────────────────────────────────────────────────────

import type { AIPermission } from '../core/ai-permission';
import { normalizeAIPermission } from '../core/ai-permission';

export interface AIProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  /** 必须注入的额外请求头（如 OpenCode 的会话标识） */
  headers?: Record<string, string>;
  /** 建议模型（/models 拉不到时用它兜底） */
  models: string[];
  /** 是否需要 API Key */
  needsKey: boolean;
  /** 是否支持 `thinking: {type:'disabled'}` 关闭推理 */
  thinkingParam?: boolean;
  hint?: string;
}

export const AI_PROVIDERS: AIProviderPreset[] = [
  {
    id: 'opencode-go',
    label: 'OpenCode Go',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    headers: { 'x-opencode-session': 'animediary' },
    models: [
      'deepseek-v4.1-flash',
      'deepseek-v4-pro',
      'glm-5.3',
      'kimi-k3',
      'qwen3.8-max',
      'minimax-m3',
    ],
    needsKey: true,
    thinkingParam: true,
    hint: '订阅制网关，浏览器直连会被 CORS 拦下，只能走本地代理',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    needsKey: true,
    hint: '按 token 计费，中文写作质量稳定',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o'],
    needsKey: true,
  },
  {
    id: 'ollama',
    label: 'Ollama（本地）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    models: ['qwen2.5:14b', 'llama3.1:8b'],
    needsKey: false,
    hint: '本地模型无需 Key，速度取决于显卡',
  },
  {
    id: 'custom',
    label: '自定义（OpenAI 兼容）',
    baseUrl: '',
    models: [],
    needsKey: true,
    hint: '任何兼容 /chat/completions 的中转站',
  },
];

export function getProvider(id: string): AIProviderPreset {
  return AI_PROVIDERS.find((p) => p.id === id) || AI_PROVIDERS[AI_PROVIDERS.length - 1];
}

// ─────────────────────────────────────────────────────────────
// 配置（落盘 {DATA_DIR}/ai-config.json，不进 git）
// ─────────────────────────────────────────────────────────────

export interface AIStoredConfig {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  /** 额外请求头（自定义中转站可能需要） */
  headers: Record<string, string>;
  temperature: number;
  /** 单次输出预算（含推理 token） */
  maxTokens: number;
  timeoutMs: number;
  /** 是否请求 response_format=json_object */
  jsonMode: boolean;
  /** auto = 让模型自己决定是否思考；off = 显式关掉 */
  thinking: 'auto' | 'off';
  /** UI 的深度模式开关（Bangumi 评论挖掘），存在这里一并管理 */
  deepMode: boolean;
  /**
   * AI 写操作权限：read 只读 / confirm 提议后确认 / write 直接写入。
   * 存在服务端而不是 localStorage —— 它是安全边界，不该被页面脚本随手改。
   */
  permission: AIPermission;
}

const CONFIG_FILE = 'ai-config.json';

function presetDefaults(providerId: string): Pick<AIStoredConfig, 'baseUrl' | 'model'> {
  const preset = getProvider(providerId);
  return { baseUrl: preset.baseUrl, model: preset.models[0] || '' };
}

export function loadStoredConfig(dataDir: string): AIStoredConfig {
  let saved: Partial<AIStoredConfig> = {};
  try {
    const file = path.join(dataDir, CONFIG_FILE);
    if (fs.existsSync(file)) {
      saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
    }
  } catch { /* 损坏就回落到默认值 */ }

  const provider = process.env.ANIMEDIARY_AI_PROVIDER || saved.provider || 'deepseek';
  const defaults = presetDefaults(provider);

  return {
    provider,
    baseUrl: process.env.ANIMEDIARY_AI_BASE_URL || saved.baseUrl || defaults.baseUrl,
    model: process.env.ANIMEDIARY_AI_MODEL || saved.model || defaults.model,
    apiKey: process.env.ANIMEDIARY_AI_API_KEY || saved.apiKey || '',
    headers: saved.headers && typeof saved.headers === 'object' ? saved.headers : {},
    temperature: typeof saved.temperature === 'number' ? saved.temperature : 0.4,
    maxTokens: typeof saved.maxTokens === 'number' ? saved.maxTokens : 3000,
    timeoutMs: typeof saved.timeoutMs === 'number' ? saved.timeoutMs : 120000,
    jsonMode: saved.jsonMode !== false,
    thinking: saved.thinking === 'off' ? 'off' : 'auto',
    deepMode: saved.deepMode === true,
    permission: normalizeAIPermission(saved.permission),
  };
}

export function saveStoredConfig(dataDir: string, patch: Partial<AIStoredConfig>): AIStoredConfig {
  const current = loadStoredConfig(dataDir);
  const merged: AIStoredConfig = { ...current, ...patch };

  // 切 provider 且没显式给 baseUrl/model 时，跟着预设走
  if (patch.provider && patch.provider !== current.provider) {
    const preset = getProvider(patch.provider);
    if (!patch.baseUrl) merged.baseUrl = preset.baseUrl;
    if (!patch.model) merged.model = preset.models[0] || '';
  }
  merged.baseUrl = String(merged.baseUrl || '').replace(/\/+$/, '');
  merged.maxTokens = Math.max(256, Math.min(32000, Math.round(merged.maxTokens) || 3000));
  merged.timeoutMs = Math.max(5000, Math.min(600000, Math.round(merged.timeoutMs) || 120000));
  merged.temperature = Math.max(0, Math.min(2, Number(merged.temperature) || 0));
  if (merged.thinking !== 'off') merged.thinking = 'auto';
  merged.permission = normalizeAIPermission(merged.permission);

  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, CONFIG_FILE), JSON.stringify(merged, null, 2), 'utf-8');
  } catch (e) {
    console.warn('[ai] 配置写入失败:', e instanceof Error ? e.message : e);
  }
  return merged;
}

/** 对外暴露的配置（抹掉 key，只告诉前端"有没有"） */
export interface AIPublicConfig {
  provider: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  jsonMode: boolean;
  thinking: 'auto' | 'off';
  deepMode: boolean;
  /** AI 写操作权限（read / confirm / write） */
  permission: AIPermission;
  hasKey: boolean;
  keyMask: string;
  providers: AIProviderPreset[];
}

export function toPublicConfig(cfg: AIStoredConfig): AIPublicConfig {
  const preset = getProvider(cfg.provider);
  return {
    provider: cfg.provider,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
    timeoutMs: cfg.timeoutMs,
    jsonMode: cfg.jsonMode,
    thinking: cfg.thinking,
    deepMode: cfg.deepMode,
    permission: cfg.permission,
    hasKey: cfg.apiKey.length > 0 || !preset.needsKey,
    keyMask: cfg.apiKey.length > 4
      ? `${cfg.apiKey.slice(0, 3)}…${cfg.apiKey.slice(-4)}`
      : (cfg.apiKey ? '已设置' : ''),
    providers: AI_PROVIDERS,
  };
}

// ─────────────────────────────────────────────────────────────
// 请求 / 响应
// ─────────────────────────────────────────────────────────────

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * 一条工具调用（模型发起的）。
 * arguments 保留**原始 JSON 字符串**，不在这里解析 ——
 * 模型给的东西一律当不可信输入，解析与校验交给调用方（浏览器侧）。
 * 类型定义在 core/ai-tools.ts，与浏览器共用同一套形状。
 */
export type { AIToolCall, AIToolSpec, AIToolChoice } from '../core/ai-tools';
import type { AIToolCall, AIToolSpec, AIToolChoice } from '../core/ai-tools';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** assistant 消息里的工具调用：回传给模型时必须原样带上，否则它会重复调用 */
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  /** role='tool' 时说明这是对哪一次调用的结果 */
  tool_call_id?: string;
}

export interface AIUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 推理 token（DeepSeek 方言的 completion_tokens_details.reasoning_tokens） */
  reasoningTokens: number;
  /** 网关直接给出费用时（OpenCode 会返回 usage.cost） */
  cost?: number;
}

export interface ChatRequest {
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
  stream?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** 用于用量记账，例如 "taste" / "recommend" */
  purpose?: string;
  /** 可用的工具；有工具时不会再请求 response_format=json_object（两者互斥） */
  tools?: AIToolSpec[];
  toolChoice?: AIToolChoice;
}

export interface ChatResult {
  content: string;
  /** 思维链（有些模型放在 reasoning_content） */
  reasoning: string;
  finishReason: string;
  /** 因 max_tokens 被截断 —— 上层应加大预算重试 */
  truncated: boolean;
  /**
   * 模型请求的工具调用。
   * 有工具调用时 content 通常是空的 —— 这是正常情况，不能当成「模型没说话」报错。
   */
  toolCalls?: AIToolCall[];
  usage: AIUsage;
  model: string;
  provider: string;
  latencyMs: number;
  attempts: number;
}

export interface StreamEvent {
  type: 'reasoning' | 'delta' | 'done';
  text?: string;
  result?: ChatResult;
}

export type AIErrorCode =
  | 'no_config'
  | 'no_key'
  | 'auth'
  | 'rate_limit'
  | 'http'
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'empty'
  | 'bad_response';

export class AIGatewayError extends Error {
  code: AIErrorCode;
  status?: number;
  body?: string;
  constructor(code: AIErrorCode, message: string, extra?: { status?: number; body?: string }) {
    super(message);
    this.name = 'AIGatewayError';
    this.code = code;
    this.status = extra?.status;
    this.body = extra?.body;
  }
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new AIGatewayError('aborted', '请求已取消')); return; }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AIGatewayError('aborted', '请求已取消'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function normalizeUsage(raw: any): AIUsage {
  const u = raw || {};
  const prompt = Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0;
  const completion = Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0;
  const total = Number(u.total_tokens ?? 0) || prompt + completion;
  const reasoning = Number(
    u.completion_tokens_details?.reasoning_tokens
    ?? u.output_tokens_details?.reasoning_tokens
    ?? u.reasoning_tokens
    ?? 0,
  ) || 0;
  const cost = typeof u.cost === 'number' ? u.cost : undefined;
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total, reasoningTokens: reasoning, cost };
}

/**
 * 把网关返回的 tool_calls 归一化。
 * arguments 一律转成**字符串**交出去（有的网关给对象而不是 JSON 字符串），
 * 解析放在调用方 —— 服务端不替模型「修好」它的参数。
 */
function normalizeToolCalls(raw: any): AIToolCall[] {
  if (!Array.isArray(raw)) return [];
  const out: AIToolCall[] = [];
  for (const tc of raw) {
    const name = String(tc?.function?.name || '').trim();
    if (!name) continue; // 没有函数名的调用没法执行，直接丢掉
    const rawArgs = tc?.function?.arguments;
    const args = typeof rawArgs === 'string'
      ? rawArgs
      : (rawArgs == null ? '' : JSON.stringify(rawArgs));
    out.push({ id: String(tc?.id || ''), name, arguments: args });
  }
  return out;
}

function describeHttpError(status: number, bodyText: string): { code: AIErrorCode; message: string } {  let detail = '';
  try {
    const j = JSON.parse(bodyText);
    detail = j?.error?.message || j?.message || j?.error?.type || '';
  } catch {
    detail = bodyText.slice(0, 300);
  }
  if (status === 401 || status === 403) {
    return { code: 'auth', message: `鉴权失败（${status}）${detail ? `：${detail}` : ''}` };
  }
  if (status === 404) {
    return { code: 'http', message: `接口不存在（404），请检查 Base URL 是否要带 /v1` };
  }
  if (status === 429) {
    return { code: 'rate_limit', message: `请求被限流（429）${detail ? `：${detail}` : ''}` };
  }
  return { code: 'http', message: `HTTP ${status}${detail ? `：${detail}` : ''}` };
}

export interface AIClientOptions {
  DATA_DIR: string;
  fetchImpl?: FetchLike;
}

export interface AIClient {
  loadConfig(): AIStoredConfig;
  publicConfig(): AIPublicConfig;
  saveConfig(patch: Partial<AIStoredConfig>): AIStoredConfig;
  listModels(): Promise<{ models: string[]; source: 'remote' | 'preset'; error?: string }>;
  chat(req: ChatRequest): Promise<ChatResult>;
  chatStream(req: ChatRequest, onEvent: (e: StreamEvent) => void): Promise<ChatResult>;
  test(): Promise<{
    ok: boolean;
    latencyMs: number;
    model: string;
    provider: string;
    usage?: AIUsage;
    sample?: string;
    error?: string;
    errorCode?: AIErrorCode;
  }>;
  recordUsage(entry: Record<string, unknown>): void;
  recentUsage(limit?: number): Record<string, unknown>[];
}

export function createAIClient({ DATA_DIR, fetchImpl }: AIClientOptions): AIClient {
  const doFetch: FetchLike = fetchImpl || ((url, init) => fetch(url, init as RequestInit));

  const usageFile = path.join(DATA_DIR, 'ai-usage.jsonl');

  function buildHeaders(cfg: AIStoredConfig): Record<string, string> {
    const preset = getProvider(cfg.provider);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'AnimeDiary/1.0 (local)',
      ...(preset.headers || {}),
      ...(cfg.headers || {}),
    };
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
    return headers;
  }

  function buildBody(cfg: AIStoredConfig, req: ChatRequest, opts: { dropJsonMode: boolean; stream: boolean }): Record<string, unknown> {
    const maxTokens = Math.max(64, Math.round(req.maxTokens ?? cfg.maxTokens));
    const body: Record<string, unknown> = {
      model: cfg.model,
      messages: req.messages,
      max_tokens: maxTokens,
      temperature: req.temperature ?? cfg.temperature,
    };
    const preset = getProvider(cfg.provider);
    if (preset.thinkingParam && cfg.thinking === 'off') {
      body.thinking = { type: 'disabled' };
    }
    const wantJson = req.jsonMode ?? cfg.jsonMode;
    if (req.tools && req.tools.length > 0) {
      // tools 与 response_format=json_object 互斥：同时带上多数网关直接 400，
      // 而且语义上也没必要 —— 走工具调用的对话不该再要求整块 JSON 输出
      body.tools = req.tools;
      body.tool_choice = req.toolChoice ?? 'auto';
    } else if (wantJson && !opts.dropJsonMode) {
      body.response_format = { type: 'json_object' };
    }
    if (opts.stream) {
      body.stream = true;
      body.stream_options = { include_usage: true };
    }
    return body;
  }

  async function requestOnce(
    cfg: AIStoredConfig,
    body: Record<string, unknown>,
    req: ChatRequest,
    timeoutMs: number,
    attempt: number,
  ): Promise<ChatResult> {
    const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    req.signal?.addEventListener('abort', onAbort, { once: true });

    const started = Date.now();
    try {
      const resp = await doFetch(url, {
        method: 'POST',
        headers: buildHeaders(cfg),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const latencyMs = Date.now() - started;

      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        const { code, message } = describeHttpError(resp.status, text);
        throw new AIGatewayError(code, message, { status: resp.status, body: text });
      }

      const json: any = await resp.json();
      const choice = json?.choices?.[0];
      const message = choice?.message || {};
      const content = typeof message.content === 'string' ? message.content : '';
      const reasoning = typeof message.reasoning_content === 'string'
        ? message.reasoning_content
        : (typeof message.reasoning === 'string' ? message.reasoning : '');
      const finishReason = String(choice?.finish_reason || '');
      const toolCalls = normalizeToolCalls(message.tool_calls);

      // 注意：带工具调用的回复 content 通常是空的，这是正常的 ——
      // 不能当成「模型没说话」去报 empty 错，否则第一条工具请求就永远过不去
      if (!content.trim() && toolCalls.length === 0) {
        if (finishReason === 'length') {
          // 推理模型把预算全花在思维链上：把空内容 + truncated 交回上层加预算
          return {
            content: '', reasoning, finishReason, truncated: true,
            usage: normalizeUsage(json?.usage), model: String(json?.model || cfg.model),
            provider: cfg.provider, latencyMs, attempts: attempt,
          };
        }
        throw new AIGatewayError('empty', '模型返回了空内容');
      }

      return {
        content,
        reasoning,
        finishReason,
        truncated: finishReason === 'length',
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        usage: normalizeUsage(json?.usage),
        model: String(json?.model || cfg.model),
        provider: cfg.provider,
        latencyMs,
        attempts: attempt,
      };
    } catch (e: unknown) {
      if (e instanceof AIGatewayError) throw e;
      if (req.signal?.aborted) throw new AIGatewayError('aborted', '请求已取消');
      if (controller.signal.aborted) {
        throw new AIGatewayError('timeout', `请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
      }
      const msg = e instanceof Error ? e.message : String(e);
      throw new AIGatewayError('network', `无法连接 ${cfg.baseUrl}：${msg}`);
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
    }
  }

  async function chat(req: ChatRequest): Promise<ChatResult> {
    const cfg = loadStoredConfig(DATA_DIR);
    if (!cfg.baseUrl) throw new AIGatewayError('no_config', '尚未配置 API 地址');
    const preset = getProvider(cfg.provider);
    if (preset.needsKey && !cfg.apiKey) {
      throw new AIGatewayError('no_key', '尚未配置 API Key');
    }

    const timeoutMs = req.timeoutMs ?? cfg.timeoutMs;
    let dropJsonMode = false;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      const body = buildBody(cfg, req, { dropJsonMode, stream: false });
      try {
        const result = await requestOnce(cfg, body, req, timeoutMs, attempt);
        recordUsage({
          ts: new Date().toISOString(),
          provider: cfg.provider,
          model: result.model,
          purpose: req.purpose || '',
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          reasoningTokens: result.usage.reasoningTokens,
          cost: result.usage.cost ?? null,
          latencyMs: result.latencyMs,
          truncated: result.truncated,
        });
        return result;
      } catch (e) {
        lastError = e;
        if (e instanceof AIGatewayError) {
          // 有的网关不认 response_format，去掉再试一次
          if (e.status === 400 && /response_format|json_object/i.test(e.body || '')) {
            dropJsonMode = true;
            continue;
          }
          if (e.code === 'aborted') throw e;
          if (e.status && !RETRYABLE_STATUS.has(e.status)) throw e;
          if (e.code === 'empty' || e.code === 'no_key' || e.code === 'no_config') throw e;
        }
        if (attempt < 3) await sleep(800 * 2 ** (attempt - 1), req.signal);
      }
    }
    throw lastError instanceof Error ? lastError : new AIGatewayError('http', '请求失败');
  }

  async function chatStream(req: ChatRequest, onEvent: (e: StreamEvent) => void): Promise<ChatResult> {
    const cfg = loadStoredConfig(DATA_DIR);
    if (!cfg.baseUrl) throw new AIGatewayError('no_config', '尚未配置 API 地址');
    const preset = getProvider(cfg.provider);
    if (preset.needsKey && !cfg.apiKey) throw new AIGatewayError('no_key', '尚未配置 API Key');

    const timeoutMs = req.timeoutMs ?? cfg.timeoutMs;
    const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    req.signal?.addEventListener('abort', onAbort, { once: true });

    const started = Date.now();
    let content = '';
    let reasoning = '';
    let finishReason = '';
    let usage: AIUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, reasoningTokens: 0 };
    /**
     * 流式下 tool_calls 是**增量**到达的：按 index 分槽，id 只在首块给，
     * arguments 是一段段拼起来的 JSON 文本。不放这里累积的话，
     * 拿到的永远是半截 JSON（这是工具调用最容易踩的坑）。
     */
    const toolCallSlots = new Map<number, { id: string; name: string; arguments: string }>();

    try {
      const openStream = async (withUsageOption: boolean) => {
        const body = buildBody(cfg, req, { dropJsonMode: false, stream: true });
        if (!withUsageOption) delete body.stream_options;
        return doFetch(url, {
          method: 'POST',
          headers: buildHeaders(cfg),
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      };

      let resp = await openStream(true);
      if (!resp.ok && resp.status === 400) {
        // 有的网关不认 stream_options，去掉再试一次
        const peek = await resp.text().catch(() => '');
        if (/stream_options/i.test(peek)) resp = await openStream(false);
        else {
          const { code, message } = describeHttpError(400, peek);
          throw new AIGatewayError(code, message, { status: 400, body: peek });
        }
      }
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        const { code, message } = describeHttpError(resp.status, text);
        throw new AIGatewayError(code, message, { status: resp.status, body: text });
      }

      const rawBody = (resp as unknown as { body?: ReadableStream<Uint8Array> }).body;
      if (!rawBody) {
        // 出口不支持流（或网关把 SSE 缓冲了）：退回非流式
        const fallback = await chat({ ...req, stream: false });
        if (fallback.content) onEvent({ type: 'delta', text: fallback.content });
        onEvent({ type: 'done', result: fallback });
        return fallback;
      }

      const reader = rawBody.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const handleLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) return;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') return;
        let chunk: any;
        try { chunk = JSON.parse(payload); } catch { return; }
        if (chunk?.usage) usage = normalizeUsage(chunk.usage);
        const choice = chunk?.choices?.[0];
        if (!choice) return;
        const delta = choice.delta || {};
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
          reasoning += delta.reasoning_content;
          onEvent({ type: 'reasoning', text: delta.reasoning_content });
        }
        if (typeof delta.content === 'string' && delta.content) {
          content += delta.content;
          onEvent({ type: 'delta', text: delta.content });
        }
        // 工具调用增量：按 index 拼，id 与 name 只认第一次出现的值
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = typeof tc?.index === 'number' ? tc.index : 0;
            const slot = toolCallSlots.get(idx) || { id: '', name: '', arguments: '' };
            if (typeof tc?.id === 'string' && tc.id && !slot.id) slot.id = tc.id;
            // name 不拼接：它只在首块出现一次，拼了会得到 "get_weatherget_weather"
            if (typeof tc?.function?.name === 'string' && tc.function.name && !slot.name) {
              slot.name = tc.function.name;
            }
            if (typeof tc?.function?.arguments === 'string' && tc.function.arguments) {
              slot.arguments += tc.function.arguments;
            }
            toolCallSlots.set(idx, slot);
          }
        }
        if (choice.finish_reason) finishReason = String(choice.finish_reason);
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx = buffer.indexOf('\n');
        while (idx >= 0) {
          handleLine(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 1);
          idx = buffer.indexOf('\n');
        }
      }
      if (buffer) handleLine(buffer);

      const streamedToolCalls: AIToolCall[] = [...toolCallSlots.entries()]
        // index 决定顺序：模型可以并行请求多个工具，顺序不能靠 Map 的插入序
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => v)
        .filter((v) => v.name)
        .map((v) => ({ id: v.id, name: v.name, arguments: v.arguments }));

      const result: ChatResult = {
        content,
        reasoning,
        finishReason,
        truncated: finishReason === 'length',
        ...(streamedToolCalls.length > 0 ? { toolCalls: streamedToolCalls } : {}),
        usage,
        model: cfg.model,
        provider: cfg.provider,
        latencyMs: Date.now() - started,
        attempts: 1,
      };
      recordUsage({
        ts: new Date().toISOString(),
        provider: cfg.provider,
        model: cfg.model,
        purpose: req.purpose || '',
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        reasoningTokens: usage.reasoningTokens,
        cost: usage.cost ?? null,
        latencyMs: result.latencyMs,
        truncated: result.truncated,
        stream: true,
      });
      onEvent({ type: 'done', result });
      return result;
    } catch (e: unknown) {
      if (e instanceof AIGatewayError) throw e;
      if (req.signal?.aborted) throw new AIGatewayError('aborted', '请求已取消');
      if (controller.signal.aborted) {
        throw new AIGatewayError('timeout', `请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
      }
      throw new AIGatewayError('network', e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
    }
  }

  async function listModels(): Promise<{ models: string[]; source: 'remote' | 'preset'; error?: string }> {
    const cfg = loadStoredConfig(DATA_DIR);
    const preset = getProvider(cfg.provider);
    if (!cfg.baseUrl) return { models: preset.models, source: 'preset', error: '尚未配置 API 地址' };
    try {
      const resp = await doFetch(`${cfg.baseUrl.replace(/\/+$/, '')}/models`, {
        method: 'GET',
        headers: buildHeaders(cfg),
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) {
        return { models: preset.models, source: 'preset', error: `HTTP ${resp.status}` };
      }
      const json: any = await resp.json();
      const list = Array.isArray(json?.data) ? json.data : [];
      const models = list
        .map((m: any) => String(m?.id || ''))
        .filter(Boolean)
        .sort();
      if (models.length === 0) return { models: preset.models, source: 'preset', error: '模型列表为空' };
      return { models, source: 'remote' };
    } catch (e) {
      return {
        models: preset.models,
        source: 'preset',
        error: e instanceof Error ? e.message : '获取模型列表失败',
      };
    }
  }

  async function test() {
    const cfg = loadStoredConfig(DATA_DIR);
    const started = Date.now();
    try {
      const result = await chat({
        messages: [
          { role: 'system', content: '你是一个 JSON 接口。只输出 JSON，不要任何解释或代码块。' },
          { role: 'user', content: '请输出：{"ok":true,"msg":"连接成功"}' },
        ],
        maxTokens: 800,
        temperature: 0,
        jsonMode: true,
        purpose: 'test',
        timeoutMs: Math.min(cfg.timeoutMs, 90000),
      });
      return {
        ok: result.content.trim().length > 0,
        latencyMs: Date.now() - started,
        model: result.model,
        provider: result.provider,
        usage: result.usage,
        sample: result.content.slice(0, 200),
      };
    } catch (e) {
      const err = e instanceof AIGatewayError ? e : null;
      return {
        ok: false,
        latencyMs: Date.now() - started,
        model: cfg.model,
        provider: cfg.provider,
        error: e instanceof Error ? e.message : String(e),
        errorCode: err?.code,
      };
    }
  }

  function recordUsage(entry: Record<string, unknown>): void {
    try {
      fs.appendFileSync(usageFile, JSON.stringify(entry) + '\n', 'utf-8');
    } catch { /* 记账失败不影响主流程 */ }
  }

  function recentUsage(limit = 50): Record<string, unknown>[] {
    try {
      if (!fs.existsSync(usageFile)) return [];
      const lines = fs.readFileSync(usageFile, 'utf-8').trim().split('\n');
      return lines.slice(-limit).map((l) => {
        try { return JSON.parse(l); } catch { return {}; }
      }).filter((o) => Object.keys(o).length > 0).reverse();
    } catch { return []; }
  }

  return {
    loadConfig: () => loadStoredConfig(DATA_DIR),
    publicConfig: () => toPublicConfig(loadStoredConfig(DATA_DIR)),
    saveConfig: (patch) => saveStoredConfig(DATA_DIR, patch),
    listModels,
    chat,
    chatStream,
    test,
    recordUsage,
    recentUsage,
  };
}
