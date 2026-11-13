/**
 * core/app-tools 单测 —— 能力层的权限与协议形状
 *
 * 这层决定「哪些工具能被模型看到」，错一个档位就可能让 AI 在只读模式里改数据。
 */
import { describe, it, expect } from 'vitest';
import {
  AppToolError,
  canUseAppTool,
  needsApproval,
  toAIToolSpec,
  type AppToolSpec,
} from '../../core/app-tools';

const readSpec: AppToolSpec = {
  name: 'app_demo_read',
  title: '示例只读',
  description: '只读示例',
  effect: 'read',
  modelInputs: [],
  inputSchema: { type: 'object', properties: {}, required: [] },
};

const writeSpec: AppToolSpec = {
  ...readSpec,
  name: 'app_demo_write',
  effect: 'write',
};

describe('canUseAppTool', () => {
  it('只读工具三档都能用', () => {
    for (const p of ['read', 'confirm', 'write'] as const) {
      expect(canUseAppTool(p, 'read')).toBe(true);
    }
  });

  it('写工具在 read 档不可用，confirm / write 可用', () => {
    expect(canUseAppTool('read', 'write')).toBe(false);
    expect(canUseAppTool('confirm', 'write')).toBe(true);
    expect(canUseAppTool('write', 'write')).toBe(true);
  });
});

describe('needsApproval', () => {
  it('只有 confirm 档的写工具需要逐次确认', () => {
    expect(needsApproval('confirm', 'write')).toBe(true);
    expect(needsApproval('write', 'write')).toBe(false);
    expect(needsApproval('read', 'write')).toBe(false);
    expect(needsApproval('confirm', 'read')).toBe(false);
  });
});

describe('toAIToolSpec', () => {
  it('把能力定义原样翻译成网关工具定义', () => {
    const spec = toAIToolSpec(writeSpec);
    expect(spec.type).toBe('function');
    expect(spec.function.name).toBe('app_demo_write');
    expect(spec.function.description).toBe(writeSpec.description);
    expect(spec.function.parameters).toEqual(readSpec.inputSchema);
  });
});

describe('AppToolError', () => {
  it('message 带错误码，模型能据此修正', () => {
    const err = new AppToolError('NOT_FOUND', '没有这部');
    expect(err.message).toBe('[NOT_FOUND] 没有这部');
    expect(err.code).toBe('NOT_FOUND');
  });
});
