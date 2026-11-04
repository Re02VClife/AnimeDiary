/**
 * server/ai-gateway 工具调用单测
 *
 * 重点全在「增量拼接」上：流式下 tool_calls 是按 index 分槽、arguments 一段段
 * 到达的，拼错一位 JSON 就废了；name 重复拼接会得到 get_weatherget_weather。
 * 另外还要守住一条容易踩的坑：带工具调用的回复 content 是空的，
 * 不能当成「模型没说话」报 empty 错。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createAIClient } from '../../server/ai-gateway';

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

function fakeStreamResponse(chunks: string[]) {
  const encoder = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) { controller.close(); return; }
      controller.enqueue(encoder.encode(chunks[i]));
      i += 1;
    },
  });
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'text/event-stream' },
    body,
    async json() { return {}; },
    async text() { return ''; },
    async arrayBuffer() { return new ArrayBuffer(0); },
  };
}

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n`;
}

const TOOLS = [{
  type: 'function' as const,
  function: {
    name: 'taste',
    description: '品味分析',
    parameters: { type: 'object', properties: {} },
  },
}];

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gateway-tools-'));
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

describe('请求体：tools 与 jsonMode 互斥', () => {
  it('带 tools 时下发 tools / tool_choice，且不带 response_format', async () => {
    let captured: any = null;
    const client = makeClient((_url, init) => {
      captured = JSON.parse(init.body);
      return fakeResponse({ body: { choices: [{ message: { content: '直接回答', tool_calls: [] }, finish_reason: 'stop' }] } });
    });

    await client.chat({ messages: [{ role: 'user', content: 'hi' }], tools: TOOLS });

    expect(captured.tools).toEqual(TOOLS);
    expect(captured.tool_choice).toBe('auto');
    // jsonMode 默认是开的，但有工具时绝不能同时带 —— 多数网关会直接 400
    expect(captured.response_format).toBeUndefined();
  });

  it('toolChoice=none 能透传（强制模型别调工具）', async () => {
    let captured: any = null;
    const client = makeClient((_url, init) => {
      captured = JSON.parse(init.body);
      return fakeResponse({ body: { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] } });
    });
    await client.chat({ messages: [{ role: 'user', content: 'hi' }], tools: TOOLS, toolChoice: 'none' });
    expect(captured.tool_choice).toBe('none');
  });

  it('不带 tools 时行为不变，仍然请求 response_format', async () => {
    let captured: any = null;
    const client = makeClient((_url, init) => {
      captured = JSON.parse(init.body);
      return fakeResponse({ body: { choices: [{ message: { content: '{"a":1}' }, finish_reason: 'stop' }] } });
    });
    await client.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(captured.response_format).toEqual({ type: 'json_object' });
    expect(captured.tools).toBeUndefined();
  });
});

describe('非流式：解析 tool_calls', () => {
  it('content 为空但有 tool_calls 时不报 empty 错，正常返回调用', async () => {
    const client = makeClient(() => fakeResponse({
      body: {
        choices: [{
          message: {
            content: null,
            tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'taste', arguments: '{}' } }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    }));

    const result = await client.chat({ messages: [{ role: 'user', content: 'hi' }], tools: TOOLS });

    expect(result.content).toBe('');
    expect(result.finishReason).toBe('tool_calls');
    expect(result.toolCalls).toEqual([{ id: 'call_a', name: 'taste', arguments: '{}' }]);
  });

  it('arguments 给成对象时转成字符串（有的网关不按规范来）', async () => {
    const client = makeClient(() => fakeResponse({
      body: {
        choices: [{
          message: { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'single_anime', arguments: { title: '86' } } }] },
          finish_reason: 'tool_calls',
        }],
      },
    }));
    const result = await client.chat({ messages: [{ role: 'user', content: 'hi' }], tools: TOOLS });
    expect(result.toolCalls?.[0].arguments).toBe('{"title":"86"}');
  });

  it('没有函数名的调用直接丢掉（没法执行）', async () => {
    const client = makeClient(() => fakeResponse({
      body: {
        choices: [{
          message: {
            content: '正文',
            tool_calls: [
              { id: 'bad', type: 'function', function: { arguments: '{}' } },
              { id: 'good', type: 'function', function: { name: 'taste', arguments: '{}' } },
            ],
          },
          finish_reason: 'tool_calls',
        }],
      },
    }));
    const result = await client.chat({ messages: [{ role: 'user', content: 'hi' }], tools: TOOLS });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0].name).toBe('taste');
  });

  it('既没 content 也没 tool_calls 时仍然报 empty（对错误保持严格）', async () => {
    const client = makeClient(() => fakeResponse({
      body: { choices: [{ message: { content: '' }, finish_reason: 'stop' }] },
    }));
    await expect(client.chat({ messages: [{ role: 'user', content: 'hi' }], tools: TOOLS }))
      .rejects.toThrow(/空内容/);
  });
});

describe('流式：tool_calls 增量拼接', () => {
  it('按 index 拼 arguments，name 不重复拼接', async () => {
    const client = makeClient(() => fakeStreamResponse([
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'taste', arguments: '' } }] } }] }),
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a"' } }] } }] }),
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] } }] }),
      sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n',
    ]));

    const result = await client.chatStream({ messages: [{ role: 'user', content: 'hi' }], tools: TOOLS }, () => {});

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0]).toEqual({ id: 'call_1', name: 'taste', arguments: '{"a":1}' });
    expect(result.finishReason).toBe('tool_calls');
  });

  it('name 在每个分片里重复出现时不会被拼成 taste_tastetaste', async () => {
    const client = makeClient(() => fakeStreamResponse([
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'taste', arguments: '{}' } }] } }] }),
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'taste', arguments: '' } }] } }] }),
      sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    ]));

    const result = await client.chatStream({ messages: [{ role: 'user', content: 'hi' }], tools: TOOLS }, () => {});
    expect(result.toolCalls?.[0].name).toBe('taste');
  });

  it('并行多个工具调用按 index 排序，不按到达顺序', async () => {
    const client = makeClient(() => fakeStreamResponse([
      // 先到 index 1，再到 index 0 —— 顺序不能靠 Map 的插入序
      sse({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'c2', function: { name: 'profile', arguments: '{}' } }] } }] }),
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'taste', arguments: '{}' } }] } }] }),
      sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    ]));

    const result = await client.chatStream({ messages: [{ role: 'user', content: 'hi' }], tools: TOOLS }, () => {});
    expect(result.toolCalls?.map((t) => t.name)).toEqual(['taste', 'profile']);
  });

  it('没有工具调用的普通流不受影响', async () => {
    const client = makeClient(() => fakeStreamResponse([
      sse({ choices: [{ delta: { content: '你' } }] }),
      sse({ choices: [{ delta: { content: '好' } }] }),
      sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    ]));

    const deltas: string[] = [];
    const result = await client.chatStream({ messages: [{ role: 'user', content: 'hi' }] }, (e) => {
      if (e.type === 'delta' && e.text) deltas.push(e.text);
    });

    expect(deltas.join('')).toBe('你好');
    expect(result.content).toBe('你好');
    expect(result.toolCalls).toBeUndefined();
  });

  it('流式请求体同样下发 tools 且不带 response_format', async () => {
    let captured: any = null;
    const client = makeClient((_url, init) => {
      captured = JSON.parse(init.body);
      return fakeStreamResponse([
        sse({ choices: [{ delta: { content: 'ok' } }] }),
        sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      ]);
    });
    await client.chatStream({ messages: [{ role: 'user', content: 'hi' }], tools: TOOLS }, () => {});
    expect(captured.tools).toEqual(TOOLS);
    expect(captured.response_format).toBeUndefined();
    expect(captured.stream).toBe(true);
  });
});
