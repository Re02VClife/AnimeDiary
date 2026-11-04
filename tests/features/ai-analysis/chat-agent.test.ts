/**
 * features/ai-analysis/chat-agent 单测
 *
 * 这一层是「模型说要做 X → 本地决定要不要做、怎么做」的全部判断。
 * 重点在于**模型不可信**的四条边界：
 *   1. 工具名对不上    → 作为工具错误回给模型，不让整个对话崩掉
 *   2. 参数不是 JSON   → 不让 skill 跑
 *   3. 参数有越权字段  → 白名单过滤掉（模型碰不到数字）
 *   4. 模型陷进循环    → 轮数上限止损，否则会一直烧钱
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runChatAgent } from '../../../features/ai-analysis/chat-agent';
import { beginAIRun, defaultAIRun } from '../../../features/ai-analysis/ai-runtime';
import type { AnyAISkill } from '../../../features/ai-analysis/skill-registry';
import type { AnimeEntry } from '../../../src/types';

function makeAnime(id: string, title: string): AnimeEntry {
  return {
    id, title, posterUrl: '', category: 'watched', tags: [], scores: [],
    createdAt: '2024-01-01', updatedAt: '2024-01-01',
  };
}

const LIST = [makeAnime('1', '86 不存在的战区 part1'), makeAnime('2', '利兹与青鸟')];

/** 造一个可控的能力替身 */
function stubSkill(over: Partial<AnyAISkill> = {}): AnyAISkill {
  return {
    id: 'taste',
    title: '品味分析',
    icon: '🎯',
    description: '测试用能力，用来验证调度循环的行为是否与预期一致。',
    effect: 'read',
    context: 'list',
    modelInputs: [],
    inputSchema: { type: 'object', properties: {}, required: [] },
    run: async () => ({ summary: '假结果' }),
    summarize: (o: any) => String(o?.summary ?? ''),
    ...over,
  };
}

function chatResult(over: Record<string, unknown> = {}) {
  return {
    content: '',
    reasoning: '',
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, reasoningTokens: 0 },
    model: 'test-model',
    provider: 'test-provider',
    finishReason: 'stop',
    truncated: false,
    latencyMs: 5,
    attempts: 1,
    ...over,
  };
}

/** 按顺序返回若干次模型响应 */
function queueModel(responses: Record<string, unknown>[]) {
  let i = 0;
  const captured: any[] = [];
  globalThis.fetch = vi.fn(async (_url: string, init: any) => {
    captured.push(JSON.parse(init.body));
    const result = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      async json() { return { ok: true, result }; },
      async text() { return JSON.stringify({ ok: true, result }); },
    };
  }) as unknown as typeof fetch;
  return captured;
}

function toolCall(name: string, args: string, id = 'call_1') {
  return { id, name, arguments: args };
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  beginAIRun();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const baseOpts = () => ({
  list: LIST,
  history: [],
  userText: '看看我的品味',
  run: defaultAIRun,
  permission: 'confirm' as const,
});

describe('直接回答（模型不调工具）', () => {
  it('一轮就结束，返回文本并把消息接进记录', async () => {
    queueModel([chatResult({ content: '你的口味偏情绪向。' })]);
    const res = await runChatAgent({ ...baseOpts(), skills: [stubSkill()] });

    expect(res.text).toBe('你的口味偏情绪向。');
    expect(res.rounds).toBe(1);
    expect(res.toolRuns).toHaveLength(0);
    expect(res.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });
});

describe('工具调用', () => {
  it('执行 skill、把结果回传、再拿到最终回答', async () => {
    const captured = queueModel([
      chatResult({ finishReason: 'tool_calls', toolCalls: [toolCall('taste', '{}')] }),
      chatResult({ content: '根据分析，你偏爱情绪沉浸。' }),
    ]);

    const res = await runChatAgent({ ...baseOpts(), skills: [stubSkill()] });

    expect(res.text).toBe('根据分析，你偏爱情绪沉浸。');
    expect(res.rounds).toBe(2);
    expect(res.toolRuns).toHaveLength(1);
    expect(res.toolRuns[0]).toMatchObject({ skillId: 'taste', ok: true, summary: '假结果' });

    // 往返结构必须完整：assistant.tool_calls + role:'tool' + tool_call_id
    const roles = res.messages.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'tool', 'assistant']);
    const assistantCall = res.messages[1];
    expect(assistantCall.tool_calls?.[0].function.name).toBe('taste');
    const toolMsg = res.messages[2];
    expect(toolMsg.tool_call_id).toBe('call_1');
    expect(toolMsg.content).toContain('假结果');

    // 第二次请求带上了工具往返（否则模型会重复调用）
    const secondMessages = captured[1].messages;
    expect(secondMessages.some((m: any) => m.role === 'tool')).toBe(true);
    expect(secondMessages.some((m: any) => m.tool_calls)).toBe(true);
  });

  it('参数里的越权字段被白名单丢掉，skill 收不到', async () => {
    let received: any = null;
    const skill = stubSkill({
      modelInputs: ['title'],
      async run(input: any) {
        received = input;
        return { summary: 'ok' };
      },
    });

    queueModel([
      chatResult({ finishReason: 'tool_calls', toolCalls: [toolCall('taste', '{"title":"86","score":9.9,"id":"fake"}')] }),
      chatResult({ content: '好' }),
    ]);

    const res = await runChatAgent({ ...baseOpts(), skills: [skill] });
    // 先确认 skill 真的跑过了 —— 否则下面的断言可能因为「根本没执行」而空转
    expect(res.toolRuns[0].ok).toBe(true);
    expect(received).toEqual({ title: '86' });
  });

  it('参数不是合法 JSON 时不执行 skill，把错误回给模型', async () => {
    const run = vi.fn(async () => ({ summary: '不该被调用' }));
    const skill = stubSkill({ run });
    queueModel([
      chatResult({ finishReason: 'tool_calls', toolCalls: [toolCall('taste', '{"title":')] }),
      chatResult({ content: '参数有问题，我再试一次。' }),
    ]);

    const res = await runChatAgent({ ...baseOpts(), skills: [skill] });
    expect(run).not.toHaveBeenCalled();
    expect(res.toolRuns[0].ok).toBe(false);
    expect(res.toolRuns[0].error).toContain('JSON');
  });

  it('工具名对不上时不让对话崩掉，模型能收到可用清单', async () => {
    const captured = queueModel([
      chatResult({ finishReason: 'tool_calls', toolCalls: [toolCall('不存在的工具', '{}')] }),
      chatResult({ content: '我换个方式回答。' }),
    ]);

    const res = await runChatAgent({ ...baseOpts(), skills: [stubSkill()] });
    expect(res.text).toBe('我换个方式回答。');
    expect(res.toolRuns[0].ok).toBe(false);
    expect(res.toolRuns[0].error).toContain('没有这个能力');

    const toolMsg = captured[1].messages.find((m: any) => m.role === 'tool');
    expect(toolMsg.content).toContain('没有这个能力');
  });

  it('skill 抛错时转成工具错误，不中断对话', async () => {
    const skill = stubSkill({
      async run() { throw new Error('数据不足'); },
    });
    queueModel([
      chatResult({ finishReason: 'tool_calls', toolCalls: [toolCall('taste', '{}')] }),
      chatResult({ content: '数据不够，先多评几部吧。' }),
    ]);

    const res = await runChatAgent({ ...baseOpts(), skills: [skill] });
    expect(res.text).toContain('多评几部');
    expect(res.toolRuns[0]).toMatchObject({ ok: false, error: '数据不足' });
  });

  it('同一轮多个工具调用并行执行，顺序按模型给的来', async () => {
    const order: string[] = [];
    const a = stubSkill({
      id: 'taste', title: '品味', async run() { order.push('a'); return { summary: 'A' }; },
    });
    const b = stubSkill({
      id: 'auto-tag', title: '打标签', modelInputs: ['title'],
      async run() { order.push('b'); return { summary: 'B' }; },
    });

    queueModel([
      chatResult({
        finishReason: 'tool_calls',
        toolCalls: [toolCall('taste', '{}', 'c1'), toolCall('auto_tag', '{"title":"86"}', 'c2')],
      }),
      chatResult({ content: '都好了' }),
    ]);

    const res = await runChatAgent({ ...baseOpts(), skills: [a, b] });
    expect(res.toolRuns.map((r) => r.skillId)).toEqual(['taste', 'auto-tag']);
    expect(order.sort()).toEqual(['a', 'b']);
  });

  it('网关没给 call id 时补一个，保证 tool_call_id 对得上', async () => {
    queueModel([
      chatResult({ finishReason: 'tool_calls', toolCalls: [toolCall('taste', '{}', '')] }),
      chatResult({ content: '好了' }),
    ]);
    const res = await runChatAgent({ ...baseOpts(), skills: [stubSkill()] });

    const assistantCall = res.messages[1].tool_calls?.[0];
    const toolMsg = res.messages[2];
    expect(assistantCall?.id).toBeTruthy();
    expect(toolMsg.tool_call_id).toBe(assistantCall?.id);
  });
});

describe('止损与权限', () => {
  it('模型连续调用工具超过 maxRounds 就抛错，不会无限烧钱', async () => {
    queueModel([chatResult({ finishReason: 'tool_calls', toolCalls: [toolCall('taste', '{}')] })]);
    await expect(runChatAgent({ ...baseOpts(), skills: [stubSkill()], maxRounds: 3 }))
      .rejects.toThrow(/连续 3 轮/);
  });

  it('read 档下写能力不会出现在工具里', async () => {
    const captured = queueModel([chatResult({ content: '只读' })]);
    const writeSkill = stubSkill({ id: 'fake-write', effect: 'write', title: '写能力', description: '会给数据打标签的写能力，用来验证权限过滤。' });

    await runChatAgent({ ...baseOpts(), permission: 'read', skills: [stubSkill(), writeSkill] });

    const toolNames = captured[0].tools.map((t: any) => t.function.name);
    expect(toolNames).toContain('taste');
    expect(toolNames).not.toContain('fake_write');
  });

  it('write 档下写能力可以出现在工具里', async () => {
    const captured = queueModel([chatResult({ content: '可写' })]);
    const writeSkill = stubSkill({ id: 'fake-write', effect: 'write', title: '写能力', description: '会给数据打标签的写能力，用来验证权限过滤。' });

    await runChatAgent({ ...baseOpts(), permission: 'write', skills: [writeSkill] });

    const toolNames = captured[0].tools.map((t: any) => t.function.name);
    expect(toolNames).toContain('fake_write');
  });
});
