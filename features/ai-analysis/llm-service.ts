/**
 * features/ai-analysis/llm-service — 浏览器侧 LLM 客户端
 *
 * 只跟本地 `/api/ai/*` 说话，不直连第三方（CORS / 密钥都在服务端解决）。
 * 这一层负责四件事：
 *   1. 把请求发给本地网关，支持非流式与 SSE（把"思考中"实时喂给 UI）；
 *   2. 结构化输出：解析 → 纠偏 → 校验 → 不合格就带着错误清单让模型重写（最多 3 轮）；
 *   3. 推理模型预算自动升级（DeepSeek v4.1 这类模型会把 max_tokens 全花在思维链上）；
 *   4. 每次调用写进 ai-runtime，UI 拿得到真实 token / 费用。
 */

import { describeSchema, parseLooseJSON, sanitizeBySchema, validateSchema } from '../../core/ai-json';
import type { JSONSchema } from '../../core/ai-json';
import { defaultAIRun } from './ai-runtime';
import type { AIRun } from './ai-runtime';
import type { AIToolCall, AIToolSpec, AIToolChoice } from '../../core/ai-tools';

export interface AIUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  cost?: number;
}

export interface AICallOptions {
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  jsonMode?: boolean;
  /** 用途标记，写进服务端用量日志 */
  purpose?: string;
  /** 走 SSE，把思考/正文片段推给 UI（仅单次调用型 Skill 建议开） */
  stream?: boolean;
  /**
   * 本次调用的用量/流式收集器。
   * 不传就落到默认实例（等价于旧行为）；需要隔离的场景（并行会话、后台任务）
   * 必须传自己的 createAIRun()，否则两边的 token 与思考片段会串在一起。
   */
  run?: AIRun;
  /** 本轮可用的工具（走工具调用时不要同时开 jsonMode，网关侧会互斥） */
  tools?: AIToolSpec[];
  toolChoice?: AIToolChoice;
}

export interface AIResult {
  text: string;
  reasoning: string;
  /** 模型请求的工具调用（有它时 text 通常是空的，这是正常的） */
  toolCalls?: AIToolCall[];
  usage: AIUsage;
  model: string;
  provider: string;
  finishReason: string;
  truncated: boolean;
  latencyMs: number;
  attempts: number;
}

export type AIErrorCode =
  | 'no_key'
  | 'no_config'
  | 'auth'
  | 'rate_limit'
  | 'http'
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'empty'
  | 'bad_format';

export class AIError extends Error {
  code: AIErrorCode;
  status?: number;
  detail?: string;
  constructor(code: AIErrorCode, message: string, extra?: { status?: number; detail?: string }) {
    super(message);
    this.name = 'AIError';
    this.code = code;
    this.status = extra?.status;
    this.detail = extra?.detail;
  }
}

export interface AIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** assistant 消息里的工具调用：回传时必须原样带上，否则模型会重复调用 */
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  /** role='tool' 时对应哪一次调用 */
  tool_call_id?: string;
}

const EMPTY_USAGE: AIUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, reasoningTokens: 0 };

function withTimeout(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

async function errorFromResponse(resp: Response): Promise<AIError> {
  const text = await resp.text().catch(() => '');
  let code: AIErrorCode = 'http';
  let message = `本地 AI 网关返回 HTTP ${resp.status}`;
  try {
    const json = JSON.parse(text);
    if (json?.error?.code) code = json.error.code as AIErrorCode;
    if (json?.error?.message) message = json.error.message;
    else if (typeof json?.error === 'string') message = json.error;
  } catch {
    if (text) message = text.slice(0, 300);
  }
  return new AIError(code, message, { status: resp.status, detail: text.slice(0, 500) });
}

/**
 * 网关返回的是 ChatResult（content/reasoning），浏览器侧用 text 更直观。
 * 统一在这里做一次形状转换，避免上层读到 undefined。
 */
function toAIResult(raw: any): AIResult {
  if (!raw || typeof raw !== 'object') {
    throw new AIError('http', '网关返回了空结果');
  }
  return {
    text: typeof raw.content === 'string' ? raw.content : (typeof raw.text === 'string' ? raw.text : ''),
    reasoning: typeof raw.reasoning === 'string' ? raw.reasoning : '',
    ...(Array.isArray(raw.toolCalls) && raw.toolCalls.length > 0
      ? {
          toolCalls: raw.toolCalls.map((tc: any) => ({
            id: String(tc?.id || ''),
            name: String(tc?.name || ''),
            arguments: typeof tc?.arguments === 'string' ? tc.arguments : '',
          })).filter((tc: AIToolCall) => tc.name),
        }
      : {}),
    usage: raw.usage || EMPTY_USAGE,
    model: String(raw.model || ''),
    provider: String(raw.provider || ''),
    finishReason: String(raw.finishReason || ''),
    truncated: Boolean(raw.truncated),
    latencyMs: Number(raw.latencyMs) || 0,
    attempts: Number(raw.attempts) || 1,
  };
}

/** 非流式调用 */
async function callOnce(messages: AIMessage[], opts: AICallOptions): Promise<AIResult> {
  const { signal, dispose } = withTimeout(opts.signal, 300000);
  try {
    const resp = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages,
        maxTokens: opts.maxTokens,
        temperature: opts.temperature,
        jsonMode: opts.jsonMode,
        purpose: opts.purpose,
        ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
        ...(opts.toolChoice ? { toolChoice: opts.toolChoice } : {}),
      }),
      signal,
    });
    if (!resp.ok) throw await errorFromResponse(resp);
    const json = await resp.json();
    if (!json?.ok || !json.result) {
      throw new AIError('http', json?.error?.message || '网关返回了空结果');
    }
    return toAIResult(json.result);
  } catch (e) {
    if (e instanceof AIError) throw e;
    if (opts.signal?.aborted) throw new AIError('aborted', '请求已取消');
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new AIError('timeout', '请求超时');
    }
    throw new AIError('network', e instanceof Error ? e.message : '网络错误');
  } finally {
    dispose();
  }
}

/** SSE 调用：把思考/正文片段实时推给 UI，结束后返回完整结果 */
async function callStream(messages: AIMessage[], opts: AICallOptions, run: AIRun): Promise<AIResult> {
  const { signal, dispose } = withTimeout(opts.signal, 300000);
  try {
    const resp = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages,
        maxTokens: opts.maxTokens,
        temperature: opts.temperature,
        jsonMode: opts.jsonMode,
        purpose: opts.purpose,
        stream: true,
        ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
        ...(opts.toolChoice ? { toolChoice: opts.toolChoice } : {}),
      }),
      signal,
    });
    if (!resp.ok) throw await errorFromResponse(resp);
    if (!resp.body) return await callOnce(messages, opts);
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let final: AIResult | null = null;
    let streamedError: string | null = null;

    const handleEvent = (raw: string) => {
      const line = raw.trim();
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload) return;
      let evt: any;
      try { evt = JSON.parse(payload); } catch { return; }
      if (evt.type === 'reasoning') run.emit('reasoning', String(evt.text || ''));
      else if (evt.type === 'delta') run.emit('text', String(evt.text || ''));
      else if (evt.type === 'done' && evt.result) final = toAIResult(evt.result);
      else if (evt.type === 'error') streamedError = String(evt.message || '流式调用失败');
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf('\n');
      while (idx >= 0) {
        handleEvent(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf('\n');
      }
    }
    if (buffer) handleEvent(buffer);

    if (final) return final;
    if (streamedError) throw new AIError('http', streamedError);
    // 流没给出收尾包（网关把 SSE 拆了）：退回非流式拿一次完整结果
    return await callOnce(messages, opts);
  } catch (e) {
    if (e instanceof AIError) throw e;
    if (opts.signal?.aborted) throw new AIError('aborted', '请求已取消');
    if (e instanceof DOMException && e.name === 'AbortError') throw new AIError('timeout', '请求超时');
    throw new AIError('network', e instanceof Error ? e.message : '网络错误');
  } finally {
    dispose();
  }
}

/**
 * 发一次对话请求。
 * stream=true 且浏览器支持流时走 SSE，否则自动退回非流式。
 */
export async function aiChat(messages: AIMessage[], opts: AICallOptions = {}): Promise<AIResult> {
  // 本次调用记到哪个篮子里：调用方指定就用它，否则落到默认实例（旧行为）
  const run = opts.run ?? defaultAIRun;
  const result = opts.stream && typeof TextDecoder !== 'undefined'
    ? await callStream(messages, opts, run)
    : await callOnce(messages, opts);

  run.record({
    provider: result.provider,
    model: result.model,
    usage: result.usage || EMPTY_USAGE,
    latencyMs: result.latencyMs || 0,
    attempts: result.attempts || 1,
    purpose: opts.purpose,
    truncated: result.truncated,
  });
  return result;
}

export interface AIJSONOptions extends AICallOptions {
  schema: JSONSchema;
  system: string;
  user: string;
  /** 额外约束（追加在"输出格式"之后） */
  rules?: string;
  /** 最大重写轮数，默认 3 */
  maxRounds?: number;
}

export interface AIJSONResult<T> {
  data: T;
  raw: string;
  usage: AIUsage;
  rounds: number;
  latencyMs: number;
  /** 最后是否靠重写才拿到合格结果 */
  repaired: boolean;
}

function mergeUsage(a: AIUsage, b: AIUsage): AIUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    cost: typeof a.cost === 'number' || typeof b.cost === 'number'
      ? (a.cost || 0) + (b.cost || 0)
      : undefined,
  };
}

/**
 * 请求一个符合 schema 的 JSON 结果。
 * 解析失败 / 校验不过时，把错误回传给模型让它自己改，最多 3 轮；
 * 推理模型把预算烧在思维链上（finish_reason=length 且正文为空）时，自动翻倍预算。
 */
export async function aiJSON<T>(opts: AIJSONOptions): Promise<AIJSONResult<T>> {
  const { schema, system, user } = opts;
  const maxRounds = Math.max(1, Math.min(4, opts.maxRounds ?? 3));

  const systemPrompt = [
    system,
    '',
    '【输出格式】只输出一个 JSON 对象，不要输出解释、前后缀或 Markdown 代码块。字段如下：',
    describeSchema(schema),
    opts.rules ? `\n【额外要求】${opts.rules}` : '',
  ].join('\n');

  const messages: AIMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: user },
  ];

  let maxTokens = opts.maxTokens ?? 3000;
  let usage = EMPTY_USAGE;
  let latency = 0;
  let rounds = 0;
  let escalations = 0;
  let lastError = '';
  let lastRaw = '';

  let round = 1;
  while (round <= maxRounds) {
    rounds = round;
    const result = await aiChat(messages, {
      ...opts,
      maxTokens,
      jsonMode: true,
      // 只有第一轮展示流式（重写轮次很短，刷屏没意义）
      stream: opts.stream && round === 1,
    });
    usage = mergeUsage(usage, result.usage || EMPTY_USAGE);
    latency += result.latencyMs || 0;
    lastRaw = result.text;

    // 推理模型把预算烧完 → 加倍预算重来（不消耗重写轮次，最多升级 3 次）
    if (!result.text.trim() && result.truncated && escalations < 3) {
      escalations += 1;
      maxTokens = Math.min(16000, maxTokens * 2);
      continue;
    }

    const parsed = parseLooseJSON(result.text);
    if (!parsed.ok) {
      lastError = parsed.error;
      messages.push({ role: 'assistant', content: result.text.slice(0, 1500) });
      messages.push({
        role: 'user',
        content: `上面的输出不是合法 JSON（${parsed.error}）。请只输出修正后的 JSON 对象，不要任何解释。`,
      });
      round += 1;
      continue;
    }

    const cleaned = sanitizeBySchema(parsed.value, schema);
    const errors = validateSchema(cleaned, schema);
    if (errors.length === 0) {
      return { data: cleaned as T, raw: result.text, usage, rounds, latencyMs: latency, repaired: round > 1 };
    }

    lastError = errors.join('；');
    messages.push({ role: 'assistant', content: result.text.slice(0, 1500) });
    messages.push({
      role: 'user',
      content: `输出的 JSON 有以下问题：${errors.slice(0, 6).join('；')}。请修正后只输出完整 JSON，不要解释。`,
    });
    round += 1;
  }

  throw new AIError(
    'bad_format',
    `AI 连续 ${rounds} 轮没有给出符合要求的结构：${lastError}`,
    { detail: lastRaw.slice(0, 500) },
  );
}

/** 兼容旧调用点：直接拿纯文本（不带结构约束） */
export async function chat(systemPrompt: string, userPrompt: string, opts: AICallOptions = {}): Promise<string> {
  const result = await aiChat(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    { ...opts, jsonMode: false },
  );
  return result.text;
}
