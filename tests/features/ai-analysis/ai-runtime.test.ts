/**
 * features/ai-analysis/ai-runtime 单测 —— 两次运行之间不能串账
 *
 * 这是这次重构的全部意义：原来 beginAIRun / setAIStreamListener 是模块级单例，
 * 「同一时刻只跑一次分析」时没问题；一旦对话窗口里两个会话并行，token 会记到
 * 同一个篮子里、思考片段会串到另一个画面，而且是静默的。
 *
 * 所以重点测三件事：
 *   1. 两个实例的用量互不影响
 *   2. 两个实例的流式回调互不影响（不串画面）
 *   3. aiChat / aiJSON 真的把调用记到了传入实例上，没偷偷落回默认实例
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createAIRun, defaultAIRun, beginAIRun, getAIRunSummary, setAIStreamListener } from '../../../features/ai-analysis/ai-runtime';
import { aiChat, aiJSON } from '../../../features/ai-analysis/llm-service';

function usageResult(overrides: Record<string, unknown> = {}) {
  return {
    content: 'ok',
    reasoning: '',
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30, reasoningTokens: 5 },
    model: 'test-model',
    provider: 'test-provider',
    finishReason: 'stop',
    truncated: false,
    latencyMs: 7,
    attempts: 1,
    ...overrides,
  };
}

/** 假网关：返回一个结构完整的 ChatResult 包 */
function stubFetchReturning(result: Record<string, unknown>) {
  const spy = vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    async json() { return { ok: true, result }; },
    async text() { return JSON.stringify({ ok: true, result }); },
  }));
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  beginAIRun(); // 默认实例每次清零，避免测试间互相污染
  defaultAIRun.setListener(null);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  defaultAIRun.setListener(null);
  vi.restoreAllMocks();
});

describe('createAIRun 的隔离性', () => {
  it('两个实例的用量互不影响', () => {
    const a = createAIRun('a');
    const b = createAIRun('b');
    a.begin();
    b.begin();

    a.record({
      provider: 'p', model: 'm1', latencyMs: 100, attempts: 1,
      usage: { promptTokens: 5, completionTokens: 10, totalTokens: 15, reasoningTokens: 0 },
    });

    expect(a.summary().calls).toBe(1);
    expect(a.summary().totalTokens).toBe(15);
    expect(b.summary().calls).toBe(0);
    expect(b.summary().totalTokens).toBe(0);
  });

  it('begin() 只清自己的账', () => {
    const a = createAIRun('a');
    const b = createAIRun('b');
    const meta = {
      provider: 'p', model: 'm', latencyMs: 1, attempts: 1,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, reasoningTokens: 0 },
    };
    a.begin();
    b.begin();
    a.record(meta);
    b.record(meta);

    a.begin();
    expect(a.summary().calls).toBe(0);
    expect(b.summary().calls).toBe(1);
  });

  it('流式回调互不串：A 的片段不会喂给 B 的监听器', () => {
    const a = createAIRun('a');
    const b = createAIRun('b');
    const gotA: string[] = [];
    const gotB: string[] = [];
    a.setListener((c) => gotA.push(c.text));
    b.setListener((c) => gotB.push(c.text));

    a.emit('reasoning', 'A 的思考');
    b.emit('text', 'B 的正文');

    expect(gotA).toEqual(['A 的思考']);
    expect(gotB).toEqual(['B 的正文']);
  });

  it('监听器抛异常不会打断分析', () => {
    const a = createAIRun('a');
    a.setListener(() => { throw new Error('UI 崩了'); });
    expect(() => a.emit('text', 'x')).not.toThrow();
  });

  it('summary() 返回副本，改它不影响内部状态', () => {
    const a = createAIRun('a');
    a.begin();
    a.record({
      provider: 'p', model: 'm1', latencyMs: 1, attempts: 1, purpose: 'taste',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, reasoningTokens: 0 },
    });
    const s = a.summary();
    s.calls = 999;
    s.models.push('伪造');
    s.purposes.push('伪造');

    expect(a.summary().calls).toBe(1);
    expect(a.summary().models).toEqual(['m1']);
    expect(a.summary().purposes).toEqual(['taste']);
  });

  it('id 各不相同，便于排查串账', () => {
    expect(createAIRun('x').id).not.toBe(createAIRun('x').id);
  });
});

describe('aiChat 记到正确的实例上', () => {
  it('传了 run 就记到它，默认实例不受影响', async () => {
    stubFetchReturning(usageResult());
    const run = createAIRun('chat');
    run.begin();

    await aiChat([{ role: 'user', content: 'hi' }], { run, purpose: 'taste' });

    expect(run.summary().calls).toBe(1);
    expect(run.summary().totalTokens).toBe(30);
    expect(run.summary().models).toEqual(['test-model']);
    expect(run.summary().purposes).toEqual(['taste']);
    // 没有偷偷落回默认实例
    expect(getAIRunSummary().calls).toBe(0);
  });

  it('不传 run 时落到默认实例（旧行为不变）', async () => {
    stubFetchReturning(usageResult());
    await aiChat([{ role: 'user', content: 'hi' }]);
    expect(getAIRunSummary().calls).toBe(1);
  });

  it('两次调用各记各的，不会叠加到同一份 summary 之外', async () => {
    stubFetchReturning(usageResult());
    const a = createAIRun('a');
    const b = createAIRun('b');
    a.begin();
    b.begin();

    await aiChat([{ role: 'user', content: '1' }], { run: a });
    await aiChat([{ role: 'user', content: '2' }], { run: a });
    await aiChat([{ role: 'user', content: '3' }], { run: b });

    expect(a.summary().calls).toBe(2);
    expect(b.summary().calls).toBe(1);
  });
});

describe('aiJSON 把 run 透传给 aiChat', () => {
  it('Skill 走 aiJSON 时用量记在传入的实例上', async () => {
    stubFetchReturning(usageResult({ content: '{"answer":42}' }));
    const run = createAIRun('skill');
    run.begin();

    const { data } = await aiJSON<{ answer: number }>({
      schema: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] },
      system: 'sys',
      user: 'usr',
      run,
      purpose: 'unit',
    });

    expect(data.answer).toBe(42);
    expect(run.summary().calls).toBe(1);
    expect(getAIRunSummary().calls).toBe(0);
  });
});

describe('默认实例的兼容函数', () => {
  it('setAIStreamListener 挂到默认实例，beginAIRun 清它的账', () => {
    const got: string[] = [];
    setAIStreamListener((c) => got.push(c.text));
    defaultAIRun.emit('text', 'hello');
    expect(got).toEqual(['hello']);

    defaultAIRun.record({
      provider: 'p', model: 'm', latencyMs: 1, attempts: 1,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, reasoningTokens: 0 },
    });
    expect(getAIRunSummary().calls).toBe(1);
    beginAIRun();
    expect(getAIRunSummary().calls).toBe(0);
  });
});
