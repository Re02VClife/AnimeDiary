/**
 * LLM 调用服务 — 统一的 OpenAI 兼容协议封装
 *
 * 注意：不使用 response_format（部分 provider 不支持），
 * 改为在 system prompt 中要求 JSON 输出。
 * 也不使用 SSE 流式——经过多轮尝试在用户环境中不稳定（中文 UTF-8 乱码）。
 */

import { loadAIConfig } from './ai-config';

export interface LLMCallOptions {
  maxTokens?: number;
  temperature?: number;
  timeout?: number;
  /** AbortSignal 用于取消请求 */
  signal?: AbortSignal;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LLMError {
  type: 'no_config' | 'timeout' | 'http_error' | 'parse_error' | 'aborted';
  message: string;
  status?: number;
}

function isLLMError(e: unknown): e is LLMError {
  return e instanceof Error && 'type' in e &&
    ['no_config', 'timeout', 'http_error', 'parse_error', 'aborted']
      .includes((e as LLMError).type);
}

/**
 * 调用 LLM（非流式），自动拼接 /chat/completions
 */
export async function chat(
  systemPrompt: string,
  userPrompt: string,
  options?: LLMCallOptions,
): Promise<string> {
  const config = loadAIConfig();

  if (!config.apiKey) {
    throw Object.assign(new Error('请先在 AI 设置中配置 API Key'), {
      type: 'no_config',
    } as LLMError);
  }

  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const timeout = options?.timeout ?? 30000;

  const body: Record<string, unknown> = {
    model: config.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: options?.maxTokens ?? 1000,
    temperature: options?.temperature ?? 0.3,
    frequency_penalty: 0.5,
    presence_penalty: 0.3,
    top_p: 0.9,
  };

  // 合并用户提供的 signal 和超时 signal
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), timeout);
  if (options?.signal) {
    options.signal.addEventListener('abort', () => abortController.abort());
  }

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: abortController.signal,
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      let errMsg = `HTTP ${resp.status}`;
      if (resp.status === 401) errMsg = 'API Key 无效（401 Unauthorized）';
      else if (resp.status === 403) errMsg = '访问被拒绝，请检查 API Key 权限';
      else if (resp.status === 404) errMsg = '接口不存在（404），请检查 Base URL';
      else if (resp.status === 429) errMsg = '请求过于频繁，请稍后重试';
      else if (errText) {
        try {
          const j = JSON.parse(errText);
          errMsg = j.error?.message || j.message || errMsg;
        } catch { /* raw text */ }
      }
      throw Object.assign(new Error(errMsg), {
        type: 'http_error',
        status: resp.status,
      } as LLMError & { status: number });
    }

    const json = await resp.json();
    const content = json?.choices?.[0]?.message?.content;
    if (!content) {
      throw Object.assign(new Error('LLM 返回内容为空'), {
        type: 'parse_error',
      } as LLMError);
    }
    return content;
  } catch (e: unknown) {
    if (isLLMError(e)) throw e;

    if (abortController.signal.aborted && !options?.signal?.aborted) {
      throw Object.assign(new Error(`请求超时（${timeout / 1000} 秒）`), {
        type: 'timeout',
      } as LLMError);
    }
    if (options?.signal?.aborted || (e instanceof DOMException && e.name === 'AbortError')) {
      throw Object.assign(new Error('请求已取消'), { type: 'aborted' } as LLMError);
    }
    if (e instanceof TypeError && e.message.includes('fetch')) {
      throw Object.assign(new Error(`无法连接到 ${config.baseUrl}，请检查网络或 Base URL`), {
        type: 'http_error',
      } as LLMError);
    }
    throw Object.assign(new Error(e instanceof Error ? e.message : '未知错误'), {
      type: 'http_error',
    } as LLMError);
  } finally {
    clearTimeout(timeoutId);
  }
}
