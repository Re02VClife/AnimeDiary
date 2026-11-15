/**
 * core/budget — 单集 token 预算
 *
 * 纯逻辑，零 IO，可直接单测。这是「200 万/集」这个约束唯一实现的地方。
 *
 * 三条设计决定：
 *
 * 1) **reserve 先占、record 后结算**。并发发图时不预占就会超卖 ——
 *    两个请求同时看到「还剩 1000」，各自花 800，结算时才发现超了 600。
 *    预占让「能不能花」变成一次同步判断。
 *
 * 2) **超限不再抛错，只置 exhausted**。抛错会中断整个分析流水线，
 *    而用户更希望「图看完了、报告写了一半」被保留下来，而不是全丢。
 *    上层看到 exhausted 就停止发起新调用，把已有结果交出去。
 *
 * 3) **口径是 totalTokens（含 prompt + completion）**。图片 token 算在 prompt 里，
 *    所以这个口径自然覆盖了"看图的成本"。reasoning token 已经含在 completion 里，
 *    不重复计 —— 只信网关返回的 total，不自己加。
 */
import type { BudgetLedger } from './types'

export interface BudgetOptions {
  /** 上限，单位 token。默认 200 万 */
  limit?: number
  /** 初始已花（恢复中断任务时用） */
  spent?: number
}

export interface Budget {
  /** 只读快照，给 UI 和落盘用 */
  readonly ledger: BudgetLedger
  /** 还能不能花 n 个 token（已考虑 reserved） */
  canSpend(n: number): boolean
  /** 预占；返回 false 表示额度不够，调用方**必须**放弃这次调用 */
  reserve(n: number, kind: string): boolean
  /** 结算：把该 kind 的预占转成实花。usage 里的数字是权威值，预占只是估算 */
  record(kind: string, totalTokens: number): void
  /** 撤销预占（调用失败、图没发出去） */
  release(n: number, kind?: string): void
  /** 是否已经熔断 */
  exhausted(): boolean
  /** 落盘快照（深拷贝，调用方改不坏内部状态） */
  snapshot(): BudgetLedger
}

const DEFAULT_LIMIT = 2_000_000

export function createBudget(opts: BudgetOptions = {}): Budget {
  const limit = Math.max(0, Math.floor(opts.limit ?? DEFAULT_LIMIT))
  const byKind: Record<string, number> = {}
  /** 每个 kind 当前还没结算的预占量 */
  const pending: Record<string, number> = {}
  let spent = Math.max(0, Math.floor(opts.spent ?? 0))
  let reserved = 0

  function snapshot(): BudgetLedger {
    return {
      limit,
      spent,
      byKind: { ...byKind },
      reserved,
      // 用 >= 而不是 >：预占把上限占满时，下一个 token 也花不出去了，
      // 那一刻就该算熔断。用 > 会让 UI 显示"未熔断"却调谁都失败。
      exhausted: spent + reserved >= limit,
    }
  }

  return {
    get ledger() {
      return snapshot()
    },

    canSpend(n: number) {
      if (!Number.isFinite(n) || n <= 0) return true
      return spent + reserved + n <= limit
    },

    reserve(n: number, kind: string) {
      if (!Number.isFinite(n) || n <= 0) return true
      const amount = Math.floor(n)
      if (spent + reserved + amount > limit) return false
      reserved += amount
      pending[kind] = (pending[kind] ?? 0) + amount
      return true
    },

    record(kind: string, totalTokens: number) {
      const amount = Number.isFinite(totalTokens) && totalTokens > 0 ? Math.floor(totalTokens) : 0
      spent += amount
      byKind[kind] = (byKind[kind] ?? 0) + amount
      // 结算时释放这个 kind 的全部预占：预占只是估算，实际用量以网关返回为准。
      // 不按「上次预占多少」对齐，是因为并发同 kind 调用时那笔账本来就分不清；
      // 按 kind 整体清零既简单又不会吃掉别的 kind 的额度。
      const held = pending[kind] ?? 0
      if (held > 0) {
        const give = Math.min(held, reserved)
        reserved -= give
        delete pending[kind]
      }
    },

    release(n: number, kind?: string) {
      if (!Number.isFinite(n) || n <= 0) return
      const amount = Math.floor(n)
      const give = Math.min(amount, reserved)
      reserved -= give
      if (kind && pending[kind]) {
        pending[kind] = Math.max(0, pending[kind] - give)
        if (pending[kind] === 0) delete pending[kind]
      } else if (!kind) {
        // 没指定 kind 时，从最大的那个预占开始扣，保证总量对得上
        let left = give
        for (const [k, v] of Object.entries(pending)) {
          if (left <= 0) break
          const take = Math.min(v, left)
          pending[k] = v - take
          left -= take
          if (pending[k] === 0) delete pending[k]
        }
      }
    },

    exhausted() {
      return spent + reserved >= limit
    },

    snapshot,
  }
}
