/**
 * features/ai-analysis/chat-agent — 对话窗口的调度循环
 *
 * 一轮用户输入可能触发 N 次工具调用：
 *   模型说「我要调 taste」→ 本地执行 skill → 把结果塞回去 → 模型再决定
 *   继续说、再调一个、还是收尾。
 *
 * 全部设计都围绕一个前提：**模型的输出不可信**。
 *   - 工具名对不上 → 不猜，作为工具错误回给模型让它自己修正
 *   - 参数不合法 → 不让 skill 跑，同上
 *   - 参数里塞了白名单外的字段（比如 score）→ 直接丢掉，skill 内部重算
 *   - 硬性轮数上限 → 模型可能陷进「反复调用同一个工具」，不能让它一直烧钱
 *
 * 这里不发任何请求细节的封装，只做编排：单次调用仍走 llm-service 的 aiChat，
 * 所以重试 / 超时 / 取消 / 用量记账全部复用已有逻辑。
 */

import type { AnimeEntry } from '../../src/types';
import type { AIPermission } from '../../core/ai-permission';
import { canAIPropose } from '../../core/ai-permission';
import type { AIToolSpec, AIToolCall } from '../../core/ai-tools';
import { parseToolArguments, pickAllowedArgs } from '../../core/ai-tools';
import type { AIRun } from './ai-runtime';
import { aiChat, AIError } from './llm-service';
import type { AIMessage } from './llm-service';
import { getSkillsFor, toToolSpecs } from './skill-registry';
import type { AISkill, AnyAISkill } from './skill-registry';

/** 一条对话记录。除模型字段外，UI 需要的那点信息也放这里，便于整段持久化 */
export interface ChatRecord extends AIMessage {
  /**
   * role='tool' 时记录这次执行的结果摘要。
   * 刻意**不存 output 本体** —— 会话要落 localStorage，30 个会话每个都背一份完整
   * 技能输出会很快撑爆配额。原始结果本来就序列化在 content 里，切回会话时再解析回来。
   */
  toolMeta?: { skillId: string; title: string; ok: boolean; summary: string; durationMs: number };
  /** 写入时间，UI 排序/显示用 */
  at?: number;
}

export interface ToolRun {
  skillId: string;
  title: string;
  ok: boolean;
  /** 一句话结果，用于卡片折叠态 */
  summary: string;
  /** 完整输出，卡片展开时用 */
  output?: unknown;
  error?: string;
  /** 本次调用耗时 */
  durationMs: number;
}

export type AgentEvent =
  | { type: 'assistant'; text: string }
  | { type: 'tool-start'; skillId: string; title: string; args: Record<string, unknown> }
  | { type: 'tool-done'; toolRun: ToolRun }
  | { type: 'round'; round: number }
  | { type: 'final'; text: string; rounds: number };

export interface ChatAgentOptions {
  list: AnimeEntry[];
  /** 之前的对话（不含本轮用户输入） */
  history: ChatRecord[];
  userText: string;
  run: AIRun;
  permission: AIPermission;
  signal?: AbortSignal;
  /** 是否把思考过程流式推出去（监听器由调用方挂在 run 上） */
  stream?: boolean;
  /** 工具调用最多几轮，默认 4。模型陷进循环时靠它止损 */
  maxRounds?: number;
  /**
   * 只允许这些能力（默认按权限取全部）。
   * 传入的集合仍会再过一遍权限 —— 它可以「缩小」，但不能越过三档权限「扩大」。
   */
  skills?: AnyAISkill[];
  onEvent?: (e: AgentEvent) => void;
}

export interface ChatAgentResult {
  /** 模型的最终回复 */
  text: string;
  /** 完整的对话记录（含工具往返），可直接存进会话继续聊 */
  messages: ChatRecord[];
  /** 实际用了几轮 */
  rounds: number;
  /** 本轮执行过的能力 */
  toolRuns: ToolRun[];
}

/** 工具名 → skill：`toToolSpecs` 把 id 的 `-` 换成了 `_`，这里要能换回来 */
function toolNameOf(skillId: string): string {
  return skillId.replace(/-/g, '_');
}

/**
 * 工具结果回传给模型时的体积上限。
 * 推荐结果这类对象可能有几十 KB，全塞回去既贵又容易把上下文挤爆；
 * 超限就截断并明确告诉模型「被截断了」，避免它以为数据就这么点。
 */
const MAX_TOOL_RESULT_CHARS = 8000;

function serializeToolResult(output: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(output ?? null);
  } catch {
    return '{"error":"结果无法序列化"}';
  }
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}…（结果过长已截断，共 ${text.length} 字符）`;
}

/** 给模型看的能力清单 + 数据概况。只给概览，具体数字一律靠工具取 */
function buildSystemPrompt(list: AnimeEntry[], skills: readonly AnyAISkill[]): string {
  const scored = list.filter((a) => a.scores.some((s) => s.score > 0)).length;
  const tagCount: Record<string, number> = {};
  for (const a of list) for (const t of a.tags) tagCount[t.name] = (tagCount[t.name] || 0) + 1;
  const topTags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([n, c]) => `${n}(${c})`).join('、');

  const skillLines = skills.map((s) => `- ${toolNameOf(s.id)}：${s.description}`).join('\n');

  return [
    '你是 AnimeDiary 里的番剧助手，帮用户解读他自己的评分数据。',
    '',
    '【重要】凡是涉及具体统计、排名、分数、偏差的问题，必须调用工具拿真实数据，绝不自己编。',
    '工具返回的是真实结果，直接引用其中的数字与作品名。',
    '',
    `【数据概况】共 ${list.length} 部，其中 ${scored} 部有评分。高频标签：${topTags || '（无）'}`,
    '',
    '【可用能力】',
    skillLines,
    '',
    '回答用简体中文。用 Markdown 组织（小标题、列表、必要时表格），但别堆砌——窄栏里长篇大论很难读。',
    '工具已经给过结论时不要再重复调用同一个工具。',
    // 每个工具只能处理一部番；用户要「给所有番打标签」这类批量任务时，
    // 逐部调用会白跑几十轮还做不完 —— 直接告诉他去用专门的批量入口
    '如果用户要的是一批番剧（「所有」「每一部」「全部看完的」），不要逐部调用工具：'
      + '说明这需要批量处理，请他用侧栏「AI 分析 → 🏷 批量打标签」。',
  ].join('\n');
}

/** 把历史记录转成模型能接受的形状（保留工具往返，否则模型会重复调用） */
function toModelMessages(history: ChatRecord[]): AIMessage[] {
  return history.map((m) => {
    const msg: AIMessage = { role: m.role, content: m.content ?? '' };
    if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) msg.tool_calls = m.tool_calls;
    if (typeof m.tool_call_id === 'string') msg.tool_call_id = m.tool_call_id;
    return msg;
  });
}

/** 执行一次工具调用，任何异常都转成工具错误回给模型，不让对话中断 */
async function executeToolCall(
  call: AIToolCall,
  skill: AnyAISkill | undefined,
  opts: ChatAgentOptions,
): Promise<ToolRun> {
  const startedAt = Date.now();

  const fail = (error: string): ToolRun => ({
    skillId: skill?.id || call.name,
    title: skill?.title || call.name,
    ok: false,
    summary: error,
    error,
    durationMs: Date.now() - startedAt,
  });

  if (!skill) {
    return fail(`没有这个能力：${call.name}。可用的是：${getSkillsFor(opts.permission).map((s) => toolNameOf(s.id)).join('、')}`);  }

  const parsed = parseToolArguments(call.arguments);
  if (!parsed.ok) return fail(parsed.error);

  // 白名单过滤：模型塞进来的额外字段一律丢掉（这正是「模型碰不到数字」的落点）
  const args = pickAllowedArgs(parsed.value, skill.modelInputs);
  opts.onEvent?.({ type: 'tool-start', skillId: skill.id, title: skill.title, args });

  try {
    const output = await (skill as AISkill).run(args, {
      list: opts.list,
      signal: opts.signal,
      run: opts.run,
      stream: opts.stream,
    });
    const summary = skill.summarize ? skill.summarize(output) : '';
    const run: ToolRun = {
      skillId: skill.id,
      title: skill.title,
      ok: true,
      summary: summary || '完成',
      output,
      durationMs: Date.now() - startedAt,
    };
    opts.onEvent?.({ type: 'tool-done', toolRun: run });
    return run;
  } catch (e) {
    if (e instanceof AIError && e.code === 'aborted') throw e;
    const msg = e instanceof Error ? e.message : String(e);
    const run: ToolRun = {
      skillId: skill.id,
      title: skill.title,
      ok: false,
      summary: msg,
      error: msg,
      durationMs: Date.now() - startedAt,
    };
    opts.onEvent?.({ type: 'tool-done', toolRun: run });
    return run;
  }
}

/**
 * 跑一轮完整对话（可能包含多次工具调用）。
 * 返回时 `messages` 已经包含本轮全部往返，调用方直接接在历史后面即可。
 */
export async function runChatAgent(opts: ChatAgentOptions): Promise<ChatAgentResult> {
  // 传了 skills 就当作「允许的候选」，但仍受权限约束：只能缩小范围，不能扩大权限
  const skills = (opts.skills ?? getSkillsFor(opts.permission))
    .filter((s) => s.effect === 'read' || canAIPropose(opts.permission));
  const byToolName = new Map(skills.map((s) => [toolNameOf(s.id), s]));
  const toolSpecs: AIToolSpec[] = toToolSpecs(skills);
  const maxRounds = Math.max(1, opts.maxRounds ?? 4);

  const messages: AIMessage[] = [
    { role: 'system', content: buildSystemPrompt(opts.list, skills) },
    ...toModelMessages(opts.history),
    { role: 'user', content: opts.userText },
  ];

  const records: ChatRecord[] = [...opts.history, { role: 'user', content: opts.userText, at: Date.now() }];
  const toolRuns: ToolRun[] = [];
  let callSeq = 0;

  for (let round = 1; round <= maxRounds; round++) {
    opts.onEvent?.({ type: 'round', round });

    const result = await aiChat(messages, {
      run: opts.run,
      signal: opts.signal,
      stream: opts.stream,
      tools: toolSpecs,
      toolChoice: 'auto',
      purpose: 'chat',
    });

    if (result.text.trim()) opts.onEvent?.({ type: 'assistant', text: result.text });

    const calls = result.toolCalls || [];
    if (calls.length === 0) {
      records.push({ role: 'assistant', content: result.text, at: Date.now() });
      opts.onEvent?.({ type: 'final', text: result.text, rounds: round });
      return { text: result.text, messages: records, rounds: round, toolRuns };
    }

    // 回传时必须带 tool_calls，否则模型会以为上次调用没发生，于是反复调
    const normalizedCalls = calls.map((c) => {
      callSeq += 1;
      return { ...c, id: c.id || `call_${round}_${callSeq}` };
    });

    messages.push({
      role: 'assistant',
      content: result.text || '',
      tool_calls: normalizedCalls.map((c) => ({
        id: c.id,
        type: 'function' as const,
        function: { name: c.name, arguments: c.arguments },
      })),
    });
    records.push({
      role: 'assistant',
      content: result.text || '',
      tool_calls: messages[messages.length - 1].tool_calls,
      at: Date.now(),
    });

    // 并行执行同一轮里的多个调用（模型可以一次要多个结果）
    const roundRuns = await Promise.all(
      normalizedCalls.map((call) => executeToolCall(call, byToolName.get(call.name), opts)),
    );

    for (let i = 0; i < roundRuns.length; i++) {
      const run = roundRuns[i];
      toolRuns.push(run);
      const call = normalizedCalls[i];
      const payload = run.ok
        ? serializeToolResult(run.output)
        : JSON.stringify({ error: run.error });
      messages.push({ role: 'tool', content: payload, tool_call_id: call.id });
      records.push({
        role: 'tool',
        content: payload,
        tool_call_id: call.id,
        toolMeta: {
          skillId: run.skillId,
          title: run.title,
          ok: run.ok,
          summary: run.summary,
          durationMs: run.durationMs,
        },
        at: Date.now(),
      });
    }
  }

  throw new AIError(
    'bad_format',
    `模型连续 ${maxRounds} 轮都在调用工具，已停止。`
    + '换个说法再问，或直接说「用 X 分析」。'
    + '**批量操作**（例如给所有番剧打标签）不要在这里逐部跑，'
    + '用侧栏「🤖 AI 分析 → 🏷 批量打标签」，它支持并发、进度和一次成批写回。',
  );
}
