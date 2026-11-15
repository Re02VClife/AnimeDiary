/**
 * ui/BudgetBar — 一集拉片分析的 token 预算条
 *
 * 数据只有一个来源：落盘报告里的 `report.budget`（core/types.ts 的 BudgetLedger）。
 * 逐个字段的语义沿 core/budget.ts：
 *   - `spent` 已结算，`reserved` 是已预占未结算，两者都可能让预算见底；
 *   - `byKind` 是**按调用类型**的已结算量（看图 / 写报告 / 台词…），UI 拿它画占比；
 *   - `exhausted` 由服务端算好，UI 不自己造熔断语义 —— 只在展示时补一个
 *     `spent + reserved >= limit` 的兜底（账本快照与 exhausted 不同步时也不至于漏报）。
 *
 * 颜色一律 CSS 变量：正常走 `--brand-primary`，耗尽/超支走 `--color-error`。
 * 本组件不依赖任何全局状态，纯粹是 `ledger` 的展示层。
 */
import type { CSSProperties, FC } from 'react'
import { Progress, Typography } from 'antd'
import type { BudgetLedger } from '../core/types'

export interface BudgetBarProps {
  ledger: BudgetLedger
}

/** 调用类型的中文名。未知 kind 原样显示 —— 将来加新调用类型不用改 UI。 */
const KIND_LABELS: Record<string, string> = {
  vision: '看图',
  analyze: '写报告',
  transcript: '台词',
  music: '配乐',
  motion: '动感',
  cut: '切镜',
  probe: '探测',
  render: '宫格图',
}

function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind
}

/** token 数带千分位。预算动辄几十万，不带分隔符读不动。 */
export function formatTokens(value: number): string {
  const n = Math.max(0, Math.round(value))
  return n.toLocaleString('zh-CN')
}

const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 }

export const BudgetBar: FC<BudgetBarProps> = ({ ledger }) => {
  const limit = Math.max(0, ledger.limit)
  const spent = Math.max(0, ledger.spent)
  const reserved = Math.max(0, ledger.reserved)
  const committed = spent + reserved

  const exhausted = ledger.exhausted || (limit > 0 && committed >= limit)
  const percent = limit > 0 ? Math.min(100, (committed / limit) * 100) : 0
  const accent = exhausted ? 'var(--color-error)' : 'var(--brand-primary)'
  const trail = 'var(--bg-quaternary)'

  const kinds = Object.entries(ledger.byKind)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
  const kindTotal = kinds.reduce((sum, [, v]) => sum + v, 0)
  /** 已结算但没记到任何 kind 上的量（老报告 / 手工恢复的账本可能出现） */
  const unattributed = Math.max(0, spent - kindTotal)

  return (
    <div
      className={exhausted ? 'wa-budget wa-budget--exhausted' : 'wa-budget'}
      data-testid="budget-bar"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: 12,
        borderRadius: 'var(--radius-md)',
        border: `1px solid ${exhausted ? 'var(--color-error)' : 'var(--border-primary)'}`,
        background: 'var(--bg-secondary)',
      }}
    >
      {/* 总览：已用 / 上限 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>预算</span>
        <span style={{ color: 'var(--text-secondary)', fontSize: 12 }} data-testid="budget-total">
          已用 {formatTokens(spent)} / 上限 {formatTokens(limit)}
          {reserved > 0 && `（另有预占 ${formatTokens(reserved)}）`}
        </span>
      </div>

      <div style={rowStyle}>
        <Progress
          percent={percent}
          status={exhausted ? 'exception' : 'normal'}
          strokeColor={accent}
          trailColor={trail}
          showInfo={false}
          size="small"
          style={{ flex: 1, margin: 0 }}
        />
        <span
          style={{
            width: 52,
            textAlign: 'right',
            fontSize: 12,
            fontVariantNumeric: 'tabular-nums',
            color: exhausted ? 'var(--color-error)' : 'var(--text-primary)',
          }}
        >
          {Math.round(percent)}%
        </span>
      </div>

      {exhausted && (
        <Typography.Text strong data-testid="budget-exhausted" style={{ color: 'var(--color-error)' }}>
          预算耗尽
        </Typography.Text>
      )}

      {/* 各 kind 的占比：分母用「已记账总量」，所以一组百分比加起来是 100%
          （未记 kind 的量单独成行，不硬摊到任何一类里） */}
      {kinds.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>各环节占比</span>
          {kinds.map(([kind, value]) => {
            const share = kindTotal > 0 ? (value / kindTotal) * 100 : 0
            return (
              <div key={kind} style={rowStyle} data-testid="budget-kind" data-kind={kind}>
                <span style={{ width: 56, flexShrink: 0, fontSize: 12, color: 'var(--text-secondary)' }}>
                  {kindLabel(kind)}
                </span>
                <Progress
                  percent={Math.min(100, share)}
                  strokeColor={accent}
                  trailColor={trail}
                  showInfo={false}
                  size="small"
                  style={{ flex: 1, margin: 0 }}
                />
                <span
                  style={{
                    width: 108,
                    textAlign: 'right',
                    fontSize: 12,
                    fontVariantNumeric: 'tabular-nums',
                    color: 'var(--text-secondary)',
                  }}
                >
                  {formatTokens(value)} · {Math.round(share)}%
                </span>
              </div>
            )
          })}
          {unattributed > 0 && (
            <div style={rowStyle} data-testid="budget-kind" data-kind="unattributed">
              <span style={{ width: 56, flexShrink: 0, fontSize: 12, color: 'var(--text-secondary)' }}>其它</span>
              <span style={{ flex: 1, fontSize: 12, color: 'var(--text-muted)' }}>未分项</span>
              <span
                style={{
                  width: 108,
                  textAlign: 'right',
                  fontSize: 12,
                  fontVariantNumeric: 'tabular-nums',
                  color: 'var(--text-secondary)',
                }}
              >
                {formatTokens(unattributed)}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default BudgetBar
