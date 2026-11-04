/**
 * AI 对话抽屉
 *
 * 为什么是抽屉而不是 Modal：用户提问题时需要一边看着番剧网格一边聊
 * （「为什么《86》我给这么高」——得先能看见它）。所以它贴在右侧、
 * 不遮挡内容、宽度可拖拽，关掉就是一条边。
 *
 * 数据流：这里的 messages 是**模型视角的完整往返**（含 tool_calls / tool 结果），
 * 不能只留好看的那几条 —— 少一条 role:'tool' 模型就会重复调用同一个工具。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Tooltip, Select, Popconfirm } from 'antd';
import { SendOutlined, PlusOutlined, CloseOutlined, StopOutlined, DeleteOutlined } from '@ant-design/icons';
import { catgirlMessage } from '../theme';
import Markdown from './Markdown';
import { hasAIConfig, getAIPermission } from '../../features/ai-analysis';
import { AI_PERMISSION_INFO } from '../../core/ai-permission';
import { createAIRun } from '../../features/ai-analysis/ai-runtime';
import type { AIRun } from '../../features/ai-analysis/ai-runtime';
import { runChatAgent } from '../../features/ai-analysis/chat-agent';
import type { ChatRecord } from '../../features/ai-analysis/chat-agent';
import { recordsToItems, firstUserTitle } from '../../features/ai-analysis/chat-transcript';
import type { ChatItem } from '../../features/ai-analysis/chat-transcript';
import {
  loadSessions,
  saveSessions,
  createSession,
  upsertSession,
  removeSession,
  deriveSessionTitle,
} from '../../features/ai-analysis/chat-sessions';
import type { ChatSession } from '../../features/ai-analysis/chat-sessions';
import type { AnimeEntry } from '../types';

interface AIChatDrawerProps {
  open: boolean;
  onClose: () => void;
  animeList: AnimeEntry[];
  onOpenSettings: () => void;
}

const WIDTH_KEY = 'anime_diary_ai_chat_width';
const MIN_WIDTH = 340;
const DEFAULT_WIDTH = 440;

function maxWidth(): number {
  return Math.max(MIN_WIDTH + 40, Math.min(760, Math.floor(window.innerWidth * 0.72)));
}

function loadWidth(): number {
  try {
    const raw = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(raw) && raw >= MIN_WIDTH) return Math.min(raw, maxWidth());
  } catch { /* ignore */ }
  return DEFAULT_WIDTH;
}

const SUGGESTIONS = [
  '看看我的整体品味',
  '我最不挑哪些方面',
  '帮我分析《86 不存在的战区 part1》',
  '有什么值得补的番',
];

let itemSeq = 0;
function nextId(prefix: string): string {
  itemSeq += 1;
  return `${prefix}-${itemSeq}`;
}

const AIChatDrawer: React.FC<AIChatDrawerProps> = ({ open, onClose, animeList, onOpenSettings }) => {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [streamReasoning, setStreamReasoning] = useState('');
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState<string>('');

  /** 模型视角的对话记录（含工具往返），跨轮累积 */
  const historyRef = useRef<ChatRecord[]>([]);
  /** 每次打开抽屉换一个新的运行实例，避免上一次的用量/监听器污染这一轮 */
  const runRef = useRef<AIRun | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** tool-start 与 tool-done 的配对队列（同一轮多个调用并行，靠 FIFO 对上号） */
  const pendingToolsRef = useRef<string[]>([]);
  const listEndRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, width: DEFAULT_WIDTH });

  useEffect(() => {
    if (open) setWidth(loadWidth());
  }, [open]);

  // 首次打开时读会话列表；一个都没有就开一个新的
  useEffect(() => {
    if (!open || sessions.length > 0) return;
    const stored = loadSessions();
    if (stored.length > 0) {
      setSessions(stored);
      setActiveId(stored[0].id);
      historyRef.current = stored[0].records;
      setItems(recordsToItems(stored[0].records, nextId));
    } else {
      const fresh = createSession();
      setSessions([fresh]);
      setActiveId(fresh.id);
      historyRef.current = [];
      setItems([]);
    }
  }, [open, sessions.length]);

  /**
   * 把当前宽度广播成 CSS 变量。
   * 抽屉是 position:fixed 的浮层，不参与布局；但底部浮动条之类「相对视口居中」的元素
   * 会在抽屉拉开后被压住。让它们读 --ai-chat-width 自己让位，比把宽度一层层传 prop 省事。
   */
  useEffect(() => {
    const root = document.documentElement;
    if (open) root.style.setProperty('--ai-chat-width', `${width}px`);
    else root.style.removeProperty('--ai-chat-width');
    return () => { root.style.removeProperty('--ai-chat-width'); };
  }, [open, width]);

  useEffect(() => {
    if (!open) return;
    listEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [items, streamText, open]);

  // ── 拖拽调宽 ──
  useEffect(() => {
    if (!open) return;
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const delta = dragStartRef.current.x - e.clientX; // 往左拖变宽
      const next = Math.max(MIN_WIDTH, Math.min(maxWidth(), dragStartRef.current.width + delta));
      setWidth(next);
    };
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setWidth((w) => {
        try { localStorage.setItem(WIDTH_KEY, String(Math.round(w))); } catch { /* ignore */ }
        return w;
      });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [open]);

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    dragStartRef.current = { x: e.clientX, width };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const permission = getAIPermission();
  const configured = hasAIConfig();

  /**
   * 外出 updater 的列表副本。
   * React 的 setState updater 必须是纯函数 —— StrictMode 下会被调用两次，
   * 在里面 saveSessions / setActiveId 就会双写、甚至在渲染期更新另一个组件。
   * 所以所有会话变更都先用 ref 算出新列表，再一次性 setSessions。
   */
  const sessionsRef = useRef<ChatSession[]>([]);
  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);

  /** 切到某个会话：把它的记录还原成界面 */
  const switchSession = useCallback((id: string) => {
    const target = sessionsRef.current.find((s) => s.id === id);
    if (!target) return;
    historyRef.current = target.records;
    setItems(recordsToItems(target.records, nextId));
    setActiveId(id);
    setStreamText('');
    setStreamReasoning('');
  }, []);

  /** 新开一个会话（不删除旧的） */
  const newSession = useCallback(() => {
    abortRef.current?.abort();
    runRef.current?.setListener(null);
    runRef.current = null;
    pendingToolsRef.current = [];

    const fresh = createSession();
    const next = upsertSession(sessionsRef.current, fresh);
    sessionsRef.current = next;
    setSessions(next);
    saveSessions(next);

    setActiveId(fresh.id);
    historyRef.current = [];
    setItems([]);
    setStreamText('');
    setStreamReasoning('');
    setBusy(false);
  }, []);

  /** 删掉当前会话，并切到剩下的第一个 */
  const deleteSession = useCallback(() => {
    if (!activeId) return;
    const remaining = removeSession(sessionsRef.current, activeId);
    // 至少留一个：删光了界面就空了
    const fallback = remaining[0] || createSession();
    const next = remaining.length > 0 ? remaining : [fallback];
    sessionsRef.current = next;
    setSessions(next);
    saveSessions(next);

    setActiveId(fallback.id);
    historyRef.current = fallback.records;
    setItems(recordsToItems(fallback.records, nextId));
    setStreamText('');
    setStreamReasoning('');
  }, [activeId]);

  /** 一轮结束后把记录写回会话（同时补标题、更新时间） */
  const persistSession = useCallback((records: ChatRecord[]) => {
    const current = sessionsRef.current.find((s) => s.id === activeId);
    if (!current) return;
    const rawTitle = firstUserTitle(records);
    const next: ChatSession = {
      ...current,
      records,
      // 标题只在还是默认值时自动取；用户手动改过就不动它
      title: current.title === '新对话' && rawTitle
        ? deriveSessionTitle(rawTitle)
        : current.title,
      updatedAt: Date.now(),
    };
    const list = upsertSession(sessionsRef.current, next);
    sessionsRef.current = list;
    setSessions(list);
    if (!saveSessions(list)) {
      catgirlMessage.warning('会话保存失败（本地存储可能已满），这一轮记录没能存下来');
    }
  }, [activeId]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const send = useCallback(async (text: string) => {
    const question = text.trim();
    if (!question || busy) return;
    if (!hasAIConfig()) {
      catgirlMessage.warning('请先在 AI 设置里配置服务商与 API Key');
      return;
    }

    setInput('');
    setItems((prev) => [...prev, { id: nextId('u'), kind: 'user', text: question }]);

    // 流式缓冲：SSE 片段密度很高，逐片 setState 会把主线程刷爆（长回答明显掉帧）。
    // 攒进局部变量，按帧合并刷新。
    const buf = { reasoning: '', text: '' };
    let raf: number | null = null;
    const flush = () => {
      raf = null;
      setStreamReasoning(buf.reasoning);
      setStreamText(buf.text);
    };
    const clearStream = () => {
      buf.reasoning = '';
      buf.text = '';
      if (raf != null) { cancelAnimationFrame(raf); raf = null; }
      setStreamText('');
      setStreamReasoning('');
    };

    // 每次提问用一个新的运行实例：上一次的用量与监听器不会带过来
    const run = createAIRun('chat');
    runRef.current = run;
    run.setListener((chunk) => {
      if (chunk.kind === 'reasoning') buf.reasoning += chunk.text;
      else buf.text += chunk.text;
      if (raf == null) raf = requestAnimationFrame(flush);
    });

    const controller = new AbortController();
    abortRef.current = controller;
    pendingToolsRef.current = [];
    setBusy(true);
    clearStream();

    try {
      const result = await runChatAgent({
        list: animeList,
        history: historyRef.current,
        userText: question,
        run,
        permission,
        signal: controller.signal,
        stream: true,
        onEvent: (e) => {
          if (e.type === 'assistant') {
            // 这一段已有正文了，把流式缓冲收进一条正式消息
            setItems((prev) => [...prev, { id: nextId('a'), kind: 'assistant', text: e.text }]);
            clearStream();
          } else if (e.type === 'tool-start') {
            const id = nextId('t');
            pendingToolsRef.current.push(id);
            setItems((prev) => [...prev, {
              id,
              kind: 'tool',
              running: true,
              run: {
                skillId: e.skillId, title: e.title, ok: true,
                summary: '正在执行…', durationMs: 0,
              },
            }]);
          } else if (e.type === 'tool-done') {
            const id = pendingToolsRef.current.shift();
            setItems((prev) => prev.map((it) => (
              it.kind === 'tool' && it.id === id
                ? { ...it, running: false, run: e.toolRun }
                : it
            )));
            clearStream();
          }
        },
      });

      historyRef.current = result.messages;
      // 落盘：切走再切回来能接着聊，关掉应用也还在
      persistSession(result.messages);
      // 模型可能只调了工具没说话：补一条提示，避免界面看起来"卡住了"
      if (result.toolRuns.length > 0 && !result.text.trim()) {
        setItems((prev) => [...prev, {
          id: nextId('a'), kind: 'assistant', text: '（已执行上面的分析，但没有文字回复。可以再问一句“总结一下”。）',
        }]);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const aborted = /取消|abort/i.test(msg);
      if (!aborted) setItems((prev) => [...prev, { id: nextId('e'), kind: 'error', text: msg }]);
    } finally {
      run.setListener(null);
      abortRef.current = null;
      pendingToolsRef.current = [];
      setBusy(false);
      clearStream();
    }
  }, [animeList, busy, permission, persistSession]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(input);
    }
  };

  const permInfo = AI_PERMISSION_INFO[permission];
  const widthStyle = useMemo(() => ({ width }), [width]);

  if (!open) return null;

  return (
    <>
      {/* 拖拽把手：贴着抽屉左缘的细条，命中区域比看起来宽一点 */}
      <div
        onMouseDown={startDrag}
        title="拖拽调整宽度"
        style={{
          position: 'fixed', top: 0, bottom: 0, right: width - 3, width: 10,
          cursor: 'col-resize', zIndex: 1001,
          background: 'transparent',
        }}
      >
        <div style={{
          width: 1, height: '100%', marginLeft: 4,
          background: 'var(--border-primary)', opacity: 0.9,
        }} />
      </div>

      <aside
        style={{
          ...widthStyle,
          position: 'fixed', top: 0, right: 0, bottom: 0, zIndex: 1000,
          display: 'flex', flexDirection: 'column',
          background: 'var(--bg-secondary)',
          borderLeft: '1px solid var(--border-primary)',
          boxShadow: '-8px 0 24px rgba(0,0,0,0.28)',
        }}
      >
        {/* 头部 */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '10px 12px', borderBottom: '1px solid var(--border-primary)',
        }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>🤖 AI 对话</span>
          <Tooltip title={`当前权限：${permInfo.label} —— ${permInfo.description}`}>
            <span
              onClick={onOpenSettings}
              style={{
                fontSize: 10, cursor: 'pointer', padding: '1px 6px', borderRadius: 8,
                color: 'var(--brand-primary)', border: '1px solid var(--brand-primary)',
                opacity: 0.85,
              }}
            >
              {permInfo.short}
            </span>
          </Tooltip>
          <div style={{ flex: 1 }} />
          <Tooltip title="新建对话">
            <Button size="small" type="text" icon={<PlusOutlined />} onClick={newSession} disabled={busy} />
          </Tooltip>
          <Tooltip title="关闭">
            <Button size="small" type="text" icon={<CloseOutlined />} onClick={onClose} />
          </Tooltip>
        </div>

        {/* 会话栏：切会话 / 删会话 */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '6px 12px', borderBottom: '1px solid var(--border-primary)',
        }}>
          <Select
            size="small"
            value={activeId || undefined}
            onChange={switchSession}
            disabled={busy || sessions.length === 0}
            placeholder="选择会话"
            style={{ flex: 1, minWidth: 0 }}
            options={sessions.map((s) => ({
              value: s.id,
              label: s.title,
            }))}
          />
          <Popconfirm
            title="删除这个会话？"
            description="聊天记录会被永久删除，不能撤销。"
            okText="删除"
            cancelText="取消"
            onConfirm={deleteSession}
          >
            <Tooltip title={sessions.length <= 1 ? '至少要保留一个会话' : '删除当前会话'}>
              <Button size="small" type="text" danger icon={<DeleteOutlined />} disabled={busy || sessions.length <= 1} />
            </Tooltip>
          </Popconfirm>
        </div>

        {/* 消息区 */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {!configured && (
            <div style={{
              fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7,
              border: '1px dashed var(--border-primary)', borderRadius: 8, padding: '10px 12px',
            }}>
              还没有配置 AI 服务商。先去
              <a onClick={onOpenSettings} style={{ color: 'var(--brand-primary)', cursor: 'pointer' }}> AI 设置 </a>
              选一个预设并填入 Key，然后就能在这里用日常语言提问了。
            </div>
          )}

          {items.length === 0 && configured && (
            <div style={{ color: 'var(--text-secondary)', fontSize: 12, lineHeight: 1.8 }}>
              <div style={{ marginBottom: 8 }}>
                直接问就行。涉及具体数字的问题，我会去调工具算，不会凭空编。
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {SUGGESTIONS.map((s) => (
                  <span
                    key={s}
                    onClick={() => void send(s)}
                    style={{
                      cursor: 'pointer', fontSize: 11, padding: '3px 8px', borderRadius: 10,
                      border: '1px solid var(--border-primary)', color: 'var(--text-secondary)',
                    }}
                  >
                    {s}
                  </span>
                ))}
              </div>
            </div>
          )}

          {items.map((it) => {
            if (it.kind === 'user') {
              return (
                <div key={it.id} style={{ alignSelf: 'flex-end', maxWidth: '85%' }}>
                  <div style={{
                    background: 'var(--brand-primary)', color: '#fff',
                    padding: '7px 11px', borderRadius: '12px 12px 2px 12px',
                    fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  }}>
                    {it.text}
                  </div>
                </div>
              );
            }
            if (it.kind === 'assistant') {
              return (
                <div key={it.id} style={{ fontSize: 13, color: 'var(--text-primary)', wordBreak: 'break-word' }}>
                  <Markdown text={it.text} />
                </div>
              );
            }
            if (it.kind === 'error') {
              return (
                <div key={it.id} style={{
                  fontSize: 12, lineHeight: 1.6, color: 'var(--text-primary)',
                  background: 'rgba(220,80,80,0.12)', border: '1px solid rgba(220,80,80,0.35)',
                  borderRadius: 8, padding: '8px 10px',
                }}>
                  ⚠️ {it.text}
                </div>
              );
            }
            // 工具卡片
            const ok = it.run.ok;
            return (
              <div key={it.id} style={{
                border: '1px solid var(--border-primary)', borderRadius: 8,
                background: 'var(--bg-tertiary)', padding: '8px 10px', fontSize: 12,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span>{it.running ? '⏳' : ok ? '✅' : '⚠️'}</span>
                  <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{it.run.title}</span>
                  {!it.running && it.run.durationMs > 0 && (
                    <span style={{ color: 'var(--text-muted)', fontSize: 10, marginLeft: 'auto' }}>
                      {(it.run.durationMs / 1000).toFixed(1)}s
                    </span>
                  )}
                </div>
                <div style={{ color: 'var(--text-secondary)', marginTop: 3, lineHeight: 1.6 }}>
                  {it.run.summary}
                </div>
                {!it.running && it.run.output != null && (
                  <details style={{ marginTop: 4 }}>
                    <summary style={{ cursor: 'pointer', fontSize: 10, color: 'var(--text-muted)' }}>
                      查看原始结果
                    </summary>
                    <pre style={{
                      margin: '6px 0 0', maxHeight: 260, overflow: 'auto',
                      fontSize: 10, lineHeight: 1.5, color: 'var(--text-secondary)',
                      background: 'var(--bg-secondary)', padding: 8, borderRadius: 6,
                    }}>
                      {JSON.stringify(it.run.output, null, 2)}
                    </pre>
                  </details>
                )}
              </div>
            );
          })}

          {/* 流式区：思考与正文分开显示，否则长任务看起来像卡死 */}
          {busy && (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
              {streamReasoning && !streamText && (
                <details open>
                  <summary style={{ cursor: 'pointer', fontSize: 10, color: 'var(--text-muted)' }}>
                    思考中…
                  </summary>
                  <div style={{
                    marginTop: 4, whiteSpace: 'pre-wrap', opacity: 0.75,
                    maxHeight: 160, overflow: 'auto', fontSize: 11,
                  }}>
                    {streamReasoning}
                  </div>
                </details>
              )}
              {streamText && (
                <div style={{ color: 'var(--text-primary)', wordBreak: 'break-word' }}>
                  <Markdown text={streamText} />
                </div>
              )}
              {!streamReasoning && !streamText && (
                <span style={{ opacity: 0.7 }}>思考中…</span>
              )}
            </div>
          )}

          <div ref={listEndRef} />
        </div>

        {/* 输入区 */}
        <div style={{ padding: 10, borderTop: '1px solid var(--border-primary)' }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="问点什么…（Enter 发送，Shift+Enter 换行）"
            rows={2}
            style={{
              width: '100%', resize: 'none', boxSizing: 'border-box',
              background: 'var(--bg-tertiary)', color: 'var(--text-primary)',
              border: '1px solid var(--border-primary)', borderRadius: 8,
              padding: '7px 9px', fontSize: 13, lineHeight: 1.6, outline: 'none',
              fontFamily: 'inherit',
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
            <span style={{ fontSize: 10, color: 'var(--text-muted)', flex: 1 }}>
              {permInfo.short}模式 · 数字由本地工具计算
            </span>
            {busy ? (
              <Button size="small" danger icon={<StopOutlined />} onClick={stop}>停止</Button>
            ) : (
              <Button
                size="small"
                type="primary"
                icon={<SendOutlined />}
                onClick={() => void send(input)}
                disabled={!input.trim()}
              >
                发送
              </Button>
            )}
          </div>
        </div>
      </aside>
    </>
  );
};

export default AIChatDrawer;
