/**
 * core/ai-permission — AI 写操作的三档权限（服务端与浏览器共用）
 *
 * 这不是一个 UI 偏好，而是「AI 会不会替你改数据」的边界，所以三档的语义必须泾渭分明：
 *
 *   read    只读。AI 只能出分析结果，任何改动都得你亲手点。
 *   confirm 默认。AI 可以**提议**改动，但要你确认才落库；提议必须带改动前后对比。
 *   write   AI 可以直接落库。仍然写审计日志，并保留一次撤销。
 *
 * 为什么默认是 confirm 而不是 read：
 *   现有 autoTag 的流程本来就是「模型给建议 → 你逐条点采纳」，confirm 正好描述它，
 *   定成默认不改变任何现有行为；而定成 read 会让已有的建议流看起来被禁用了。
 *   反过来，把 default 定成 write 则会让「AI 悄悄改数据」成为默认——不能这么干。
 */

export type AIPermission = 'read' | 'confirm' | 'write';

export const AI_PERMISSION_VALUES: readonly AIPermission[] = ['read', 'confirm', 'write'];

export interface AIPermissionInfo {
  /** 设置界面上的完整名称 */
  label: string;
  /** 标签/徽章用的短名 */
  short: string;
  /** 一句话解释这一档到底限制了什么 */
  description: string;
  /** AI 能否发起改动（哪怕还需要确认） */
  canPropose: boolean;
  /** AI 能否不经确认直接落库 */
  canAutoApply: boolean;
}

export const AI_PERMISSION_INFO: Record<AIPermission, AIPermissionInfo> = {
  read: {
    label: '只读',
    short: '只读',
    description: 'AI 只出分析和建议，不会改动任何数据。采纳建议需要你亲手点。',
    canPropose: false,
    canAutoApply: false,
  },
  confirm: {
    label: '提议后确认',
    short: '确认',
    description: 'AI 可以先做出改动提议（附带改动前后对比），你点确认才写进数据。',
    canPropose: true,
    canAutoApply: false,
  },
  write: {
    label: '直接写入',
    short: '直写',
    description: 'AI 判断后直接改数据，不逐条确认。每次写入都会记审计日志，并保留一次撤销。',
    canPropose: true,
    canAutoApply: true,
  },
};

/**
 * 把任意来源的值收敛成合法档位。
 * 配置可能来自手改的 JSON、旧版本文件或环境变量，一律按 confirm 兜底 ——
 * 这是唯一「既不禁用功能、又不会悄悄写数据」的选择。
 */
export function normalizeAIPermission(value: unknown): AIPermission {
  return value === 'read' || value === 'write' ? value : 'confirm';
}

/** AI 能否发起改动（read 下连提议都不该产生，避免给用户看到点了也没用的东西） */
export function canAIPropose(permission: AIPermission): boolean {
  return AI_PERMISSION_INFO[permission].canPropose;
}

/** AI 能否跳过确认直接落库 */
export function canAIAutoApply(permission: AIPermission): boolean {
  return AI_PERMISSION_INFO[permission].canAutoApply;
}
