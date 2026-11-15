/**
 * plugins/watch-analysis/core/budget 单测
 *
 * 预算不对会直接导致两种事故：
 *   1. 少算 → 超支（用户看到 200 万，实际花了 300 万）
 *   2. 多算 → 明明还有额度却熔断（分析半途停掉）
 * 所以这里把「预占 / 结算 / 撤销 / 熔断」四条路径逐一钉死。
 */
import { describe, it, expect } from 'vitest'
import { createBudget } from '../../../plugins/watch-analysis/core/budget'

describe('createBudget', () => {
  it('默认上限是 200 万 token', () => {
    const b = createBudget()
    expect(b.ledger.limit).toBe(2_000_000)
    expect(b.ledger.spent).toBe(0)
    expect(b.ledger.reserved).toBe(0)
    expect(b.exhausted()).toBe(false)
  })

  it('预占会让 canSpend 立刻看到额度被占住', () => {
    const b = createBudget({ limit: 1000 })
    expect(b.canSpend(800)).toBe(true)
    expect(b.reserve(800, 'vision')).toBe(true)
    expect(b.ledger.reserved).toBe(800)
    // 还能花 200，但不能再花 300
    expect(b.canSpend(200)).toBe(true)
    expect(b.canSpend(300)).toBe(false)
  })

  it('并发场景不超卖：两笔 600 不能都通过 1000 的上限', () => {
    const b = createBudget({ limit: 1000 })
    expect(b.reserve(600, 'vision')).toBe(true)
    expect(b.reserve(600, 'vision')).toBe(false)
    expect(b.ledger.reserved).toBe(600)
  })

  it('结算用实际用量入账，并释放该 kind 的预占', () => {
    const b = createBudget({ limit: 10_000 })
    b.reserve(1000, 'vision')
    b.record('vision', 1200)
    expect(b.ledger.spent).toBe(1200)
    expect(b.ledger.reserved).toBe(0)
    expect(b.ledger.byKind.vision).toBe(1200)
  })

  it('结算量小于预占时，多占的额度必须还回来', () => {
    const b = createBudget({ limit: 10_000 })
    b.reserve(5000, 'vision')
    b.record('vision', 100)
    expect(b.ledger.reserved).toBe(0)
    // 5000 预占释放后，能继续花满剩下的额度
    expect(b.canSpend(9_800)).toBe(true)
  })

  it('调用失败可以用 release 撤销预占，且不影响已花', () => {
    const b = createBudget({ limit: 10_000 })
    b.record('vision', 500)
    b.reserve(3000, 'vision')
    b.release(3000, 'vision')
    expect(b.ledger.reserved).toBe(0)
    expect(b.ledger.spent).toBe(500)
  })

  it('release 不会把 reserved 扣成负数', () => {
    const b = createBudget({ limit: 10_000 })
    b.release(9999)
    expect(b.ledger.reserved).toBe(0)
  })

  it('花满即熔断，但已记录的数据仍然可读', () => {
    const b = createBudget({ limit: 1000 })
    b.record('vision', 1000)
    expect(b.exhausted()).toBe(true)
    expect(b.canSpend(1)).toBe(false)
    // 熔断是"停止发起"，不是"清空账本"
    expect(b.ledger.spent).toBe(1000)
    expect(b.ledger.byKind.vision).toBe(1000)
  })

  it('预占本身不改变 spent，只改变 exhausted 的判断', () => {
    const b = createBudget({ limit: 1000 })
    b.reserve(1000, 'vision')
    expect(b.ledger.spent).toBe(0)
    expect(b.exhausted()).toBe(true)
  })

  it('snapshot 是深拷贝，改返回值不会污染内部状态', () => {
    const b = createBudget({ limit: 1000 })
    b.record('vision', 100)
    const snap = b.snapshot()
    snap.spent = 999_999
    snap.byKind.vision = 888_888
    expect(b.ledger.spent).toBe(100)
    expect(b.ledger.byKind.vision).toBe(100)
  })

  it('负数 / NaN 用量按 0 处理，不会把账算崩', () => {
    const b = createBudget({ limit: 1000 })
    b.record('vision', -50)
    b.record('vision', Number.NaN)
    expect(b.ledger.spent).toBe(0)
    expect(b.canSpend(1000)).toBe(true)
  })

  it('可以从已有用量恢复（续跑中断任务）', () => {
    const b = createBudget({ limit: 2_000_000, spent: 1_500_000 })
    expect(b.ledger.spent).toBe(1_500_000)
    expect(b.canSpend(400_000)).toBe(true)
    expect(b.canSpend(600_000)).toBe(false)
  })
})
