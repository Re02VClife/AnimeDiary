/**
 * server/ai-gateway 单测 —— 用假 fetch 验证「请求长什么样」和「失败怎么退」
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createAIClient, AIGatewayError } from '../../server/ai-gateway';

interface FakeResponseInit {
  status?: number;
  body?: unknown;
  text?: string;
}

function fakeResponse({ status = 200, body = {}, text }: FakeResponseInit) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    async json() { return body; },
    async text() { return text ?? JSON.stringify(body); },
    async arrayBuffer() { return new ArrayBuffer(0); },
  };
}

function chatOk(content: string, extra: Record<string, unknown> = {}) {
  return {
    model: 'deepseek-v4.1-flash',
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, completion_tokens_details: { reasoning_tokens: 5 } },
    ...extra,
  };
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gateway-test-'));
});

afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeClient(handler: (url: string, init: any) => any) {
  const client = createAIClient({
    DATA_DIR: dir,
    fetchImpl: async (url, init) => handler(String(url), init),
  });
  client.saveConfig({
    provider: 'opencode-go',
    baseUrl: 'https://gw.test/v1',
    model: 'deepseek-v4.1-flash',
    apiKey: 'test-key',
    maxTokens: 1000,
  });
  return client;
}

describe('createAIClient', () => {
  it('注入 OpenCode 需要的会话头和 Authorization', async () => {
    let captured: any = null;
    const client = makeClient((_url, init) => {
      captured = init;
      return fakeResponse({ body: chatOk('{"ok":true}') });
    });

    await client.chat({ messages: [{ role: 'user', content: 'hi' }] });

    expect(captured.headers['x-opencode-session']).toBe('animediary');
    expect(captured.headers.Authorization).toBe('Bearer test-key');
    const body = JSON.parse(captured.body);
    expect(body.model).toBe('deepseek-v4.1-flash');
    expect(body.max_tokens).toBe(1000);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('归一化 usage 里的推理 token', async () => {
    const client = makeClient(() => fakeResponse({ body: chatOk('{"ok":true}') }));
    const result = await client.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.usage.reasoningTokens).toBe(5);
    expect(result.usage.totalTokens).toBe(30);
    expect(result.content).toBe('{"ok":true}');
  });

  it('推理模型烧完预算 → 返回 truncated 而不是抛错', async () => {
    const client = makeClient(() => fakeResponse({
      body: {
        model: 'deepseek-v4.1-flash',
        choices: [{ message: { content: '', reasoning_content: '想了很久' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 10, completion_tokens: 1000, total_tokens: 1010 },
      },
    }));
    const result = await client.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.truncated).toBe(true);
    expect(result.content).toBe('');
    expect(result.reasoning).toContain('想了');
  });

  it('5xx 会重试，最终成功', async () => {
    let calls = 0;
    const client = makeClient(() => {
      calls += 1;
      if (calls === 1) return fakeResponse({ status: 503, text: 'busy' });
      return fakeResponse({ body: chatOk('{"ok":true}') });
    });
    const result = await client.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(calls).toBe(2);
    expect(result.attempts).toBe(2);
  });

  it('401 不重试，直接抛 auth', async () => {
    let calls = 0;
    const client = makeClient(() => {
      calls += 1;
      return fakeResponse({ status: 401, text: '{"error":{"message":"bad key"}}' });
    });
    await expect(client.chat({ messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toBeInstanceOf(AIGatewayError);
    expect(calls).toBe(1);
  });

  it('网关不认 response_format 时自动去掉重试', async () => {
    const bodies: any[] = [];
    const client = makeClient((_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.response_format) {
        return fakeResponse({ status: 400, text: '{"error":{"message":"unknown field response_format"}}' });
      }
      return fakeResponse({ body: chatOk('{"ok":true}') });
    });
    const result = await client.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.content).toBe('{"ok":true}');
    expect(bodies.length).toBe(2);
    expect(bodies[1].response_format).toBeUndefined();
  });

  it('公开配置不泄露 key，只给掩码', () => {
    const client = makeClient(() => fakeResponse({ body: chatOk('{"ok":true}') }));
    const pub = client.publicConfig();
    expect(pub.hasKey).toBe(true);
    expect(JSON.stringify(pub)).not.toContain('test-key');
    expect(pub.keyMask).not.toBe('test-key');
    expect(pub.keyMask).toContain('…');
  });

  it('thinking=off 才发送 thinking 参数', async () => {
    let captured: any = null;
    const client = makeClient((_url, init) => {
      captured = JSON.parse(init.body);
      return fakeResponse({ body: chatOk('{"ok":true}') });
    });
    await client.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(captured.thinking).toBeUndefined();
    client.saveConfig({ thinking: 'off' });
    await client.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(captured.thinking).toEqual({ type: 'disabled' });
  });
});
