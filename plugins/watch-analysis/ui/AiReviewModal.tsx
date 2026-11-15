/**
 * ui/AiReviewModal — AI 影评详情面板
 *
 * 三个入口（宿主持有，本组件不关心）：
 *   番剧详情面板按钮 / 首页顶栏快捷按钮 / 设置面板配置入口 —— 都是「打开本面板」。
 *
 * 组件内部两个 Tab：
 *   - 「影评」：评分对比（双序列雷达 + 逐维差异）、正文（Markdown，时间码可点）、
 *     时间轴（可跳镜头）、剧透折叠 + caveats + 元信息；
 *   - 「配置」：范围（整部番 / 单集）、视频路径（自动解析 / 手动指定）、分析集数、
 *     预算、模型与提示词版本，以及生成入口。
 *
 * 几条刻意为之的边界：
 *
 *   1. **不改全局、不 import `src/`**。用户评分/评价由宿主从 AnimeContext 取好，
 *      通过 `userContext` 传进来；跳转也由宿主接 `onJumpTo`。插件保持自包含。
 *   2. **AI 分和用户分不合并**。两套分数并排展示、算差值，但绝不写回 Excel，
 *      也不在 UI 上混成一个数 —— 这是 `core/review-types.ts` 的设计前提。
 *   3. **没证据的分数必须标出来**。「无证据」不是装饰，是产品硬要求：
 *      AI 拿不出时间码支撑的判断，用户有权一眼看见。
 *   4. **长请求可取消**。生成是同步接口（30–180 秒），关面板 / 点取消都走
 *      AbortController 真的断掉连接；定时器只在「生成中」存在，卸载即清。
 *   5. **辅助信息可降级**。`/resolve`、`/review/meta` 读不到时显示「读不到，可手动填写」/
 *      「未知」，不能让整个面板崩掉。
 */
import {
  Fragment,
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { CSSProperties, FC, ReactNode } from 'react'
import {
  Alert,
  Button,
  Checkbox,
  Collapse,
  Empty,
  Input,
  InputNumber,
  Modal,
  Segmented,
  Select,
  Space,
  Spin,
  Switch,
  Tabs,
  Tag,
  Tooltip,
} from 'antd'
import {
  PlayCircleOutlined,
  ReloadOutlined,
  StopOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import ReactECharts from 'echarts-for-react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type {
  AiDimensionScore,
  AiReview,
  ReviewScope,
  ReviewTimelineItem,
  ReviewUserContext,
} from '../core/review-types'
import { formatTokens } from './BudgetBar'
import {
  DEFAULT_REVIEW_BUDGET,
  generateReview,
  getExistingReview,
  getReviewMeta,
  isAbortError,
  listAnalyzedEpisodes,
  resolveVideoFile,
} from './review-api'
import type { ReviewGenerateRequest, ReviewMeta } from './review-api'

/* ─────────────────────────────────────────────────────────
 * Props
 * ───────────────────────────────────────────────────────── */

export interface AiReviewModalProps {
  open: boolean
  onClose: () => void
  /** `模板::标题`（与本地番剧库 / 音乐绑定共用的 key） */
  animeKey: string
  /** 显示用的番名 */
  title: string
  /** 用户自己的维度分 / 评价 / 标签（宿主从 AnimeContext 取好传进来） */
  userContext?: ReviewUserContext
  /** 可选：直接聚焦到某一集 */
  initialEpisode?: number
  /**
   * 点正文时间码 / 时间轴「跳到镜头」时通知宿主。
   *
   * 插件自己不持有播放器或分镜面板，所以只回传 `{ episode, t }`，
   * 由宿主决定跳到哪里（番剧详情页 / 拉片 Tab / 播放器）。
   */
  onJumpTo?: (target: { episode: number; t: number }) => void
}

/* ─────────────────────────────────────────────────────────
 * 常量与通用样式
 * ───────────────────────────────────────────────────────── */

/** 任务书要求 1000–1100，取中间值：正文 + 双栏对比都放得下 */
const MODAL_WIDTH = 1080

const MUTED_STYLE: CSSProperties = { color: 'var(--text-secondary)', fontSize: 12 }

const CONTENT_SCROLL_STYLE: CSSProperties = {
  maxHeight: 'min(62vh, 640px)',
  overflowY: 'auto',
  paddingRight: 6,
}

const PANEL_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: 12,
  borderRadius: 'var(--radius-md)',
  border: '1px solid var(--border-primary)',
  background: 'var(--bg-secondary)',
}

const SECTION_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
}

const SECTION_TITLE_STYLE: CSSProperties = {
  color: 'var(--text-primary)',
  fontWeight: 600,
  fontSize: 13,
}

const EMPTY_EPISODES_HINT =
  '还没有任何一集做过拉片分析。先到番剧详情页的「拉片」里分析至少一集，再回来生成影评。'

/* ─────────────────────────────────────────────────────────
 * 纯函数（格式化 / 对比表）
 * ───────────────────────────────────────────────────────── */

/** 秒 → `mm:ss`（≥1 小时用 `h:mm:ss`）。影评时间码不显示毫秒，与正文 `[mm:ss]` 对齐。 */
export function formatReviewClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--'
  const total = Math.round(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const mm = String(minutes).padStart(2, '0')
  const ss = String(secs).padStart(2, '0')
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`
}

/** 集号的显示口径：`E01` / `E12`（和分镜图文件名 `ep01.png` 的补零习惯一致） */
export function formatEpisodeLabel(episode: number): string {
  return `E${String(episode).padStart(2, '0')}`
}

/** 分数显示：最多一位小数，不补零（8.0 → `8`，8.25 → `8.3`） */
export function formatScoreValue(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

/** 差异显示：永远带符号、保留一位小数（+1.0 / -0.4 / ±0.0） */
export function formatDiff(diff: number): string {
  if (!Number.isFinite(diff)) return '—'
  if (Math.abs(diff) < 0.05) return '±0.0'
  return diff > 0 ? `+${diff.toFixed(1)}` : diff.toFixed(1)
}

function formatDateTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso || '未知'
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

/** 一维的对比：AI 分 / 你的分 / 差值（AI − 你） */
interface ScoreComparison {
  dimension: string
  ai: AiDimensionScore | null
  user: number | null
  diff: number | null
}

/**
 * 把 AI 分和用户分按维度名对齐。
 *
 * 维度来源 = AI 给出的维度（顺序即模型的顺序）+ 用户独有、AI 没给的维度。
 * 两边都没有的维度不会凭空出现 —— 不猜模板，只展示真实存在的分。
 */
function buildScoreRows(review: AiReview | null, userContext?: ReviewUserContext): ScoreComparison[] {
  const aiByName = new Map<string, AiDimensionScore>()
  for (const score of review?.scores ?? []) {
    if (!aiByName.has(score.dimension)) aiByName.set(score.dimension, score)
  }

  const userScores = userContext?.scores ?? {}
  const dimensions: string[] = []
  for (const dimension of aiByName.keys()) dimensions.push(dimension)
  for (const dimension of Object.keys(userScores)) {
    if (!dimensions.includes(dimension)) dimensions.push(dimension)
  }

  return dimensions.map((dimension) => {
    const ai = aiByName.get(dimension) ?? null
    const rawUser = userScores[dimension]
    const user = typeof rawUser === 'number' && Number.isFinite(rawUser) ? rawUser : null
    // 差值只保留一位小数：8.6 - 7.0 = 1.6000000000000005 这种浮点尾差不能露给用户
    const diff = ai !== null && user !== null ? Math.round((ai.value - user) * 10) / 10 : null
    return { dimension, ai, user, diff }
  })
}

/** 生成中的轮换文案：后端是同步接口没有真实进度，用「已经跑了多久」估算一个可信的说法 */
function progressText(elapsedSeconds: number): string {
  if (elapsedSeconds < 3) return '正在整理拉片报告与分镜图…'
  const sheet = Math.min(8, Math.floor(elapsedSeconds / 6) + 1)
  if (elapsedSeconds < 50) return `正在看第 ${sheet} 张分镜图…`
  if (elapsedSeconds < 90) return '正在把画面、台词和时间码对上…'
  if (elapsedSeconds < 150) return '正在组织影评正文与维度评分…'
  return '模型还在写，这篇有点长，再等等…'
}

/* ─────────────────────────────────────────────────────────
 * 正文时间码：把 [mm:ss] 包成可点击 span
 * ───────────────────────────────────────────────────────── */

/** `[12:34]` / `[1:05]`（分钟 1–2 位，秒 00–59） */
const TIMECODE_SOURCE = '\\[(\\d{1,2}):([0-5]\\d)\\]'

/**
 * 把一段纯文本拆成「普通文本 + 可点击时间码」节点。
 *
 * 为什么不用 rehype 插件：项目只装了 react-markdown + remark-gfm，没有 rehype 生态；
 * 而时间码在 Markdown 里只是普通文本（`[12:34]` 不是链接），所以在**文本节点**上
 * 做一次拆分就够了，既不加依赖，也不用碰 AST。
 */
function renderTextWithTimecodes(text: string, onTimecode: (seconds: number) => void): ReactNode {
  const pattern = new RegExp(TIMECODE_SOURCE, 'g')
  const nodes: ReactNode[] = []
  let cursor = 0
  let match: RegExpExecArray | null = pattern.exec(text)

  while (match) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index))
    const seconds = Number(match[1]) * 60 + Number(match[2])
    const label = match[0]
    nodes.push(
      <span
        key={`tc-${match.index}`}
        role="button"
        tabIndex={0}
        data-testid="timecode-link"
        data-t={seconds}
        className="wa-review-timecode"
        title={`跳到 ${formatReviewClock(seconds)}`}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          onTimecode(seconds)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onTimecode(seconds)
          }
        }}
        style={{
          color: 'var(--brand-primary)',
          background: 'var(--brand-soft)',
          borderRadius: 'var(--radius-xs)',
          padding: '0 2px',
          cursor: 'pointer',
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>,
    )
    cursor = match.index + label.length
    match = pattern.exec(text)
  }

  if (nodes.length === 0) return text
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}

/**
 * 递归把 React 节点树里所有字符串的 `[mm:ss]` 换成可点击节点。
 *
 * 跳过 `code` / `a` / `img`：代码里的方括号和链接文字不该被二次加工。
 * 数组节点逐个包一层 Fragment 以保留稳定的 key。
 */
function linkifyTimecodes(children: ReactNode, onTimecode: (seconds: number) => void): ReactNode {
  if (typeof children === 'string') return renderTextWithTimecodes(children, onTimecode)

  if (Array.isArray(children)) {
    return children.map((child, index) => (
      <Fragment key={`md-${index}`}>{linkifyTimecodes(child, onTimecode)}</Fragment>
    ))
  }

  if (isValidElement(children)) {
    if (children.type === 'code' || children.type === 'a' || children.type === 'img') return children
    const props = children.props as { children?: ReactNode }
    if (props.children === undefined) return children
    return cloneElement(children, undefined, linkifyTimecodes(props.children, onTimecode))
  }

  return children
}

/** Markdown 渲染器：样式跟着主题 CSS 变量，跳转仍交给宿主的 onJumpTo */
function buildMarkdownComponents(onTimecode: (seconds: number) => void): Components {
  const withTimecodes = (children: ReactNode): ReactNode => linkifyTimecodes(children, onTimecode)

  return {
    p: ({ children }) => <p style={{ margin: '0 0 10px' }}>{withTimecodes(children)}</p>,
    h1: ({ children }) => (
      <div style={{ fontSize: 16, fontWeight: 700, margin: '14px 0 8px', color: 'var(--text-primary)' }}>
        {withTimecodes(children)}
      </div>
    ),
    h2: ({ children }) => (
      <div style={{ fontSize: 15, fontWeight: 700, margin: '12px 0 6px', color: 'var(--text-primary)' }}>
        {withTimecodes(children)}
      </div>
    ),
    h3: ({ children }) => (
      <div style={{ fontSize: 14, fontWeight: 700, margin: '12px 0 6px', color: 'var(--text-primary)' }}>
        {withTimecodes(children)}
      </div>
    ),
    h4: ({ children }) => (
      <div style={{ fontSize: 13, fontWeight: 600, margin: '10px 0 5px', color: 'var(--text-primary)' }}>
        {withTimecodes(children)}
      </div>
    ),
    ul: ({ children }) => <ul style={{ margin: '0 0 10px', paddingLeft: 20 }}>{children}</ul>,
    ol: ({ children }) => <ol style={{ margin: '0 0 10px', paddingLeft: 20 }}>{children}</ol>,
    li: ({ children }) => <li style={{ marginBottom: 3 }}>{withTimecodes(children)}</li>,
    blockquote: ({ children }) => (
      <blockquote
        style={{
          margin: '0 0 10px',
          padding: '2px 12px',
          borderLeft: '3px solid var(--border-primary)',
          color: 'var(--text-secondary)',
        }}
      >
        {children}
      </blockquote>
    ),
    pre: ({ children }) => (
      <pre
        style={{
          margin: '0 0 10px',
          padding: 10,
          borderRadius: 'var(--radius-sm)',
          background: 'var(--bg-tertiary)',
          overflowX: 'auto',
          fontSize: 12,
          lineHeight: 1.6,
        }}
      >
        {children}
      </pre>
    ),
    code: ({ className, children }) => {
      const isBlock = typeof className === 'string' && className.startsWith('language-')
      if (isBlock) return <code className={className}>{children}</code>
      return (
        <code
          style={{
            fontSize: 12,
            padding: '1px 5px',
            borderRadius: 'var(--radius-xs)',
            background: 'var(--bg-tertiary)',
            color: 'var(--brand-primary)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          {children}
        </code>
      )
    },
    a: ({ href, children }) => (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        style={{ color: 'var(--brand-primary)' }}
      >
        {children}
      </a>
    ),
    // 正文里的图片是后端拼好的相对 URL（/api/watch/sheet?...），直接给 <img> 即可
    img: ({ src, alt }) => (
      <img
        src={typeof src === 'string' ? src : undefined}
        alt={alt ?? ''}
        loading="lazy"
        style={{
          display: 'block',
          maxWidth: '100%',
          margin: '8px 0',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border-primary)',
        }}
      />
    ),
    table: ({ children }) => (
      <div style={{ overflowX: 'auto', margin: '0 0 10px' }}>
        <table style={{ borderCollapse: 'collapse', fontSize: 12, lineHeight: 1.6 }}>{children}</table>
      </div>
    ),
    th: ({ children }) => (
      <th
        style={{
          border: '1px solid var(--border-primary)',
          padding: '4px 8px',
          background: 'var(--bg-tertiary)',
          textAlign: 'left',
          whiteSpace: 'nowrap',
        }}
      >
        {withTimecodes(children)}
      </th>
    ),
    td: ({ children }) => (
      <td style={{ border: '1px solid var(--border-primary)', padding: '4px 8px' }}>
        {withTimecodes(children)}
      </td>
    ),
    hr: () => (
      <hr style={{ border: 'none', borderTop: '1px solid var(--border-primary)', margin: '12px 0' }} />
    ),
    strong: ({ children }) => <strong style={{ fontWeight: 700 }}>{withTimecodes(children)}</strong>,
    em: ({ children }) => <em>{withTimecodes(children)}</em>,
    del: ({ children }) => <del>{withTimecodes(children)}</del>,
  }
}

/* ─────────────────────────────────────────────────────────
 * 展示用小组件
 * ───────────────────────────────────────────────────────── */

const SectionTitle: FC<{ title: string; hint?: string }> = ({ title, hint }) => (
  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
    <span style={SECTION_TITLE_STYLE}>{title}</span>
    {hint && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{hint}</span>}
  </div>
)

/** 双序列雷达：用户的分一条、AI 的分一条（没有用户分时只画 AI） */
const RadarPanel: FC<{ rows: ScoreComparison[] }> = ({ rows }) => {
  const hasUser = rows.some((row) => row.user !== null)

  const option = useMemo(() => {
    const data: Array<{ name: string; value: number[] }> = []
    if (hasUser) data.push({ name: '你的评分', value: rows.map((row) => row.user ?? 0) })
    data.push({ name: 'AI 评分', value: rows.map((row) => row.ai?.value ?? 0) })

    return {
      animation: false,
      color: ['var(--color-info)', 'var(--brand-primary)'],
      legend: {
        bottom: 0,
        itemWidth: 12,
        itemHeight: 8,
        textStyle: { color: 'var(--text-secondary)', fontSize: 12 },
      },
      tooltip: {
        trigger: 'item',
        backgroundColor: 'var(--bg-tertiary)',
        borderColor: 'var(--border-primary)',
        textStyle: { color: 'var(--text-primary)', fontSize: 12 },
      },
      radar: {
        indicator: rows.map((row) => ({ name: row.dimension, max: 10 })),
        radius: '62%',
        center: ['50%', '46%'],
        axisName: { color: 'var(--text-secondary)', fontSize: 11 },
        axisLine: { lineStyle: { color: 'var(--border-primary)' } },
        splitLine: { lineStyle: { color: 'var(--border-primary)' } },
        splitArea: { areaStyle: { color: ['transparent', 'var(--bg-tertiary)'] } },
      },
      series: [
        {
          type: 'radar',
          symbol: 'none',
          lineStyle: { width: 1.5 },
          areaStyle: { opacity: 0.16 },
          data,
        },
      ],
    }
  }, [rows, hasUser])

  if (rows.length === 0) return null

  return (
    <div data-testid="review-radar-panel" style={{ marginBottom: 8 }}>
      <ReactECharts
        option={option}
        style={{ height: 260, width: '100%' }}
        opts={{ renderer: 'svg' }}
        lazyUpdate
      />
      {!hasUser && <span style={MUTED_STYLE}>你还没打分，雷达图里目前只有 AI 的分。</span>}
    </div>
  )
}

/** 逐维度对比表：左用户分 / 中间差异条 / 右 AI 分（没证据的标「无证据」） */
const ScoreComparisonTable: FC<{ rows: ScoreComparison[]; hasUserScores: boolean }> = ({
  rows,
  hasUserScores,
}) => {
  if (rows.length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="这次影评没有给出维度评分" />
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {!hasUserScores && (
        <span data-testid="user-no-scores" style={{ ...MUTED_STYLE, color: 'var(--text-secondary)' }}>
          你还没打分 —— 只展示 AI 的维度分；给自己打完分再生成一次，就能看到两边的差异。
        </span>
      )}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '0 8px',
          fontSize: 12,
          color: 'var(--text-muted)',
        }}
      >
        <span style={{ flex: '0 0 64px' }}>维度</span>
        <span style={{ width: 44, textAlign: 'right' }}>你的分</span>
        <span style={{ flex: 1, textAlign: 'center' }}>AI − 你</span>
        <span style={{ width: 44, textAlign: 'right' }}>AI 分</span>
        <span style={{ width: 64 }} />
      </div>

      {rows.map((row) => {
        // 差值 ≥1 分算「实质分歧」，整行高亮；证据为空的 AI 分必须挂标签
        const highlight = row.diff !== null && Math.abs(row.diff) >= 1
        const noEvidence = row.ai !== null && row.ai.evidence.length === 0
        const barPercent =
          row.diff === null ? 0 : Math.min(50, (Math.abs(row.diff) / 5) * 50)

        const barStyle: CSSProperties =
          row.diff !== null && row.diff !== 0
            ? {
                position: 'absolute',
                top: 0,
                bottom: 0,
                width: `${Math.max(2, barPercent)}%`,
                ...(row.diff > 0 ? { left: '50%' } : { right: '50%' }),
                background: row.diff > 0 ? 'var(--color-error)' : 'var(--color-success)',
                borderRadius: 'var(--radius-pill)',
              }
            : {}

        return (
          <div
            key={row.dimension}
            data-testid="score-row"
            data-dimension={row.dimension}
            data-highlight={highlight ? 'true' : 'false'}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              padding: '6px 8px',
              borderRadius: 'var(--radius-sm)',
              background: highlight ? 'var(--brand-soft)' : 'transparent',
              borderLeft: `2px solid ${highlight ? 'var(--brand-primary)' : 'transparent'}`,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span
                style={{
                  flex: '0 0 64px',
                  color: 'var(--text-primary)',
                  fontWeight: 600,
                  fontSize: 13,
                }}
              >
                {row.dimension}
              </span>
              <span
                data-testid="user-score"
                style={{
                  width: 44,
                  textAlign: 'right',
                  fontSize: 13,
                  fontVariantNumeric: 'tabular-nums',
                  color: row.user === null ? 'var(--text-muted)' : 'var(--text-secondary)',
                }}
              >
                {row.user === null ? '—' : formatScoreValue(row.user)}
              </span>
              <div
                style={{
                  flex: 1,
                  position: 'relative',
                  height: 8,
                  borderRadius: 'var(--radius-pill)',
                  background: 'var(--bg-quaternary)',
                  overflow: 'hidden',
                }}
              >
                <span
                  style={{
                    position: 'absolute',
                    left: '50%',
                    top: 0,
                    bottom: 0,
                    width: 1,
                    marginLeft: -0.5,
                    background: 'var(--border-primary)',
                  }}
                />
                {row.diff !== null && <span style={barStyle} />}
              </div>
              <span
                data-testid="diff-value"
                style={{
                  width: 44,
                  textAlign: 'right',
                  fontSize: 12,
                  fontVariantNumeric: 'tabular-nums',
                  fontWeight: highlight ? 700 : 400,
                  color:
                    row.diff === null
                      ? 'var(--text-muted)'
                      : row.diff > 0
                        ? 'var(--color-error)'
                        : row.diff < 0
                          ? 'var(--color-success)'
                          : 'var(--text-muted)',
                }}
              >
                {row.diff === null ? '—' : formatDiff(row.diff)}
              </span>
              <span
                data-testid="ai-score"
                style={{
                  width: 44,
                  textAlign: 'right',
                  fontSize: 13,
                  fontVariantNumeric: 'tabular-nums',
                  fontWeight: 600,
                  color: 'var(--text-primary)',
                }}
              >
                {row.ai === null ? '—' : formatScoreValue(row.ai.value)}
              </span>
              <span style={{ width: 64, display: 'flex', justifyContent: 'flex-start' }}>
                {noEvidence && (
                  <span data-testid="no-evidence">
                    <Tag
                      style={{
                        marginInlineEnd: 0,
                        color: 'var(--color-warning)',
                        borderColor: 'var(--color-warning)',
                        background: 'transparent',
                      }}
                    >
                      无证据
                    </Tag>
                  </span>
                )}
              </span>
            </div>

            <div style={{ paddingLeft: 74, fontSize: 12, color: 'var(--text-secondary)' }}>
              {row.ai?.reason ?? 'AI 没有给这个维度打分'}
              {row.ai && row.ai.evidence.length > 0 && (
                <Tooltip
                  title={row.ai.evidence
                    .map(
                      (evidence) =>
                        `${formatEpisodeLabel(evidence.episode)} ${formatReviewClock(evidence.t)}${
                          evidence.note ? ` ${evidence.note}` : ''
                        }`,
                    )
                    .join('\n')}
                >
                  <span style={{ marginLeft: 8, color: 'var(--text-muted)', cursor: 'help' }}>
                    证据 {row.ai.evidence.length} 条
                  </span>
                </Tooltip>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** 影评正文：Markdown（GFM 表格等）+ 可点击时间码 */
const ReviewBody: FC<{ markdown: string; onTimecode: (seconds: number) => void }> = ({
  markdown,
  onTimecode,
}) => {
  const components = useMemo(() => buildMarkdownComponents(onTimecode), [onTimecode])

  if (!markdown.trim()) {
    return <span style={MUTED_STYLE}>这次影评没有正文。</span>
  }

  return (
    <div
      data-testid="review-markdown"
      style={{ color: 'var(--text-primary)', fontSize: 13, lineHeight: 1.8 }}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {markdown}
      </ReactMarkdown>
    </div>
  )
}

/** 时间轴：按 episode → t 排序，行内可直接跳镜头 */
const TimelineSection: FC<{
  items: ReviewTimelineItem[]
  onJumpTo?: (target: { episode: number; t: number }) => void
}> = ({ items, onJumpTo }) => {
  const sorted = useMemo(
    () => [...items].sort((a, b) => a.episode - b.episode || a.t - b.t),
    [items],
  )

  if (sorted.length === 0) {
    return <span style={MUTED_STYLE}>这次影评没有给出可定位的时间轴论点。</span>
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        maxHeight: 220,
        overflowY: 'auto',
        paddingRight: 4,
      }}
    >
      {sorted.map((item, index) => (
        <div
          key={`${item.episode}-${item.t}-${index}`}
          data-testid="timeline-row"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 8px',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--bg-tertiary)',
          }}
        >
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              color: 'var(--text-primary)',
              whiteSpace: 'nowrap',
            }}
          >
            {formatEpisodeLabel(item.episode)} · {formatReviewClock(item.t)}
          </span>
          <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--text-secondary)' }}>
            {item.text}
          </span>
          {typeof item.shot === 'number' && (
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>#{item.shot + 1}</span>
          )}
          {onJumpTo && (
            <Button
              size="small"
              type="link"
              icon={<PlayCircleOutlined />}
              onClick={() => onJumpTo({ episode: item.episode, t: item.t })}
              style={{ fontSize: 12, padding: 0, height: 'auto' }}
            >
              跳到镜头
            </Button>
          )}
        </div>
      ))}
    </div>
  )
}

/**
 * 底部元信息。
 *
 * 「用时」目前**没有契约字段**（`AiReview` 里没有耗时），所以只有本次面板里
 * 现场生成过才显示实测秒数，读历史记录时显示「—」—— 不编数。
 */
const MetaSection: FC<{ review: AiReview; elapsedSeconds: number | null }> = ({
  review,
  elapsedSeconds,
}) => {
  const parts = [
    review.model || '未知模型',
    `提示词 v${review.promptVersion || '未知'}`,
    elapsedSeconds === null ? '用时 —' : `用时 ${elapsedSeconds} 秒`,
    `${formatTokens(review.tokens)} token`,
    formatDateTime(review.created),
  ]
  return (
    <div data-testid="review-meta" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
      {parts.join(' · ')}
    </div>
  )
}

/* ─────────────────────────────────────────────────────────
 * 主组件
 * ───────────────────────────────────────────────────────── */

export const AiReviewModal: FC<AiReviewModalProps> = ({
  open,
  onClose,
  animeKey,
  title,
  userContext,
  initialEpisode,
  onJumpTo,
}) => {
  const initialScopeKind: 'series' | 'episode' =
    initialEpisode !== undefined && Number.isInteger(initialEpisode) && initialEpisode > 0
      ? 'episode'
      : 'series'

  // ── Tab ──
  const [tab, setTab] = useState<'review' | 'config'>('review')

  // ── 范围（生成参数） ──
  const [scopeKind, setScopeKind] = useState<'series' | 'episode'>(initialScopeKind)
  const [episode, setEpisode] = useState<number | null>(
    initialScopeKind === 'episode' ? (initialEpisode ?? null) : null,
  )

  // ── 已分析集号 ──
  const [episodes, setEpisodes] = useState<number[]>([])
  const [episodesLoading, setEpisodesLoading] = useState(false)
  const [episodesError, setEpisodesError] = useState<string | null>(null)

  // ── 视频路径（自动解析 / 手动指定） ──
  const [resolvedFile, setResolvedFile] = useState<string | null>(null)
  const [resolveLoading, setResolveLoading] = useState(false)
  const [resolveError, setResolveError] = useState<string | null>(null)
  const [manualFile, setManualFile] = useState(false)
  const [manualPath, setManualPath] = useState('')

  // ── 生成选项 ──
  const [selectedEpisodes, setSelectedEpisodes] = useState<number[]>([])
  const [budget, setBudget] = useState(DEFAULT_REVIEW_BUDGET)
  const [force, setForce] = useState(false)
  const [meta, setMeta] = useState<ReviewMeta | null>(null)

  // ── 影评与请求状态 ──
  const [review, setReview] = useState<AiReview | null>(null)
  // 默认 true：打开面板的第一帧先显示「读取中」，避免先闪一下空状态再被已有影评替换
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadEpoch, setReloadEpoch] = useState(0)
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState<string | null>(null)
  const [cached, setCached] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [generatedSeconds, setGeneratedSeconds] = useState<number | null>(null)

  /** 进行中的生成请求；关面板/取消/换范围时 abort */
  const abortRef = useRef<AbortController | null>(null)

  /* ── 打开/换番/换初始集：重置面板状态，避免看到上一部番的影评 ── */
  useEffect(() => {
    if (!open) {
      abortRef.current?.abort()
      abortRef.current = null
      setGenerating(false)
      return
    }

    abortRef.current?.abort()
    abortRef.current = null

    const startEpisode =
      initialEpisode !== undefined && Number.isInteger(initialEpisode) && initialEpisode > 0
        ? initialEpisode
        : null

    setTab('review')
    setScopeKind(startEpisode === null ? 'series' : 'episode')
    setEpisode(startEpisode)
    setEpisodes([])
    setEpisodesError(null)
    setEpisodesLoading(false)
    setSelectedEpisodes([])
    setResolvedFile(null)
    setResolveError(null)
    setResolveLoading(false)
    setManualFile(false)
    setManualPath('')
    setReview(null)
    setLoading(true)
    setLoadError(null)
    setGenerateError(null)
    setCached(false)
    setGeneratedSeconds(null)
    setElapsed(0)
    setForce(false)
  }, [open, animeKey, initialEpisode])

  /** 组件卸载：断掉所有在飞的请求（定时器由下面的 effect 自己收） */
  useEffect(
    () => () => {
      abortRef.current?.abort()
      abortRef.current = null
    },
    [],
  )

  /* ── 集号 + 生成元信息（打开时拉一次） ── */
  useEffect(() => {
    if (!open || !animeKey) return
    let alive = true

    setEpisodesLoading(true)
    setEpisodesError(null)
    listAnalyzedEpisodes(animeKey)
      .then((list) => {
        if (!alive) return
        setEpisodes(list)
        setSelectedEpisodes(list)
        // 还没选集时默认落到第一集（优先宿主给的 initialEpisode）
        setEpisode((current) => {
          if (current !== null) return current
          if (initialEpisode !== undefined && list.includes(initialEpisode)) return initialEpisode
          return list[0] ?? null
        })
      })
      .catch((e: unknown) => {
        if (!alive) return
        setEpisodes([])
        setEpisodesError(errorText(e))
      })
      .finally(() => {
        if (alive) setEpisodesLoading(false)
      })

    getReviewMeta()
      .then((value) => {
        if (alive) setMeta(value)
      })
      .catch(() => {
        // meta 本身已经降级成 null，这里再兜一层，保证面板不炸
      })

    return () => {
      alive = false
    }
  }, [open, animeKey, initialEpisode])

  /* ── 读当前范围下已有的影评（没有结果 → 空状态，不是错误） ── */
  useEffect(() => {
    if (!open || !animeKey) return

    let scope: ReviewScope
    if (scopeKind === 'episode') {
      if (episode === null || episode < 1) {
        setReview(null)
        setLoading(false)
        return
      }
      scope = { kind: 'episode', episode }
    } else {
      scope = { kind: 'series' }
    }

    let alive = true
    const controller = new AbortController()
    setLoading(true)
    setLoadError(null)

    getExistingReview(animeKey, scope, controller.signal)
      .then((found) => {
        if (!alive) return
        setReview(found)
        setCached(false)
        setGeneratedSeconds(null)
      })
      .catch((e: unknown) => {
        if (!alive || isAbortError(e)) return
        setReview(null)
        setLoadError(errorText(e))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })

    return () => {
      alive = false
      controller.abort()
    }
  }, [open, animeKey, scopeKind, episode, reloadEpoch])

  /* ── 解析视频路径（降级：读不到就提示手动填写） ── */
  const resolveEpisode: number | null =
    scopeKind === 'episode'
      ? episode
      : (selectedEpisodes[0] ?? episodes[0] ?? initialEpisode ?? null)

  useEffect(() => {
    if (!open || !animeKey || resolveEpisode === null) {
      setResolvedFile(null)
      setResolveError(null)
      setResolveLoading(false)
      return
    }

    let alive = true
    setResolveLoading(true)
    setResolveError(null)
    setResolvedFile(null)

    resolveVideoFile(animeKey, resolveEpisode)
      .then((file) => {
        if (!alive) return
        setResolvedFile(file)
        if (!file) setResolveError('读不到视频路径，可手动填写')
      })
      .catch(() => {
        if (alive) setResolveError('读不到视频路径，可手动填写')
      })
      .finally(() => {
        if (alive) setResolveLoading(false)
      })

    return () => {
      alive = false
    }
  }, [open, animeKey, resolveEpisode])

  /* ── 生成计时：只在 generating 期间存在，结束/卸载自动清 ── */
  useEffect(() => {
    if (!generating) return
    const startedAt = Date.now()
    setElapsed(0)
    const timer = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [generating])

  /* ── 操作 ── */

  const cancelGeneration = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setGenerating(false)
  }, [abortRef])

  const handleClose = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setGenerating(false)
    onClose()
  }, [abortRef, onClose])

  const handleScopeKindChange = useCallback(
    (value: string | number) => {
      const next: 'series' | 'episode' = value === 'episode' ? 'episode' : 'series'
      if (next === scopeKind) return
      // 换范围 = 换请求语义，正在跑的那次结果不能混进来
      abortRef.current?.abort()
      abortRef.current = null
      setGenerating(false)
      setScopeKind(next)
      if (next === 'episode') {
        setEpisode((current) => current ?? initialEpisode ?? episodes[0] ?? null)
      }
    },
    [abortRef, scopeKind, initialEpisode, episodes],
  )

  const handleEpisodeChange = useCallback(
    (value: number) => {
      abortRef.current?.abort()
      abortRef.current = null
      setGenerating(false)
      setEpisode(value)
    },
    [abortRef],
  )

  const jumpTo = useCallback(
    (target: { episode: number; t: number }) => {
      onJumpTo?.(target)
    },
    [onJumpTo],
  )

  /**
   * 正文里的 `[mm:ss]` 只有时间、没有集号（契约如此）。
   *
   * 解析顺序：单集影评直接用那一集；整部番的影评先找时间轴上 ±1.5 秒内最接近的论点
   * （模型通常同一时刻既写正文也写时间轴），再退回第一集。这个「缺集号」已写进
   * 交付报告，等契约补 `episode` 后可以删掉这段启发式。
   */
  const resolveMarkdownEpisode = useCallback(
    (seconds: number): number => {
      if (review?.scope.kind === 'episode') return review.scope.episode
      const matched = review?.timeline.find((item) => Math.abs(item.t - seconds) <= 1.5)
      if (matched) return matched.episode
      return review?.inputs.episodes[0] ?? initialEpisode ?? episodes[0] ?? 1
    },
    [review, initialEpisode, episodes],
  )

  const handleTimecode = useCallback(
    (seconds: number) => {
      jumpTo({ episode: resolveMarkdownEpisode(seconds), t: seconds })
    },
    [jumpTo, resolveMarkdownEpisode],
  )

  const startGenerate = useCallback(
    async (options?: { force?: boolean }): Promise<void> => {
      let scope: ReviewScope
      if (scopeKind === 'episode') {
        if (episode === null || episode < 1) return
        scope = { kind: 'episode', episode }
      } else {
        scope = { kind: 'series' }
      }

      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      setTab('review')
      setGenerating(true)
      setGenerateError(null)
      setCached(false)
      setGeneratedSeconds(null)
      setElapsed(0)
      const startedAt = Date.now()

      const payload: ReviewGenerateRequest = {
        key: animeKey,
        scope,
        userContext: { ...(userContext ?? {}), title: userContext?.title || title },
        options: {
          budget,
          force: options?.force ?? force,
          ...(scope.kind === 'series' && selectedEpisodes.length > 0
            ? { episodes: selectedEpisodes }
            : {}),
          ...(scope.kind === 'episode' ? { episodes: [scope.episode] } : {}),
        },
        // 契约缺口：ReviewOptions 里没有 file 字段，这里按任务书要求作为顶层扩展字段发送
        ...(manualFile && manualPath.trim() ? { file: manualPath.trim() } : {}),
      }

      try {
        const result = await generateReview(payload, controller.signal)
        setReview(result.review)
        setCached(result.cached)
        setGenerateError(null)
        setGeneratedSeconds(Math.max(1, Math.round((Date.now() - startedAt) / 1000)))
        setForce(false)
      } catch (e) {
        // 用户取消不是失败：不发错误 Alert，直接回到原来的状态
        if (isAbortError(e)) return
        setGenerateError(errorText(e))
      } finally {
        if (abortRef.current === controller) abortRef.current = null
        setGenerating(false)
      }
    },
    [
      abortRef,
      animeKey,
      scopeKind,
      episode,
      userContext,
      title,
      budget,
      force,
      selectedEpisodes,
      manualFile,
      manualPath,
    ],
  )

  /* ── 派生状态 ── */

  const scoreRows = useMemo(() => buildScoreRows(review, userContext), [review, userContext])
  const hasUserScores = useMemo(
    () => Object.keys(userContext?.scores ?? {}).length > 0,
    [userContext],
  )
  const noAnalyzedEpisodes = !episodesLoading && episodesError === null && episodes.length === 0
  const canGenerate =
    !generating &&
    !(scopeKind === 'episode' && (episode === null || episode < 1)) &&
    !noAnalyzedEpisodes

  const episodeOptions = useMemo(() => {
    const options = episodes.map((value) => ({ label: `第 ${value} 集`, value }))
    if (episode !== null && !episodes.includes(episode)) {
      options.unshift({ label: `第 ${episode} 集（还没做拉片分析）`, value: episode })
    }
    return options
  }, [episodes, episode])

  const inFlightPath = manualFile
    ? '手动路径会随生成请求一并提交给后端。'
    : resolveError ??
      (resolvedFile
        ? `解析自本地番剧库${scopeKind === 'series' ? '（整部番时显示第一集的路径）' : ''}。`
        : '还没解析出路径，可打开「手动指定」自己填。')

  /* ── 生成中面板 ── */

  const generatingPanel = generating ? (
    <div data-testid="review-generating" style={{ ...PANEL_STYLE, marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Spin size="small" />
        <span style={{ color: 'var(--text-primary)', fontSize: 13 }}>{progressText(elapsed)}</span>
        <Tag
          style={{
            marginInlineEnd: 0,
            color: 'var(--brand-primary)',
            borderColor: 'var(--brand-line)',
            background: 'var(--brand-soft)',
          }}
        >
          {elapsed} 秒
        </Tag>
        <span style={{ flex: 1 }} />
        <Button size="small" danger icon={<StopOutlined />} onClick={cancelGeneration}>
          取消
        </Button>
      </div>
      <span style={MUTED_STYLE}>
        影评是同步接口，可能要跑 30–180 秒；关掉面板会中断这次请求。
      </span>
    </div>
  ) : null

  /* ── 影评 Tab ── */

  const emptyState = (
    <div style={{ padding: '12px 0' }}>
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有生成过影评">
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <span style={{ ...MUTED_STYLE, maxWidth: 560, textAlign: 'center', lineHeight: 1.7 }}>
            AI 会把已分析的拉片报告和分镜图看一遍，对照你自己的评分写一篇能点到时间码的影评。
            一次大约 30–180 秒，不用先去配置 Tab。
          </span>
          {noAnalyzedEpisodes && (
            <span style={{ ...MUTED_STYLE, color: 'var(--color-warning)', textAlign: 'center' }}>
              {EMPTY_EPISODES_HINT}
            </span>
          )}
          <Space>
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              onClick={() => void startGenerate()}
              disabled={!canGenerate}
            >
              生成影评
            </Button>
            <Button onClick={() => setTab('config')}>先去配置</Button>
          </Space>
        </div>
      </Empty>
    </div>
  )

  const reviewTab = (
    <div style={CONTENT_SCROLL_STYLE} data-testid="review-tab">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 10,
        }}
      >
        <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
          {review ? 'AI 影评' : '影评'}
        </span>
        <Space size={8}>
          {loading && <Spin size="small" />}
          {review && (
            <Button
              size="small"
              icon={<ReloadOutlined />}
              onClick={() => void startGenerate({ force: true })}
              disabled={generating}
            >
              重新生成
            </Button>
          )}
        </Space>
      </div>

      {cached && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="这是上次生成的结果"
          description="模型和提示词版本都没变，后端直接返回了缓存（没有重新花钱）。想重新分析就点「重新生成」。"
          action={
            <Button
              size="small"
              onClick={() => void startGenerate({ force: true })}
              disabled={generating}
            >
              重新生成
            </Button>
          }
        />
      )}

      {generatingPanel}

      {generateError && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message="生成失败"
          description={generateError}
          action={
            <Button
              size="small"
              danger
              onClick={() => void startGenerate({ force: true })}
              disabled={generating}
            >
              重试
            </Button>
          }
        />
      )}

      {loadError && !review && (
        <Alert
          type="error"
          showIcon
          message="读取已有影评失败"
          description={loadError}
          action={
            <Button size="small" onClick={() => setReloadEpoch((value) => value + 1)}>
              重试
            </Button>
          }
        />
      )}

      {!review && !generating && !generateError && !loadError && (loading ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            padding: '32px 0',
            ...MUTED_STYLE,
          }}
        >
          <Spin size="small" /> 正在读取已有影评…
        </div>
      ) : (
        emptyState
      ))}

      {review && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {/* 1. 评分对比 */}
          <section>
            <SectionTitle
              title="评分对比"
              hint="你的分和 AI 的分是两套东西，并排展示、不合并、不写进 Excel"
            />
            <RadarPanel rows={scoreRows} />
            <ScoreComparisonTable rows={scoreRows} hasUserScores={hasUserScores} />
          </section>

          {/* 2. 影评正文 */}
          <section>
            <SectionTitle
              title="影评正文"
              hint="点击正文里的 [mm:ss] 时间码可以跳回对应镜头"
            />
            <ReviewBody markdown={review.markdown} onTimecode={handleTimecode} />
          </section>

          {/* 3. 时间轴 */}
          <section>
            <SectionTitle
              title="时间轴"
              hint={`共 ${review.timeline.length} 条可定位的论点，按集号和时间排序`}
            />
            <TimelineSection
              items={review.timeline}
              onJumpTo={onJumpTo ? jumpTo : undefined}
            />
          </section>

          {/* 4. 剧透 + 元信息 */}
          <section>
            <SectionTitle title="剧透与元信息" />
            {review.spoiler && (
              <Collapse
                style={{
                  marginBottom: 10,
                  background: 'var(--bg-secondary)',
                  borderColor: 'var(--border-primary)',
                }}
                items={[
                  {
                    key: 'spoiler',
                    label: '含剧透，点击展开',
                    children: (
                      <ReviewBody markdown={review.spoiler} onTimecode={handleTimecode} />
                    ),
                  },
                ]}
              />
            )}

            {review.caveats && review.caveats.length > 0 && (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 10 }}
                message="AI 自己标注的不确定性"
                description={
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {review.caveats.map((caveat, index) => (
                      <li key={`${index}-${caveat}`} style={{ fontSize: 12 }}>
                        {caveat}
                      </li>
                    ))}
                  </ul>
                }
              />
            )}

            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
              基于{' '}
              {review.inputs.episodes.length > 0
                ? review.inputs.episodes.map(formatEpisodeLabel).join(' / ')
                : '—'}{' '}
              · {review.inputs.shots} 个镜头 · {review.inputs.sheets} 张分镜图
              {review.inputs.dialogueLines > 0 ? ` · ${review.inputs.dialogueLines} 条台词` : ''}
            </div>

            <MetaSection review={review} elapsedSeconds={generatedSeconds} />
          </section>
        </div>
      )}
    </div>
  )

  /* ── 配置 Tab ── */

  const configTab = (
    <div style={CONTENT_SCROLL_STYLE} data-testid="config-tab">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {/* 范围 */}
        <section style={SECTION_STYLE}>
          <span style={SECTION_TITLE_STYLE}>范围</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <Segmented<string>
              value={scopeKind}
              onChange={handleScopeKindChange}
              options={[
                { label: '整部番', value: 'series' },
                { label: '单集', value: 'episode' },
              ]}
            />
            {scopeKind === 'episode' && (
              <Select
                value={episode ?? undefined}
                onChange={handleEpisodeChange}
                options={episodeOptions}
                placeholder="选一集"
                style={{ width: 220 }}
                loading={episodesLoading}
                disabled={episodes.length === 0 && episodesLoading}
              />
            )}
          </div>
          {scopeKind === 'series' && (
            <span style={MUTED_STYLE}>整部番会把已分析的集放在一起看，适合写总评。</span>
          )}
          {scopeKind === 'episode' && noAnalyzedEpisodes && (
            <span style={{ ...MUTED_STYLE, color: 'var(--color-warning)' }}>
              {EMPTY_EPISODES_HINT}
            </span>
          )}
          {episodesError && (
            <span style={{ ...MUTED_STYLE, color: 'var(--color-error)' }}>
              集号读取失败：{episodesError}（整部番仍可生成）
            </span>
          )}
        </section>

        {/* 视频文件地址 */}
        <section style={SECTION_STYLE}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span style={SECTION_TITLE_STYLE}>视频文件地址</span>
            <Switch
              size="small"
              checked={manualFile}
              onChange={setManualFile}
              checkedChildren="手动"
              unCheckedChildren="自动"
            />
            <span style={MUTED_STYLE}>手动指定</span>
          </div>
          {manualFile ? (
            <Input
              value={manualPath}
              onChange={(event) => setManualPath(event.target.value)}
              placeholder="填本地绝对路径，例如 D:\\anime\\番名\\01.mp4"
              allowClear
            />
          ) : (
            <Input
              readOnly
              value={resolveLoading ? '正在读取…' : resolvedFile ?? ''}
              placeholder="读不到，可打开「手动指定」填写"
            />
          )}
          <span style={MUTED_STYLE}>{inFlightPath}</span>
        </section>

        {/* 分析集数（整部番才需要选） */}
        {scopeKind === 'series' && (
          <section style={SECTION_STYLE}>
            <span style={SECTION_TITLE_STYLE}>分析集数</span>
            <Select
              mode="multiple"
              value={selectedEpisodes}
              onChange={(values: number[]) => setSelectedEpisodes(values)}
              options={episodes.map((value) => ({ label: `第 ${value} 集`, value }))}
              placeholder={episodes.length === 0 ? '还没有已分析的集' : '默认全选已分析的集'}
              style={{ width: '100%' }}
              disabled={episodesLoading || episodes.length === 0}
            />
            <span style={MUTED_STYLE}>默认全选已经分析过的集；这里改的就是参与生成的范围。</span>
          </section>
        )}

        {/* 预算 */}
        <section style={SECTION_STYLE}>
          <span style={SECTION_TITLE_STYLE}>预算</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <InputNumber
              min={1000}
              max={100_000_000}
              step={100_000}
              value={budget}
              onChange={(value) =>
                setBudget(
                  typeof value === 'number' && Number.isFinite(value)
                    ? value
                    : DEFAULT_REVIEW_BUDGET,
                )
              }
              style={{ width: 200 }}
            />
            <span style={MUTED_STYLE}>
              token 上限 · 本次已用 {formatTokens(review?.tokens ?? 0)} token
            </span>
          </div>
          <span style={MUTED_STYLE}>
            默认 200 万。影评通常只花几千 token，看图多的时候会涨。
          </span>
        </section>

        {/* 模型 / 提示词版本 */}
        <section style={SECTION_STYLE}>
          <span style={SECTION_TITLE_STYLE}>模型 / 提示词版本</span>
          <span
            style={{
              fontSize: 12,
              color: 'var(--text-primary)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {meta
              ? `${meta.model} · 提示词 v${meta.promptVersion}`
              : '未知（读不到 /api/watch/review/meta）'}
          </span>
          <span style={MUTED_STYLE}>
            这两项决定「尺子」：换模型或改提示词后旧影评不会自动重算，需要点「重新生成」。
          </span>
        </section>

        {/* 生成入口 */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
            paddingTop: 12,
            borderTop: '1px solid var(--border-primary)',
          }}
        >
          <Button
            type="primary"
            icon={<ThunderboltOutlined />}
            onClick={() => void startGenerate()}
            disabled={!canGenerate}
            loading={generating}
          >
            {generating ? '生成中…' : '生成影评'}
          </Button>
          <Checkbox
            checked={force}
            onChange={(event) => setForce(event.target.checked)}
            disabled={generating}
          >
            重新生成（忽略已有结果）
          </Checkbox>
          {generating && (
            <Button danger size="small" icon={<StopOutlined />} onClick={cancelGeneration}>
              取消
            </Button>
          )}
        </div>
        <span style={MUTED_STYLE}>
          生成是同步的，期间可以关面板取消；重新生成前，已有结果不会被覆盖。
        </span>
      </div>
    </div>
  )

  return (
    <Modal
      open={open}
      onCancel={handleClose}
      title={`AI 影评 · ${title}`}
      width={MODAL_WIDTH}
      destroyOnClose
      footer={null}
    >
      <Tabs
        activeKey={tab}
        onChange={(key) => setTab(key === 'config' ? 'config' : 'review')}
        items={[
          { key: 'review', label: '影评', children: reviewTab },
          { key: 'config', label: '配置', children: configTab },
        ]}
      />
    </Modal>
  )
}

export default AiReviewModal
