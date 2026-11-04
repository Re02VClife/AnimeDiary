/**
 * features/ai-analysis/chat-sessions 单测
 *
 * 会话是用户唯一「看得见丢了会疼」的东西 —— 聊天记录没有 git、也没有快照。
 * 所以这里重点测三件事：
 *   1. 坏数据不能把整个会话列表读崩（localStorage 里可能是旧版本或手改坏的）
 *   2. 排序与上限正确（最多 30 个，丢最旧的）
 *   3. 写失败要能被上层感知（返回 false，UI 才能提示"这轮没存下来"）
 */
import { describe, it, expect } from 'vitest';
import {
  createSession,
  deriveSessionTitle,
  upsertSession,
  removeSession,
  renameSession,
  pruneSessions,
  loadSessions,
  saveSessions,
  clearSessions,
} from '../../../features/ai-analysis/chat-sessions';
import type { ChatSession, StorageLike } from '../../../features/ai-analysis/chat-sessions';

const KEY = 'anime_diary_ai_sessions_v1';

function fakeStorage(initial: Record<string, string> = {}): StorageLike & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  };
}

function session(id: string, updatedAt: number, title = '对话'): ChatSession {
  return { id, title, createdAt: updatedAt, updatedAt, records: [] };
}

describe('deriveSessionTitle', () => {
  it('取第一句并压掉换行', () => {
    expect(deriveSessionTitle('帮我看看\n整体品味')).toBe('帮我看看 整体品味');
  });

  it('空输入兜底「新对话」', () => {
    expect(deriveSessionTitle('   ')).toBe('新对话');
  });

  it('过长截断并加省略号', () => {
    const long = '一'.repeat(60);
    const title = deriveSessionTitle(long);
    expect(title.length).toBeLessThanOrEqual(27);
    expect(title.endsWith('…')).toBe(true);
  });
});

describe('createSession', () => {
  it('id 唯一、标题默认、记录为空', () => {
    const a = createSession(1000);
    const b = createSession(1000);
    expect(a.id).not.toBe(b.id);
    expect(a.title).toBe('新对话');
    expect(a.records).toEqual([]);
    expect(a.createdAt).toBe(1000);
  });
});

describe('列表操作', () => {
  it('upsert 替换同 id，并按最近更新排在最前', () => {
    const a = session('a', 100);
    const b = session('b', 200);
    const list = upsertSession([a, b], { ...a, updatedAt: 300, title: '改过' });
    expect(list.map((s) => s.id)).toEqual(['a', 'b']);
    expect(list[0].title).toBe('改过');
    expect(list).toHaveLength(2);
  });

  it('remove 只删指定的那个', () => {
    expect(removeSession([session('a', 1), session('b', 2)], 'a').map((s) => s.id)).toEqual(['b']);
  });

  it('rename 会 trim 并限制长度', () => {
    const list = renameSession([session('a', 1)], 'a', '  新 名字  ');
    expect(list[0].title).toBe('新 名字');
    expect(renameSession([session('a', 1)], 'a', '').at(0)?.title).toBe('未命名');
  });

  it('超过上限时丢最旧的', () => {
    const many = Array.from({ length: 5 }, (_, i) => session(`s${i}`, i * 10));
    const kept = pruneSessions(many, 3);
    expect(kept.map((s) => s.id)).toEqual(['s4', 's3', 's2']);
  });
});

describe('持久化', () => {
  it('save → load 往返', () => {
    const storage = fakeStorage();
    const list = [session('a', 100, '第一个'), session('b', 200, '第二个')];
    expect(saveSessions(list, storage)).toBe(true);

    const loaded = loadSessions(storage);
    expect(loaded.map((s) => s.title)).toEqual(['第一个', '第二个']);
  });

  it('没有存储时读写都安全返回', () => {
    expect(loadSessions(null)).toEqual([]);
    expect(saveSessions([session('a', 1)], null)).toBe(false);
  });

  it('没有记录时返回空数组', () => {
    expect(loadSessions(fakeStorage())).toEqual([]);
  });

  it('坏 JSON 不抛错，返回空数组', () => {
    expect(loadSessions(fakeStorage({ [KEY]: '{不是 json' }))).toEqual([]);
  });

  it('顶层不是数组时返回空数组', () => {
    expect(loadSessions(fakeStorage({ [KEY]: '{"a":1}' }))).toEqual([]);
  });

  it('丢掉形状不对的条目，保留合法的', () => {
    const storage = fakeStorage({
      [KEY]: JSON.stringify([
        { id: 'ok', title: '好的', createdAt: 1, updatedAt: 1, records: [] },
        { id: 'bad-missing-records', title: '缺字段', createdAt: 1, updatedAt: 1 },
        null,
        'nonsense',
        { id: 2, title: 'id 类型不对', createdAt: 1, updatedAt: 1, records: [] },
      ]),
    });
    const loaded = loadSessions(storage);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('ok');
  });

  it('写入失败时返回 false（配额满等情况），不抛错', () => {
    const storage: StorageLike = {
      getItem: () => null,
      setItem: () => { throw new Error('QuotaExceededError'); },
      removeItem: () => {},
    };
    expect(saveSessions([session('a', 1)], storage)).toBe(false);
  });

  it('clearSessions 清掉存储', () => {
    const storage = fakeStorage({ [KEY]: '[]' });
    clearSessions(storage);
    expect(storage.map.has(KEY)).toBe(false);
  });
});
