/**
 * core/ai-permission 单测 —— 三档权限的边界必须死板
 *
 * 这一层决定了「AI 能不能改你的数据」，错的代价是数据被悄悄改掉，
 * 所以重点测三件事：非法值兜底、每档能做什么、默认档位不能是 write。
 */
import { describe, it, expect } from 'vitest';
import {
  AI_PERMISSION_VALUES,
  AI_PERMISSION_INFO,
  normalizeAIPermission,
  canAIPropose,
  canAIAutoApply,
} from '../../core/ai-permission';

describe('normalizeAIPermission', () => {
  it('只有 read / write 被原样接受，其余一律落到 confirm', () => {
    expect(normalizeAIPermission('read')).toBe('read');
    expect(normalizeAIPermission('write')).toBe('write');
    expect(normalizeAIPermission('confirm')).toBe('confirm');
  });

  it('非法输入兜底到 confirm —— 既不禁用功能，也不会让 AI 悄悄写数据', () => {
    for (const bad of [undefined, null, '', 'WRITE', 'readonly', 0, 1, true, {}, []]) {
      expect(normalizeAIPermission(bad)).toBe('confirm');
    }
  });
});

describe('权限矩阵', () => {
  it('read：既不能提议也不能直写', () => {
    expect(canAIPropose('read')).toBe(false);
    expect(canAIAutoApply('read')).toBe(false);
  });

  it('confirm：能提议，不能直写', () => {
    expect(canAIPropose('confirm')).toBe(true);
    expect(canAIAutoApply('confirm')).toBe(false);
  });

  it('write：能提议，也能直写', () => {
    expect(canAIPropose('write')).toBe(true);
    expect(canAIAutoApply('write')).toBe(true);
  });

  it('只有 write 允许自动落库', () => {
    const auto = AI_PERMISSION_VALUES.filter((p) => canAIAutoApply(p));
    expect(auto).toEqual(['write']);
  });
});

describe('AI_PERMISSION_INFO', () => {
  it('三档都有完整的名称与说明', () => {
    for (const p of AI_PERMISSION_VALUES) {
      const info = AI_PERMISSION_INFO[p];
      expect(info.label.length).toBeGreaterThan(0);
      expect(info.short.length).toBeGreaterThan(0);
      expect(info.description.length).toBeGreaterThan(10);
    }
  });

  it('档位值与 info 的键完全对应，不多不少', () => {
    expect(Object.keys(AI_PERMISSION_INFO).sort()).toEqual([...AI_PERMISSION_VALUES].sort());
  });
});
