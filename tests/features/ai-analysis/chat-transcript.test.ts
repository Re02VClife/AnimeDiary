/**
 * features/ai-analysis/chat-transcript 单测
 *
 * 这个函数负责「切回旧会话时界面长什么样」，最容易出的错是把模型消息里的
 * 技术细节漏到界面上（比如重建出一条只有 tool_calls 没有正文的空气泡），
 * 或者被截断的工具结果让它崩掉。
 */
import { describe, it, expect } from 'vitest';
import { recordsToItems, firstUserTitle } from '../../../features/ai-analysis/chat-transcript';
import type { ChatRecord } from '../../../features/ai-analysis/chat-agent';

function idGen() {
  let n = 0;
  return (prefix: string) => `${prefix}-${++n}`;
}

const toolMeta = {
  skillId: 'taste',
  title: '品味分析',
  ok: true,
  summary: '一句总结',
  durationMs: 1234,
};

describe('recordsToItems', () => {
  it('用户与助手消息按顺序还原', () => {
    const records: ChatRecord[] = [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好呀' },
    ];
    const items = recordsToItems(records, idGen());
    expect(items.map((i) => i.kind)).toEqual(['user', 'assistant']);
    expect(items[0]).toMatchObject({ text: '你好' });
  });

  it('只有 tool_calls 没有正文的 assistant 消息不产生空气泡', () => {
    const records: ChatRecord[] = [
      { role: 'user', content: '看品味' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'taste', arguments: '{}' } }],
      },
      { role: 'tool', content: '{"summary":"ok"}', tool_call_id: 'c1', toolMeta },
      { role: 'assistant', content: '结论如下' },
    ];
    const items = recordsToItems(records, idGen());
    expect(items.map((i) => i.kind)).toEqual(['user', 'tool', 'assistant']);
  });

  it('工具记录还原成卡片，原始结果从 content 解析回来', () => {
    const records: ChatRecord[] = [
      { role: 'tool', content: '{"summary":"ok"}', tool_call_id: 'c1', toolMeta },
    ];
    const items = recordsToItems(records, idGen());
    const item = items[0];
    expect(item.kind).toBe('tool');
    if (item.kind !== 'tool') return;
    expect(item.running).toBe(false);
    expect(item.run).toMatchObject({
      skillId: 'taste', title: '品味分析', ok: true, summary: '一句总结', durationMs: 1234,
    });
    expect(item.run.output).toEqual({ summary: 'ok' });
  });

  it('被截断的工具结果不提供原始视图，也不会崩', () => {
    const records: ChatRecord[] = [
      { role: 'tool', content: '{"a":1,…（结果过长已截断）', tool_call_id: 'c1', toolMeta },
    ];
    const item = recordsToItems(records, idGen())[0];
    expect(item.kind).toBe('tool');
    if (item.kind !== 'tool') return;
    expect(item.run.output).toBeUndefined();
    // 摘要还在，卡片不至于空着
    expect(item.run.summary).toBe('一句总结');
  });

  it('没有 toolMeta 的老记录：从 content 判断成败', () => {
    const failed = recordsToItems(
      [{ role: 'tool', content: '{"error":"数据不足"}', tool_call_id: 'c1' }],
      idGen(),
    )[0];
    expect(failed.kind).toBe('tool');
    if (failed.kind !== 'tool') return;
    expect(failed.run.ok).toBe(false);
    expect(failed.run.title).toBe('工具结果');
  });

  it('system 消息不进界面', () => {
    const items = recordsToItems([{ role: 'system', content: '你是助手' }], idGen());
    expect(items).toEqual([]);
  });

  it('空记录返回空数组', () => {
    expect(recordsToItems([], idGen())).toEqual([]);
  });
});

describe('firstUserTitle', () => {
  it('取第一句非空用户输入', () => {
    expect(firstUserTitle([
      { role: 'system', content: 'sys' },
      { role: 'user', content: '  ' },
      { role: 'user', content: '看看我的品味' },
      { role: 'user', content: '第二个问题' },
    ])).toBe('看看我的品味');
  });

  it('没有用户消息时返回 null', () => {
    expect(firstUserTitle([{ role: 'assistant', content: 'x' }])).toBeNull();
  });
});
