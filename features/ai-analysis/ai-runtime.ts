/**
 * features/ai-analysis/ai-runtime — 一次「分析运行」的用量与流式输出收集器
 *
 * 为什么用模块级收集器而不是给每个 Skill 改返回值：
 *   一次分析可能是 1 次调用（品味分析），也可能是 N+1 次（深度偏好画像）。
 *   让 UI 逐层接收 usage / 流式片段会把 6 个 Skill 的函数签名全部污染一遍。
 *   这里开一个「当前运行」的篮子：
 *     beginAIRun()  → 清零
 *     Skill 内部自动 record()
 *     UI 结束前 getAIRunSummary() → 总 token / 真实费用 / 调用次数 / 思考片段
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

type StreamListener = (chunk: { kind: 'reasoning' | 'text'; text: string }) => void;

let summary: AIRunSummary = emptySummary();
let listener: StreamListener | null = null;

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

export function beginAIRun(): void {
  summary = emptySummary();
}

export function recordAICall(meta: AICallMeta): void {
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
}

export function getAIRunSummary(): AIRunSummary {
  return { ...summary, models: [...summary.models], purposes: [...summary.purposes] };
}

/** 设置当前运行的流式输出回调（null = 关闭） */
export function setAIStreamListener(next: StreamListener | null): void {
  listener = next;
}

export function emitAIStream(kind: 'reasoning' | 'text', text: string): void {
  if (!text) return;
  try { listener?.({ kind, text }); } catch { /* UI 自己的异常不该影响分析 */ }
}
