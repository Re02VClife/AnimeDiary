/**
 * features/ai-analysis/skill-registry 单测
 *
 * registry 有两类容易出事的地方，重点测这两类：
 *   1. 描述是否自洽 —— id 撞车、entry 型能力却没声明 title 参数、缺 run，
 *      这些都会在「模型调度」时变成难查的运行时问题
 *   2. resolveEntry 的保守策略 —— 宁可返回 null 让人重选，也不能猜错一部番
 */
import { describe, it, expect } from 'vitest';
import {
  AI_SKILLS,
  getSkill,
  getSkillsFor,
  resolveEntry,
  toToolSpecs,
} from '../../../features/ai-analysis/skill-registry';
import type { AnimeEntry } from '../../../src/types';

function makeAnime(id: string, title: string): AnimeEntry {
  return {
    id,
    title,
    posterUrl: '',
    category: 'watched',
    tags: [],
    scores: [],
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
  };
}

const LIST: AnimeEntry[] = [
  makeAnime('1', '86 不存在的战区 part1'),
  makeAnime('2', '赛博朋克：边缘行者'),
  makeAnime('3', '利兹与青鸟'),
  makeAnime('4', '86 不存在的战区 part2'),
];

describe('能力清单的形状', () => {
  it('六个能力都在，且 id 不重复', () => {
    expect(AI_SKILLS).toHaveLength(6);
    const ids = AI_SKILLS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['taste', 'profile', 'recommend', 'single-anime', 'graph', 'auto-tag']);
  });

  it('每个能力都有能跑起来的必需字段', () => {
    for (const s of AI_SKILLS) {
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.icon.length).toBeGreaterThan(0);
      // description 是给模型判断「什么时候该用」的唯一依据，太短等于没说
      expect(s.description.length).toBeGreaterThan(10);
      expect(typeof s.run).toBe('function');
      expect(s.inputSchema.type).toBe('object');
      expect(Array.isArray(s.modelInputs)).toBe(true);
    }
  });

  it('context=entry 的能力必须声明 title 参数，否则模型无从指定番剧', () => {
    for (const s of AI_SKILLS.filter((x) => x.context === 'entry')) {
      expect(s.modelInputs).toContain('title');
      expect(s.inputSchema.required).toContain('title');
      expect(Object.keys(s.inputSchema.properties || {})).toContain('title');
    }
  });

  it('context=list/none 的能力不该让模型传任何参数', () => {
    for (const s of AI_SKILLS.filter((x) => x.context !== 'entry')) {
      expect(s.modelInputs).toEqual([]);
      expect(Object.keys(s.inputSchema.properties || {})).toEqual([]);
    }
  });

  it('当前全部是只读能力（写能力要等对话窗口接上三档权限）', () => {
    expect(AI_SKILLS.every((s) => s.effect === 'read')).toBe(true);
  });
});

describe('getSkill / getSkillsFor', () => {
  it('按 id 取到对应能力，取不到返回 undefined', () => {
    expect(getSkill('taste')?.title).toBe('品味分析');
    expect(getSkill('不存在')).toBeUndefined();
  });

  it('全是只读能力时，三档权限拿到的清单一样', () => {
    for (const p of ['read', 'confirm', 'write'] as const) {
      expect(getSkillsFor(p)).toHaveLength(6);
    }
  });
});

describe('resolveEntry 的保守策略', () => {
  it('精确匹配', () => {
    expect(resolveEntry(LIST, '利兹与青鸟')?.id).toBe('3');
  });

  it('忽略大小写的精确匹配', () => {
    const list = [makeAnime('a', 'Steins;Gate')];
    expect(resolveEntry(list, 'steins;gate')?.id).toBe('a');
  });

  it('标题唯一包含时接受（用户常只记得片段）', () => {
    expect(resolveEntry(LIST, '边缘行者')?.id).toBe('2');
  });

  it('多处命中时返回 null —— 绝不猜', () => {
    // 「86 不存在的战区」同时被 part1 / part2 包含
    expect(resolveEntry(LIST, '86 不存在的战区')).toBeNull();
  });

  it('完全对不上时返回 null', () => {
    expect(resolveEntry(LIST, '不存在的番')).toBeNull();
  });

  it('空标题 / 只有空白返回 null', () => {
    expect(resolveEntry(LIST, '')).toBeNull();
    expect(resolveEntry(LIST, '   ')).toBeNull();
  });
});

describe('toToolSpecs', () => {
  it('产出 OpenAI 线格式：type=function + function.{name,description,parameters}', () => {
    const specs = toToolSpecs(AI_SKILLS);
    for (const s of specs) {
      expect(s.type).toBe('function');
      expect(typeof s.function.name).toBe('string');
      expect(typeof s.function.description).toBe('string');
      expect(s.function.parameters).toBeTruthy();
    }
  });

  it('把 id 里的短横线换成下划线（多数网关的工具名只接受字母数字下划线）', () => {
    const names = toToolSpecs(AI_SKILLS).map((s) => s.function.name);
    expect(names).toContain('single_anime');
    expect(names).toContain('auto_tag');
    expect(names.some((n) => n.includes('-'))).toBe(false);
  });

  it('原样带上 description 与 parameters', () => {
    const taste = getSkill('taste')!;
    const spec = toToolSpecs([taste])[0];
    expect(spec.function.description).toBe(taste.description);
    expect(spec.function.parameters).toBe(taste.inputSchema);
  });
});
