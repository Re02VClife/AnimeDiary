/**
 * features/ai-analysis/chat-transcript — 把持久化的对话记录还原成可渲染的条目
 *
 * 会话要能切回来接着看，就必须能从 `records` 重建界面。这里有三个坑：
 *
 *   1. **不要重建 assistant 的 tool_calls 消息**：那条通常没有正文，
 *      界面上由工具卡片代表它，重建出来会多一个空气泡。
 *   2. **原始结果从 content 还原**：为了省 localStorage 配额，记录里没存 output 本体，
 *      只存了摘要（toolMeta）。原始 JSON 本来就在 content 里，这里解析回来。
 *   3. **解析失败要能接受**：content 可能因为超过 8000 字符被截断过，
 *      那不是合法 JSON —— 这种情况就不提供「查看原始结果」，而不是让整个会话打不开。
 */

import type { ChatRecord, ToolRun } from './chat-agent';

export type ChatItem =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'assistant'; text: string }
  | { id: string; kind: 'tool'; run: ToolRun; running: boolean }
  | { id: string; kind: 'error'; text: string };

/**
 * @param makeId 由调用方提供（保持本函数纯粹，测试时可给确定性 id）
 */
export function recordsToItems(records: ChatRecord[], makeId: (prefix: string) => string): ChatItem[] {
  const items: ChatItem[] = [];

  for (const record of records) {
    if (record.role === 'user') {
      items.push({ id: makeId('u'), kind: 'user', text: record.content });
      continue;
    }

    if (record.role === 'assistant') {
      // 带工具调用的 assistant 消息通常没有正文，交给下面的工具卡片表达
      if (record.content.trim()) {
        items.push({ id: makeId('a'), kind: 'assistant', text: record.content });
      }
      continue;
    }

    if (record.role === 'tool') {
      const meta = record.toolMeta;
      const failed = String(record.content).trimStart().startsWith('{"error"');
      let output: unknown;
      try {
        output = JSON.parse(record.content);
      } catch {
        output = undefined; // 被截断或不是 JSON：不提供原始视图
      }
      items.push({
        id: makeId('t'),
        kind: 'tool',
        running: false,
        run: {
          skillId: meta?.skillId || 'unknown',
          title: meta?.title || '工具结果',
          ok: meta?.ok ?? !failed,
          summary: meta?.summary || '',
          durationMs: meta?.durationMs || 0,
          ...(output !== undefined ? { output } : {}),
        },
      });
    }
  }

  return items;
}

/** 会话标题：用第一句用户输入，太长了截断 */
export function firstUserTitle(records: ChatRecord[]): string | null {
  const first = records.find((r) => r.role === 'user' && r.content.trim());
  return first ? first.content : null;
}
