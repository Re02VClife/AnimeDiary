/**
 * ui/StoryboardViewer — 一集拉片报告的展示层
 *
 * 三块内容，从上到下：
 *   1. 动感曲线（整集折线，`report.motion.curve` 是 [秒, 变化分][]）
 *   2. 宫格图区（按 `report.sheets` 顺序渲染，点击用 antd Image 自带预览放大）
 *   3. 镜头清单（一行一个镜头；点击行会高亮并滚到它所在的宫格图）
 *
 * 只读组件：不改 report，不请求接口（图片走 sheetUrl 的相对路径）。
 * 报告里的可选块（motion / transcript / cell）缺了就少渲染对应内容，
 * 不用默认值硬编 —— 老报告/降级跑出来的报告本来就可能没有这些。
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import type { CSSProperties, FC } from 'react'
import { Empty, Image, Typography } from 'antd'
import ReactECharts from 'echarts-for-react'
import type { Shot, WatchReport } from '../core/types'
import { sheetUrl } from './api'

export interface StoryboardViewerProps {
  report: WatchReport
}

/** 秒 → `mm:ss.S`（拉片里的时间码口径，精确到 0.1 秒） */
export function formatTimecode(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--.-'
  // 先按 0.1 秒四舍五入，避免 59.96 → `00:60.0` 这种进位错
  const tenths = Math.round(seconds * 10)
  const minutes = Math.floor(tenths / 600)
  const rest = tenths - minutes * 600
  const secs = (rest / 10).toFixed(1).padStart(4, '0')
  return `${String(minutes).padStart(2, '0')}:${secs}`
}

/** 秒 → `61.9s`（时长用绝对秒数更直观，镜头长的能一眼看出） */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  return `${seconds.toFixed(1)}s`
}

interface ShotRow {
  shot: Shot
  /** 该镜头落在哪张宫格图（没有映射时为 null） */
  sheetIndex: number | null
  /** 动感均值（0–255 口径），没有测量时为 null */
  motion: number | null
  /** 与镜头时间重叠的台词，按时间顺序拼成一行 */
  text: string
}

/**
 * 镜头 → 台词。
 *
 * 优先级：
 *   1. `Shot.text` —— Phase 1 的 render adapter 用 storyboard 的 alignCells 直接对齐好的
 *      本格台词（时间上最准，取帧粒度而不是字幕段粒度）；
 *   2. `transcript.segments` 按半开区间 [start, end) 重叠兜底（老报告 / 没跑 align 时）。
 * 字幕常常跨镜头（一句话横跨两次剪辑），两边都带上比一刀切掉更接近实际。
 */
function collectText(
  shot: Shot,
  segments: ReadonlyArray<{ start: number; end: number; text: string }>,
): string {
  const own = shot.text?.trim()
  if (own) return own

  const parts: string[] = []
  for (const seg of segments) {
    if (seg.start >= shot.end) break
    if (seg.end <= shot.start) continue
    const text = seg.text.trim()
    if (text) parts.push(text)
  }
  return parts.join(' ')
}

/** 小动感曲线：整集折线，横轴是时间码，纵轴是逐帧变化分 */
const MotionCurve: FC<{ curve: ReadonlyArray<[number, number]> }> = ({ curve }) => {
  const option = useMemo(
    () => ({
      animation: false,
      grid: { left: 44, right: 16, top: 20, bottom: 26 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'var(--bg-tertiary)',
        borderColor: 'var(--border-primary)',
        textStyle: { color: 'var(--text-primary)', fontSize: 12 },
        formatter: (params: unknown) => {
          const list = Array.isArray(params) ? params : [params]
          const first = list[0] as { data?: [number, number] } | undefined
          const point = first?.data
          if (!Array.isArray(point)) return ''
          return `${formatTimecode(point[0])} · 变化分 ${point[1].toFixed(1)}`
        },
      },
      xAxis: {
        type: 'value',
        min: 0,
        axisLabel: { color: 'var(--text-secondary)', fontSize: 10, formatter: (v: number) => formatTimecode(v) },
        axisLine: { lineStyle: { color: 'var(--border-primary)' } },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: 'var(--text-secondary)', fontSize: 10 },
        axisLine: { show: false },
        splitLine: { lineStyle: { color: 'var(--bg-quaternary)' } },
      },
      series: [
        {
          type: 'line',
          showSymbol: false,
          smooth: true,
          data: curve,
          lineStyle: { color: 'var(--brand-primary)', width: 1.5 },
          areaStyle: { color: 'var(--brand-soft)' },
        },
      ],
    }),
    [curve],
  )

  return (
    <div data-testid="motion-curve" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>动感曲线（整集逐帧变化分）</span>
      <ReactECharts option={option} style={{ height: 120, width: '100%' }} opts={{ renderer: 'svg' }} lazyUpdate />
    </div>
  )
}

const metaStyle: CSSProperties = {
  color: 'var(--text-secondary)',
  fontSize: 12,
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
}

const sepStyle: CSSProperties = { color: 'var(--text-muted)', fontSize: 12 }

export const StoryboardViewer: FC<StoryboardViewerProps> = ({ report }) => {
  const [activeShot, setActiveShot] = useState<number | null>(null)
  const sheetRefs = useRef<Array<HTMLDivElement | null>>([])

  const rows = useMemo<ShotRow[]>(() => {
    // 台词段要先按时间排好，collectText 才能提前 break
    const segments = [...(report.transcript?.segments ?? [])].sort((a, b) => a.start - b.start)
    const perShot = report.motion?.perShot ?? []

    // 镜头 → 宫格图：优先用报告回填的 cell.sheet，没有就翻 Sheet.shots 的反向表
    const sheetByShot = new Map<number, number>()
    report.sheets.forEach((sheet, sheetIndex) => {
      for (const shotIndex of sheet.shots) {
        if (!sheetByShot.has(shotIndex)) sheetByShot.set(shotIndex, sheetIndex)
      }
    })

    return report.shots.map((shot) => {
      const cellSheet = shot.cell?.sheet
      const mapped = typeof cellSheet === 'number' ? cellSheet : sheetByShot.get(shot.i)
      const measured = shot.motion?.mean
      const fromCurve = perShot[shot.i]
      const motion =
        typeof measured === 'number' && Number.isFinite(measured)
          ? measured
          : typeof fromCurve === 'number' && Number.isFinite(fromCurve)
            ? fromCurve
            : null
      return {
        shot,
        sheetIndex: typeof mapped === 'number' ? mapped : null,
        motion,
        text: collectText(shot, segments),
      }
    })
  }, [report])

  const activeSheet = useMemo(() => {
    if (activeShot === null) return -1
    const row = rows.find((r) => r.shot.i === activeShot)
    return row?.sheetIndex ?? -1
  }, [activeShot, rows])

  const handleRowClick = useCallback(
    (shotIndex: number, sheetIndex: number | null) => {
      setActiveShot(shotIndex)
      if (sheetIndex === null) return
      const target = sheetRefs.current[sheetIndex]
      // jsdom 里 Element.scrollIntoView 不存在，测试会走到这里 —— 有就滚，没有就只高亮
      if (target && typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    },
    [],
  )

  const curve = report.motion?.curve
  const hasMotion = Array.isArray(curve) && curve.length > 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {hasMotion && <MotionCurve curve={curve} />}

      {/* ── 宫格图区 ── */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>分镜宫格图</span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            共 {report.sheets.length} 张 · {report.shots.length} 个镜头（点击图片放大）
          </span>
        </div>
        {report.sheets.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="这份报告没有宫格图" />
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
              gap: 12,
            }}
          >
            {report.sheets.map((sheet, index) => (
              <div
                key={sheet.file || index}
                data-sheet-index={index}
                ref={(el) => {
                  sheetRefs.current[index] = el
                }}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  padding: 6,
                  borderRadius: 'var(--radius-md)',
                  border: `2px solid ${activeSheet === index ? 'var(--brand-primary)' : 'var(--border-primary)'}`,
                  background: 'var(--bg-secondary)',
                  overflow: 'hidden',
                }}
              >
                <Image
                  src={sheetUrl(report.key, report.episode, index, sheet.file)}
                  alt={`第 ${index + 1} 张宫格图（${sheet.cells} 格）`}
                  width="100%"
                  style={{ display: 'block', borderRadius: 'var(--radius-sm)' }}
                  preview={{ mask: '查看大图' }}
                />
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  第 {index + 1} 张 · {sheet.cells} 格 · {sheet.width}×{sheet.height}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── 镜头清单 ── */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>镜头清单</span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>点击某一行跳到对应宫格图</span>
        </div>
        {rows.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="这份报告没有镜头数据" />
        ) : (
          rows.map((row) => {
            const active = activeShot === row.shot.i
            return (
              <div
                key={`${row.shot.i}-${row.shot.start}`}
                data-testid="shot-row"
                data-shot-index={row.shot.i}
                role="button"
                tabIndex={0}
                onClick={() => handleRowClick(row.shot.i, row.sheetIndex)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    handleRowClick(row.shot.i, row.sheetIndex)
                  }
                }}
                className={active ? 'wa-shot-row wa-shot-row--active' : 'wa-shot-row'}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 10px',
                  borderRadius: 'var(--radius-sm)',
                  borderLeft: `2px solid ${active ? 'var(--brand-primary)' : 'transparent'}`,
                  background: active ? 'var(--bg-quaternary)' : 'transparent',
                  cursor: 'pointer',
                }}
              >
                <span style={{ ...metaStyle, color: 'var(--text-primary)', fontWeight: 600, minWidth: 44 }}>
                  #{row.shot.i + 1}
                </span>
                <span style={sepStyle}>·</span>
                <span style={{ ...metaStyle, fontFamily: 'var(--font-mono)' }}>
                  {formatTimecode(row.shot.start)} → {formatTimecode(row.shot.end)}
                </span>
                <span style={sepStyle}>·</span>
                <span style={metaStyle}>{formatDuration(row.shot.end - row.shot.start)}</span>
                <span style={sepStyle}>·</span>
                <span style={metaStyle}>档位 {row.shot.tier}</span>
                <span style={sepStyle}>·</span>
                <span style={metaStyle}>动感 {row.motion === null ? '—' : row.motion.toFixed(1)}</span>
                <span style={sepStyle}>·</span>
                {row.text ? (
                  <Typography.Text
                    ellipsis={{ tooltip: row.text }}
                    style={{ flex: 1, minWidth: 0, color: 'var(--text-secondary)', fontSize: 12 }}
                  >
                    {row.text}
                  </Typography.Text>
                ) : (
                  <span style={{ ...metaStyle, flex: 1, minWidth: 0, color: 'var(--text-muted)' }}>（无台词）</span>
                )}
              </div>
            )
          })
        )}
      </section>
    </div>
  )
}

export default StoryboardViewer
