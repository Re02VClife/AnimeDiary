/**
 * features/ai-analysis/chat-sessions — 对话会话的存取
 *
 * 抽屉里原来只有一个「当前对话」，关掉就没了。这里把会话做成可切换、可持久化的对象：
 * 每个会话存的是**模型视角的完整往返**（含 tool_calls / role:'tool'），
 * 这样切回来还能接着聊，而不是从零开始。
 *
 * 存储设计上的两个取舍：
 *   - 整份会话列表一个 key（anime_diary_ai_sessions_v1），不按会话分 key：
 *     会话数量是几十个量级，整存整取比遍历一堆 key 简单得多，也不会读到半截状态。
 *   - 上限 30 个，超出按 updatedAt 丢最旧的。聊天记录会一直变长，
 *     不设上限迟早会把这个 key 撑爆（localStorage 通常只有 5MB）。
 */

import type { ChatRecord } from './chat-agent';

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** 模型视角的完整往返 */
  records: ChatRecord[];
}

/** 只依赖这三个方法，便于测试时注入假存储 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const STORAGE_KEY = 'anime_diary_ai_sessions_v1';
const MAX_SESSIONS = 30;
const TITLE_MAX = 26;

function safeStorage(): StorageLike | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

let seq = 0;
export function newSessionId(now = Date.now()): string {
  seq += 1;
  return `s-${now.toString(36)}-${seq}`;
}

/** 从第一句用户输入提炼标题：去掉换行、太长截断 */
export function deriveSessionTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (!oneLine) return '新对话';
  return oneLine.length > TITLE_MAX ? `${oneLine.slice(0, TITLE_MAX)}…` : oneLine;
}

export function createSession(now = Date.now()): ChatSession {
  return {
    id: newSessionId(now),
    title: '新对话',
    createdAt: now,
    updatedAt: now,
    records: [],
  };
}

/** 把某个会话放进来（已存在则替换），并按最近更新排序 */
export function upsertSession(sessions: ChatSession[], next: ChatSession): ChatSession[] {
  const rest = sessions.filter((s) => s.id !== next.id);
  return [next, ...rest].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function removeSession(sessions: ChatSession[], id: string): ChatSession[] {
  return sessions.filter((s) => s.id !== id);
}

export function renameSession(sessions: ChatSession[], id: string, title: string): ChatSession[] {
  const next = title.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX) || '未命名';
  return sessions.map((s) => (s.id === id ? { ...s, title: next } : s));
}

/** 超出上限时丢最旧的（按 updatedAt） */
export function pruneSessions(sessions: ChatSession[], max = MAX_SESSIONS): ChatSession[] {
  if (sessions.length <= max) return sessions;
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, max);
}

/** 形状校验：localStorage 里的东西可能是旧版本或手改坏的 */
function isValidSession(v: unknown): v is ChatSession {
  if (!v || typeof v !== 'object') return false;
  const s = v as Partial<ChatSession>;
  return typeof s.id === 'string' && typeof s.title === 'string'
    && typeof s.createdAt === 'number' && typeof s.updatedAt === 'number'
    && Array.isArray(s.records);
}

export function loadSessions(storage: StorageLike | null = safeStorage()): ChatSession[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return pruneSessions(parsed.filter(isValidSession));
  } catch {
    return [];
  }
}

export function saveSessions(sessions: ChatSession[], storage: StorageLike | null = safeStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(pruneSessions(sessions)));
    return true;
  } catch (e) {
    // 配额满了：返回 false 让 UI 能提示「这次记录没保存成功」，而不是静默丢数据
    console.warn('[ai-chat] 会话保存失败:', e instanceof Error ? e.message : e);
    return false;
  }
}

export function clearSessions(storage: StorageLike | null = safeStorage()): void {
  if (!storage) return;
  try { storage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}
