/**
 * core/app-tools — 给 AI 的「应用操作」工具契约
 *
 * 和 core/ai-tools 的区别：
 *   ai-tools 负责「模型给的 JSON 怎么安全解析」（传输层）；
 *   这里负责「AI 能对应用做什么、做完怎么算数」（能力层）。
 *
 * 设计原则与 skill-registry 一致，但多了一条写边界：
 *   1. 参数白名单（modelInputs）仍然生效，模型碰不到统计数字；
 *   2. 写工具必须声明 effect: 'write'，并经过权限档位过滤；
 *   3. 执行位置与协议解耦 —— 现在跑在渲染进程（复用 AnimeContext 的写链路），
 *      将来插件/DSH 接入时可以原样搬到 /api/ai/tools/execute，工具定义不用改。
 *
 * 工具名优先用 `app_` 前缀，避免和只读 skill（taste / auto_tag …）撞名。
 */

import type { AIPermission } from './ai-permission';
import { canAIPropose } from './ai-permission';
import type { AIToolSpec } from './ai-tools';

/** 只读工具任何档位都能用；写工具受三档权限约束 */
export type AppToolEffect = 'read' | 'write';

export interface AppToolSpec {
  /** LLM 工具名：只允许小写字母、数字、下划线 */
  name: string;
  /** 卡片标题（人看的） */
  title: string;
  /** 给模型看的：什么场景该用、会改什么 */
  description: string;
  effect: AppToolEffect;
  /** 模型允许填的字段白名单；不在表里的参数一律丢弃 */
  modelInputs: readonly string[];
  /** 给模型填参的 JSON Schema */
  inputSchema: Record<string, unknown>;
}

/** 工具执行器：收到已过滤的参数，返回可序列化的结果 */
export interface AppToolRuntime {
  spec: AppToolSpec;
  run(args: Record<string, unknown>): Promise<unknown>;
}

/** 当前权限下这个工具能不能被暴露给模型 */
export function canUseAppTool(permission: AIPermission, effect: AppToolEffect): boolean {
  return effect === 'read' ? true : canAIPropose(permission);
}

/**
 * 写工具在 confirm 档要不要逐次弹确认。
 * read 根本不会注册写工具；write 档视为用户已经授权，不再打断。
 */
export function needsApproval(permission: AIPermission, effect: AppToolEffect): boolean {
  return effect === 'write' && permission === 'confirm';
}

/** 把能力定义翻译成网关能吃的工具定义（与 skill 的 toToolSpecs 同一形状） */
export function toAIToolSpec(spec: AppToolSpec): AIToolSpec {
  return {
    type: 'function',
    function: {
      name: spec.name,
      description: spec.description,
      parameters: spec.inputSchema,
    },
  };
}

/** 工具执行失败时抛这个，chat-agent 会把 message 原样回给模型 */
export class AppToolError extends Error {
  constructor(
    public readonly code: 'INVALID_ARGS' | 'NOT_FOUND' | 'AMBIGUOUS' | 'FORBIDDEN' | 'WRITE_FAILED',
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'AppToolError';
  }
}
