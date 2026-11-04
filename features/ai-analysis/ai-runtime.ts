/**
 * features/ai-analysis/ai-runtime — 一次「分析运行」的用量与流式输出收集器
 *
 * 为什么用模块级收集器而不是给每个 Skill 改返回值：
 *   一次分析可能是 1 次调用（品味分析），也可能是 N+1 次（深度偏好画像）。
 *   让 UI 逐层接收 usage / 流式片段会把 6 个 Skill 的函数签名全部污染一遍。
 *   这里开一个「当前运行」的篮子：
 *     run.begin()  → 清零
 *     Skill 内部自动 record()
 *     UI 结束前 run.summary() → 总 token / 真实费用 / 调用次数 / 思考片段
 *
 * 为什么现在是「实例」而不是全局单例：
 *   单例只在「同一时刻只有一次分析」时成立。一旦对话窗口里可以同时开两个会话、
 *   或者「聊天 + 后台跑一次偏好画像」并行，两边的 token 会记到同一个篮子里、
 *   流式片段会串到另一个画面 —— 而且这种串账是静默的，事后根本查不出来。
 *   所以这里改成 createAIRun() 返回独立实例，按调用方（会话/面板）各持一个。
 *
 * 兼容：仍然导出一组模块级函数（beginAIRun / recordAICall / ...），它们操作的是
 * 一个默认实例。现有 UI 与测试不用改一行就能继续跑；要隔离的地方显式传 run 即可。
 */

import type { AIUsage } from './llm-service';

export interface AICallMeta {
  provider: string;
  model: string;
  usage: AIUsage;
  latencyMs: number;
  attempts: number;
  purpose?: string;
  truncated?: boolean;
}

export interface AIRunSummary {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  /** 网关直接返回费用时（OpenCode）为真实值，否则 undefined */
  cost?: number;
  latencyMs: number;
  models: string[];
  retries: number;
  /** 最近一次调用的用途，便于说明"钱花在哪" */
  purposes: string[];
}

export type AIStreamListener = (chunk: { kind: 'reasoning' | 'text'; text: string }) => void;

export interface AIRun {
  /** 实例标识，仅用于排查串账 */
  readonly id: string;
  /** 开一次新运行：清零用量与流式片段 */
  begin(): void;
  /** 记录一次模型调用（Skill 内部自动调用，UI 不用管） */
  record(meta: AICallMeta): void;
  /** 取当前运行的汇总（返回副本，调用方改不坏内部状态） */
  summary(): AIRunSummary;
  /** 设置流式输出回调（null = 关闭） */
  setListener(next: AIStreamListener | null): void;
  /** 推一段流式内容；没有监听者时是空操作 */
  emit(kind: 'reasoning' | 'text', text: string): void;
}

function emptySummary(): AIRunSummary {
  return {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    cost: undefined,
    latencyMs: 0,
    models: [],
    retries: 0,
    purposes: [],
  };
}

let runSeq = 0;

/**
 * 开一个独立的运行篮子。
 * 调用方负责持有它并把同一个实例传给本次运行里的所有调用 ——
 * 传错了就会串账，所以宁可每个 UI 面板/会话各建一个。
 */
export function createAIRun(label = 'run'): AIRun {
  runSeq += 1;
  const id = `${label}-${runSeq}`;
  let summary = emptySummary();
  let listener: AIStreamListener | null = null;

  return {
    id,

    begin() {
      summary = emptySummary();
    },

    record(meta) {
      summary.calls += 1;
      summary.promptTokens += meta.usage.promptTokens;
      summary.completionTokens += meta.usage.completionTokens;
      summary.reasoningTokens += meta.usage.reasoningTokens;
      summary.totalTokens += meta.usage.totalTokens;
      if (typeof meta.usage.cost === 'number') {
        summary.cost = (summary.cost || 0) + meta.usage.cost;
      }
      summary.latencyMs += meta.latencyMs;
      summary.retries += Math.max(0, (meta.attempts || 1) - 1);
      if (meta.model && !summary.models.includes(meta.model)) summary.models.push(meta.model);
      if (meta.purpose && !summary.purposes.includes(meta.purpose)) summary.purposes.push(meta.purpose);
    },

    summary() {
      return { ...summary, models: [...summary.models], purposes: [...summary.purposes] };
    },

    setListener(next) {
      listener = next;
    },

    emit(kind, text) {
      if (!text) return;
      try { listener?.({ kind, text }); } catch { /* UI 自己的异常不该影响分析 */ }
    },
  };
}

/**
 * 默认运行实例。
 * 所有没显式传 run 的调用都落到它身上 —— 这也正是旧代码的行为，
 * 所以「只有一个面板在跑分析」时，新老实现完全等价。
 */
export const defaultAIRun: AIRun = createAIRun('default');

// ── 兼容旧调用点：操作的都是 defaultAIRun ──
// 只有 UI 在用这三个；llm-service 内部已改为直接用传入的 run 实例
//（recordAICall / emitAIStream 因此在重构后成了死代码，一并删掉）。

export function beginAIRun(): void {
  defaultAIRun.begin();
}

export function getAIRunSummary(): AIRunSummary {
  return defaultAIRun.summary();
}

/** 设置当前运行的流式输出回调（null = 关闭） */
export function setAIStreamListener(next: AIStreamListener | null): void {
  defaultAIRun.setListener(next);
}
