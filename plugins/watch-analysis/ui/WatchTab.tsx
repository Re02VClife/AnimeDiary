/**
 * ui/WatchTab — 番剧详情页的「拉片」入口（Phase 1 先独立可渲染）
 *
 * 状态机：
 *
 *   挂载
 *    ├─ 检查依赖（GET /deps）───┬─ 缺必装项 → 显示缺失项 + 补装提示，禁用「开始分析」
 *    │                          └─ 齐全 → 可运行
 *    └─ 读取已有报告（GET /report）
 *         ├─ 有 → 直接渲染 StoryboardViewer
 *         └─ 没有 → 引导「还没有分析过这一集」
 *
 *   开始分析（POST /analyze）→ 运行中（每 1.5s 轮询 /status）
 *         ├─ phase=done      → 拉 /report 渲染结果
 *         ├─ phase=failed    → 显示 error + 重试
 *         ├─ phase=cancelled → 已取消 + 重新分析
 *         └─ 用户点「取消」  → POST /cancel，停止轮询
 *
 * 两条边界：
 *   - **不依赖全局状态**：不 import AnimeContext / src 下任何东西，全部走 props + api.ts，
 *     将来挂到详情页只需要传 animeKey/episode。
 *   - **依赖不齐不装作能跑**：按钮直接禁用并列出补齐命令，而不是等任务跑一半再报错。
 *   - 组件卸载/切换集数时清掉轮询定时器，不留后台请求。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, FC, ReactNode } from 'react'
import { Alert, Button, Empty, InputNumber, Progress, Select, Spin, Switch, Tag, Tooltip, Typography } from 'antd'
import {
  CheckCircleOutlined,
  InfoCircleOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  StopOutlined,
} from '@ant-design/icons'
import type { WatchPhase, WatchReport } from '../core/types'
import { analyze, cancel, getDeps, getReport, getStatus, getWatchSettings, listJobs, saveWatchSettings } from './api'
import type { DepsResponse, WatchDependency, WatchJobStatus, WatchSettings, WatchSettingsResponse } from './api'
import BudgetBar, { formatTokens } from './BudgetBar'
import StoryboardViewer from './StoryboardViewer'

export interface WatchTabProps {
  /** 本地番剧库的 key：`模板::标题` */
  animeKey: string
  /** 第几集，从 1 开始 */
  episode: number
  /** 番剧标题，只用于表头显示 */
  title?: string
  /**
   * 视频绝对路径（可选）。
   *
   * 任务书契约里 /analyze 只需要 key + episode，路径由服务端解析；但当前 Phase 1 的
   * 后端实现要求 body.file，所以宿主如果能从本地番剧库拿到路径就传进来。
   * 不传也不会报错 —— 服务端若能自己解析就照常工作。
   */
  videoFile?: string
}

/** 轮询间隔：1.5s。再密没有意义（worker 的阶段切换远慢于这个量级）。 */
const POLL_INTERVAL_MS = 1500
/** 连续轮询失败几次才判定「任务丢了」——一次网络抖动不该把正在跑的任务判死。 */
const MAX_POLL_FAILURES = 3

const PHASE_LABELS: Record<WatchPhase, string> = {
  queued: '排队中',
  probe: '探测视频信息',
  scan: '切镜扫描',
  render: '抽帧拼宫格图',
  danmaku: '读取观众弹幕',
  transcript: '提取台词',
  motion: '测量动感',
  music: '分析配乐',
  analyze: '生成报告',
  done: '完成',
  cancelled: '已取消',
  failed: '失败',
}

const panelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: 16,
  borderRadius: 'var(--radius-md)',
  border: '1px solid var(--border-primary)',
  background: 'var(--bg-secondary)',
}

const mutedTextStyle: CSSProperties = { color: 'var(--text-secondary)', fontSize: 12 }

/**
 * 台词来源。
 *
 * 默认 `auto` **不跑 ASR**：一集 24 分钟本地 MOSS 要 10 分钟左右，不能让"顺手拉个片"
 * 变成"等十分钟"。只有用户显式选「语音识别」才在没字幕时兜底转写。
 */
type TranscriptMode = 'auto' | 'asr' | 'off'

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 服务端只回了 id、没回条目时的兜底，保证「缺什么」一定显示得出来 */
function fallbackDependency(id: string): WatchDependency {
  return {
    id,
    label: id,
    ok: false,
    required: true,
    hint: '依赖自检没有给出补装方式，请查看插件服务端日志',
  }
}

export const WatchTab: FC<WatchTabProps> = ({ animeKey, episode, title, videoFile }) => {
  // ── 依赖自检 ──
  const [deps, setDeps] = useState<DepsResponse | null>(null)
  const [checkingDeps, setCheckingDeps] = useState(true)
  const [depsError, setDepsError] = useState<string | null>(null)
  /** 点「重新检查」时自增，触发依赖自检 effect 重跑 */
  const [depsEpoch, setDepsEpoch] = useState(0)
  /** 台词来源：只影响下一次「开始分析」 */
  const [readSubtitle, setReadSubtitle] = useState(true)
  /** 没字幕文件时是否用本地 MOSS 兜底（= `transcript: 'asr'`） */
  const [asrFallback, setAsrFallback] = useState(false)
  /** 宫格图张数上下限；null / 0 = 自动（每 80 秒一张） */
  const [minSheets, setMinSheets] = useState<number | null>(null)
  const [maxSheets, setMaxSheets] = useState<number | null>(null)

  /** 派生：不让用户在三选一和两个开关之间来回理解 */
  const transcriptMode: TranscriptMode = !readSubtitle ? 'off' : asrFallback ? 'asr' : 'auto'

  // ── 性能预留（落盘在服务端，改完立即生效于下一次分析）──
  const [perf, setPerf] = useState<WatchSettingsResponse | null>(null)
  const [perfSaving, setPerfSaving] = useState(false)
  const [perfError, setPerfError] = useState<string | null>(null)

  // ── 已落盘报告 ──
  const [report, setReport] = useState<WatchReport | null>(null)
  const [reportLoading, setReportLoading] = useState(true)

  // ── 当前任务 ──
  const [jobId, setJobId] = useState<string | null>(null)
  const [jobState, setJobState] = useState<WatchJobStatus | null>(null)
  const [starting, setStarting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [cancelled, setCancelled] = useState(false)
  /** 取消请求本身失败（网络/服务端异常），单独显示在运行面板里，不把整个任务判死 */
  const [cancelError, setCancelError] = useState<string | null>(null)
  const pollFailuresRef = useRef(0)

  // 换番/换集：把上一集的任务状态清掉（报告由下面的 effect 重新拉）
  useEffect(() => {
    setJobId(null)
    setJobState(null)
    setFailed(null)
    setCancelled(false)
    setCancelError(null)
    pollFailuresRef.current = 0
  }, [animeKey, episode])

  /*
   * 恢复后台任务：关掉面板再打开时，把这一集还在跑的任务接回来。
   *
   * 分析一直是 worker 子进程在跑，UI 关掉只断了轮询、**没有取消任务** ——
   * 所以这里查到进行中的 job 就直接接管，不必让用户重新点「开始分析」。
   */
  useEffect(() => {
    if (!animeKey || !Number.isInteger(episode) || episode < 1) return
    let alive = true
    listJobs(animeKey, episode)
      .then((jobs) => {
        if (!alive) return
        const running = jobs.find((job) =>
          job.phase !== 'done' && job.phase !== 'failed' && job.phase !== 'cancelled',
        )
        if (running) {
          setJobId(running.jobId)
          setJobState(running)
        }
      })
      .catch(() => {
        // 恢复失败不影响手动开始；旧后端没有 /jobs 时这里就是一次 404
      })
    return () => {
      alive = false
    }
  }, [animeKey, episode])

  // 性能设置：只读一次，改的时候即时 PUT
  useEffect(() => {
    let alive = true
    getWatchSettings()
      .then((value) => {
        if (alive) setPerf(value)
      })
      .catch(() => {
        // 旧后端没有 /settings：面板不显示性能设置，不影响分析
      })
    return () => {
      alive = false
    }
  }, [])

  const savePerf = useCallback(async (patch: Partial<WatchSettings>) => {
    setPerfSaving(true)
    setPerfError(null)
    try {
      const next = await saveWatchSettings(patch)
      setPerf(next)
    } catch (e) {
      setPerfError(errorText(e))
    } finally {
      setPerfSaving(false)
    }
  }, [])

  // 依赖自检（每次点「重新检查」都重新探测，用户装完 ffmpeg 不用重启）
  useEffect(() => {
    let alive = true
    setCheckingDeps(true)
    setDepsError(null)
    getDeps()
      .then((result) => {
        if (alive) setDeps(result)
      })
      .catch((e: unknown) => {
        if (alive) setDepsError(errorText(e))
      })
      .finally(() => {
        if (alive) setCheckingDeps(false)
      })
    return () => {
      alive = false
    }
  }, [depsEpoch])

  // 读已有报告：失败是正常情况（这一集没跑过），不弹错误
  useEffect(() => {
    let alive = true
    setReportLoading(true)
    setReport(null)
    getReport(animeKey, episode)
      .then((existing) => {
        if (alive) setReport(existing)
      })
      .catch(() => {
        // 没有报告 → 走「还没有分析过这一集」引导
      })
      .finally(() => {
        if (alive) setReportLoading(false)
      })
    return () => {
      alive = false
    }
  }, [animeKey, episode])

  // 轮询任务状态。jobId 一旦置空（完成/失败/取消）effect 自动清理定时器。
  useEffect(() => {
    if (!jobId) return
    let alive = true
    let busy = false

    const tick = async (): Promise<void> => {
      if (busy) return
      busy = true
      try {
        const snapshot = await getStatus(jobId)
        if (!alive) return
        pollFailuresRef.current = 0
        setJobState(snapshot)

        if (snapshot.phase === 'done') {
          try {
            const finished = await getReport(animeKey, episode)
            if (!alive) return
            setReport(finished)
            setFailed(null)
            setCancelled(false)
            setCancelError(null)
            setJobId(null)
            setJobState(null)
          } catch (e) {
            if (!alive) return
            setFailed(`分析已完成，但读取报告失败：${errorText(e)}`)
            setJobId(null)
          }
          return
        }
        if (snapshot.phase === 'failed') {
          setFailed(snapshot.error || '分析失败（worker 没有给出原因）')
          setJobId(null)
          return
        }
        if (snapshot.phase === 'cancelled') {
          setCancelled(true)
          setJobId(null)
          setJobState(null)
        }
      } catch (e) {
        if (!alive) return
        pollFailuresRef.current += 1
        if (pollFailuresRef.current >= MAX_POLL_FAILURES) {
          setFailed(`连续 ${MAX_POLL_FAILURES} 次拿不到任务状态：${errorText(e)}（任务可能已丢失，可重试）`)
          setJobId(null)
        }
      } finally {
        busy = false
      }
    }

    void tick()
    const timer = window.setInterval(() => {
      void tick()
    }, POLL_INTERVAL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [jobId, animeKey, episode])

  const startAnalyze = useCallback(async (): Promise<void> => {
    setStarting(true)
    setFailed(null)
    setCancelled(false)
    setCancelError(null)
    setJobState(null)
    setReport(null)
    pollFailuresRef.current = 0
    try {
      const started = await analyze(animeKey, episode, {
        transcript: transcriptMode,
        ...(minSheets !== null && minSheets > 0 ? { minSheets } : {}),
        ...(maxSheets !== null && maxSheets > 0 ? { maxSheets } : {}),
      }, videoFile)
      setJobId(started.jobId)
    } catch (e) {
      setFailed(`启动分析失败：${errorText(e)}`)
    } finally {
      setStarting(false)
    }
  }, [animeKey, episode, videoFile, transcriptMode, minSheets, maxSheets])

  /**
   * 取消是「请求」不是「结果」：服务端把任务标成 cancelled 后，状态轮询会看到
   * phase=cancelled 再切到已取消态。这里不直接改 UI 状态 —— 否则「点取消时任务刚好
   * 跑完了」会被误报成已取消，报告的读取也就错过了。
   */
  const stopAnalyze = useCallback(async (): Promise<void> => {
    if (!jobId) return
    setCancelling(true)
    setCancelError(null)
    try {
      await cancel(jobId)
    } catch (e) {
      setCancelError(`取消请求失败：${errorText(e)}`)
    } finally {
      setCancelling(false)
    }
  }, [jobId])

  const recheckDeps = useCallback(() => {
    setDepsEpoch((n) => n + 1)
  }, [])

  const missingRequired = useMemo<WatchDependency[]>(() => {
    if (!deps) return []
    return deps.missingRequired.map((id) => deps.deps.find((d) => d.id === id) ?? fallbackDependency(id))
  }, [deps])

  const optionalMissing = useMemo<WatchDependency[]>(
    () => (deps ? deps.deps.filter((d) => !d.required && !d.ok) : []),
    [deps],
  )

  /**
   * 本地 MOSS 是否就绪。`undefined` = 服务端没给这一项（旧版本），按「未知」处理、
   * 不禁用选项 —— 总比把其实能用的人挡在外面强。
   */
  const asrReady = useMemo<boolean | undefined>(() => {
    const dep = deps?.deps.find((d) => d.id === 'asr')
    return dep ? dep.ok : undefined
  }, [deps])

  // 依赖明确说 MOSS 不可用时，别让「语音识别」这个开关悬在半空
  useEffect(() => {
    if (asrReady === false && asrFallback) setAsrFallback(false)
  }, [asrReady, asrFallback])

  /** 按当前设置估算这一次会出多少张图（只有已经分析过、知道片长时才算得出来） */
  const estimatedSheets = useMemo(() => {
    const duration = report?.video.duration
    if (!duration || duration <= 0) return null
    const auto = Math.max(1, Math.ceil(duration / 80))
    const lower = minSheets !== null && minSheets > 0 ? minSheets : 1
    const upper = maxSheets !== null && maxSheets > 0 ? maxSheets : 40
    return Math.min(Math.max(auto, lower), Math.max(lower, upper))
  }, [report, minSheets, maxSheets])

  const canRun = deps?.canRun === true
  const running = jobId !== null

  // ── 主体：按状态互斥渲染 ──
  let body: ReactNode
  if (starting) {
    body = (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, ...mutedTextStyle }}>
        <Spin size="small" /> 正在提交分析任务…
      </div>
    )
  } else if (running) {
    const percent = jobState && jobState.percent >= 0 ? Math.min(100, jobState.percent) : 0
    const percentKnown = jobState !== null && jobState.percent >= 0
    body = (
      <div style={panelStyle} data-testid="watch-running">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: 'var(--text-primary)' }}>
            <Spin size="small" />
            {PHASE_LABELS[jobState?.phase ?? 'queued']}
          </span>
          <Tag color="processing">{percentKnown ? `${Math.round(percent)}%` : '进度未知'}</Tag>
        </div>
        <Progress
          percent={percent}
          status="active"
          showInfo={false}
          strokeColor="var(--brand-primary)"
          trailColor="var(--bg-quaternary)"
          style={{ margin: 0 }}
        />
        <Typography.Text style={{ color: 'var(--text-secondary)' }}>
          {jobState?.message || '任务已提交，等待 worker 上报进度…'}
        </Typography.Text>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, ...mutedTextStyle }}>
          <span>预算：已用 {formatTokens(jobState?.spent ?? 0)} token</span>
          <Tooltip title="运行中服务端只回传已用量；上限和各环节分项要等报告落盘后才能算">
            <InfoCircleOutlined style={{ color: 'var(--text-muted)' }} />
          </Tooltip>
        </div>
        {cancelError && (
          <Typography.Text data-testid="cancel-error" style={{ color: 'var(--color-error)', fontSize: 12 }}>
            {cancelError}
          </Typography.Text>
        )}
      </div>
    )
  } else if (failed) {
    body = (
      <Alert
        type="error"
        showIcon
        message="分析失败"
        description={<span data-testid="watch-error">{failed}</span>}
        action={
          <Button
            size="small"
            icon={<ReloadOutlined />}
            disabled={!canRun || starting}
            loading={starting}
            onClick={() => {
              void startAnalyze()
            }}
          >
            重试
          </Button>
        }
      />
    )
  } else if (cancelled) {
    body = (
      <Alert
        type="info"
        showIcon
        message="已取消分析"
        description="已经落盘的中间结果会保留，重新分析会覆盖这一集的报告。"
        action={
          <Button
            size="small"
            icon={<PlayCircleOutlined />}
            disabled={!canRun || starting}
            loading={starting}
            onClick={() => {
              void startAnalyze()
            }}
          >
            重新分析
          </Button>
        }
      />
    )
  } else if (report) {
    body = (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Tag icon={<CheckCircleOutlined />} color="success">
            分析完成
          </Tag>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {report.shots.length} 个镜头 · {report.sheets.length} 张宫格图 · 分镜引擎 {report.engine.storyboard}
          </Typography.Text>
        </div>
        {/* 没台词时要说清楚"为什么没有、怎么补" —— 以前只有日志里有 */}
        {!report.transcript && (
          <Alert
            type="info"
            showIcon
            data-testid="no-transcript-hint"
            style={{ marginBottom: 8 }}
            message="这一集没有台词"
            description={
              <>
                没找到内嵌字幕轨，也没找到同目录的 .ass/.srt/.vtt 字幕文件。
                要台词的话：分析前打开「读取字幕」并打开「没字幕时用语音识别」兜底；
                或者把字幕文件放到视频旁边再分析一次。
              </>
            }
          />
        )}
        <StoryboardViewer report={report} />
        <div>
          <Typography.Text strong style={{ display: 'block', marginBottom: 8 }}>
            本集预算
          </Typography.Text>
          <BudgetBar ledger={report.budget} />
        </div>
      </div>
    )
  } else if (reportLoading) {
    body = (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, ...mutedTextStyle }}>
        <Spin size="small" /> 正在读取已有报告…
      </div>
    )
  } else {
    body = (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={<span data-testid="watch-empty">还没有分析过这一集</span>}
        style={{ padding: '24px 0' }}
      >
        <Typography.Paragraph style={{ ...mutedTextStyle, maxWidth: 520, marginBottom: 12 }}>
          分析会先切镜、抽帧拼成宫格图，再测量动感、提取台词，最后按预算生成镜头清单和报告。
          开始后可以随时取消；中途取消不会影响已落盘的结果。
        </Typography.Paragraph>
        <Button
          type="primary"
          icon={<PlayCircleOutlined />}
          loading={starting}
          disabled={!canRun}
          onClick={() => {
            void startAnalyze()
          }}
        >
          开始分析
        </Button>
      </Empty>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* ── 表头 ── */}
      <header style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <Typography.Title level={4} style={{ margin: 0, color: 'var(--text-primary)' }}>
            {title ? `${title} · 第 ${episode} 集` : `第 ${episode} 集`}
          </Typography.Title>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {animeKey}（拉片分析）
          </Typography.Text>
        </div>
        {running ? (
          <Button danger icon={<StopOutlined />} loading={cancelling} onClick={() => void stopAnalyze()}>
            取消分析
          </Button>
        ) : (
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            loading={starting}
            disabled={!canRun}
            onClick={() => void startAnalyze()}
          >
            {report ? '重新分析' : '开始分析'}
          </Button>
        )}
      </header>

      {/* ── 分析参数（只影响下一次运行，不改已有报告）── */}
      {!running && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* 分镜图张数上下限 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Typography.Text style={mutedTextStyle}>分镜图数量</Typography.Text>
            <InputNumber
              size="small"
              min={0}
              max={10000}
              step={10}
              value={minSheets ?? undefined}
              onChange={(value) => setMinSheets(typeof value === 'number' && Number.isFinite(value) ? value : null)}
              placeholder="自动"
              style={{ width: 88 }}
              aria-label="分镜图张数下限"
            />
            <Typography.Text style={mutedTextStyle}>–</Typography.Text>
            <InputNumber
              size="small"
              min={0}
              max={10000}
              step={10}
              value={maxSheets ?? undefined}
              onChange={(value) => setMaxSheets(typeof value === 'number' && Number.isFinite(value) ? value : null)}
              placeholder="自动"
              style={{ width: 88 }}
              aria-label="分镜图张数上限"
            />
            <Typography.Text style={mutedTextStyle}>张（每张 6 格；留空 = 自动，约 80 秒一张）</Typography.Text>
            {estimatedSheets !== null && (
              <Tag data-testid="estimated-sheets" style={{ marginInlineEnd: 0 }}>
                本次约 {estimatedSheets} 张
              </Tag>
            )}
          </div>

          {/* 读取字幕 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Typography.Text style={mutedTextStyle}>读取字幕</Typography.Text>
            <Switch
              size="small"
              checked={readSubtitle}
              onChange={setReadSubtitle}
              aria-label="读取字幕"
            />
            <Typography.Text style={mutedTextStyle}>没字幕时用语音识别</Typography.Text>
            <Switch
              size="small"
              checked={asrFallback}
              disabled={!readSubtitle || asrReady === false}
              onChange={setAsrFallback}
              aria-label="语音识别兜底"
            />
            {asrFallback && (
              <Typography.Text style={mutedTextStyle}>
                本地 MOSS 转写（含说话人分离）；一集 24 分钟约 10 分钟
              </Typography.Text>
            )}
            {asrReady === false && (
              <Typography.Text style={mutedTextStyle}>本地 MOSS 未就绪，见上方「可选依赖」</Typography.Text>
            )}
          </div>

          {/* 性能预留：抽帧 ffmpeg 的线程/并发 + worker 进程优先级 */}
          {perf && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Typography.Text style={mutedTextStyle}>性能预留</Typography.Text>
              <Select
                size="small"
                value={perf.settings.cpuPercent}
                onChange={(value) => void savePerf({ cpuPercent: Number(value) })}
                options={[25, 50, 75, 100].map((percent) => ({
                  value: percent,
                  label: `CPU 最多 ${percent}%`,
                }))}
                style={{ width: 132 }}
                disabled={perfSaving}
                aria-label="CPU 使用上限"
              />
              <Select
                size="small"
                value={perf.settings.priority}
                onChange={(value) => void savePerf({ priority: value as WatchSettings['priority'] })}
                options={[
                  { value: 'normal', label: '优先级：普通' },
                  { value: 'below-normal', label: '优先级：低于普通' },
                  { value: 'low', label: '优先级：低' },
                ]}
                style={{ width: 156 }}
                disabled={perfSaving}
                aria-label="进程优先级"
              />
              {perf.resolved && (
                <Typography.Text style={mutedTextStyle}>
                  {perf.cores} 核 → 抽帧并发 {perf.resolved.concurrency} / ffmpeg 线程 {perf.resolved.threads}
                </Typography.Text>
              )}
              {perfError && (
                <Typography.Text style={{ ...mutedTextStyle, color: 'var(--color-error)' }}>
                  保存失败：{perfError}
                </Typography.Text>
              )}
            </div>
          )}

          <Typography.Text style={mutedTextStyle}>
            张数留空 = 自动；超过 200 张会明显变慢（每张要抽 6 帧再拼图）。
            影评生成时按「AI 看图数量」从每集均匀取样（默认每集 2 张，可在影评配置里调）。
            <br />
            性能预留只作用于抽帧/拼图；扫描阶段由分镜引擎直接调 ffmpeg，不受它控制（这一招靠进程优先级降低卡顿）。
          </Typography.Text>
        </div>
      )}

      {/* ── 依赖状态 ── */}
      {checkingDeps && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, ...mutedTextStyle }}>
          <Spin size="small" /> 正在检查运行依赖…
        </div>
      )}
      {depsError && (
        <Alert
          type="error"
          showIcon
          message="依赖自检失败"
          description={depsError}
          action={
            <Button size="small" icon={<ReloadOutlined />} onClick={recheckDeps}>
              重新检查
            </Button>
          }
        />
      )}
      {!checkingDeps && deps && !deps.canRun && (
        <Alert
          type="warning"
          showIcon
          message="缺少必需的依赖，现在还不能开始分析"
          description={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {missingRequired.map((dep) => (
                <div key={dep.id} data-testid="missing-dep" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{dep.label}</span>
                  {dep.hint && (
                    <span style={{ fontSize: 12 }}>
                      补装：<Typography.Text code copyable>{dep.hint}</Typography.Text>
                    </span>
                  )}
                  {dep.detail && <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{dep.detail}</span>}
                </div>
              ))}
              <Button size="small" icon={<ReloadOutlined />} onClick={recheckDeps} style={{ alignSelf: 'flex-start' }}>
                重新检查
              </Button>
            </div>
          }
        />
      )}
      {!checkingDeps && deps && optionalMissing.length > 0 && (
        <Alert
          type="info"
          showIcon
          message={`可选依赖未就绪：${optionalMissing.map((d) => d.label).join('、')}`}
          description={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {optionalMissing.map((dep) => (
                <div key={dep.id} data-testid="optional-missing-dep" style={{ fontSize: 12 }}>
                  <span style={{ color: 'var(--text-primary)' }}>{dep.label}</span>
                  {dep.hint ? `：${dep.hint}` : null}
                </div>
              ))}
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                不影响能否开始分析，只会少对应的分析内容（例如没有 ASR 就没有台词）。
              </span>
            </div>
          }
        />
      )}

      {/* ── 主体 ── */}
      {body}
    </div>
  )
}

export default WatchTab
