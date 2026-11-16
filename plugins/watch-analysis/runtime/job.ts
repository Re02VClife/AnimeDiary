/**
 * runtime/job — 分析任务的状态机与子进程管理
 *
 * 职责边界：**只管进程**。它不知道 WatchReport 长什么样，也不知道结果要写去哪 ——
 * 那是 pipeline 的事。这样换编排逻辑时不用动进程管理，反之亦然。
 *
 * 三个必须处理好的地方（都是踩过坑的）：
 *   1. **Windows 上 kill 不杀子孙进程** —— worker 会 spawn ffmpeg，只 kill 父进程
 *      会留下一堆孤儿 ffmpeg 占着 CPU。必须 taskkill /T。
 *   2. **stdout 是协议通道** —— worker 只要往 stdout 打一行日志，主进程 JSON 解析就崩。
 *      所以解析器对坏行要"跳过并记录"，不能让一行噪音搞死整个任务。
 *   3. **Electron 里没有 node 可执行文件** —— 打包后要用 electron 自己当 node 跑
 *      （ELECTRON_RUN_AS_NODE=1），不能假设用户装了 Node。
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import crypto from 'node:crypto'
import type { WatchAnalyzeOptions, WatchWorkerEvent, WatchWorkerResult } from './protocol'
import type { WatchPhase } from '../core/types'

export interface JobSnapshot {
  jobId: string
  key: string
  episode: number
  phase: WatchPhase
  percent: number
  message: string
  spent: number
  startedAt: number
  error?: string
}

export interface JobStartOptions {
  input: string
  key: string
  episode: number
  outDir: string
  prefix: string
  /** worker.mjs 的绝对路径 */
  workerPath: string
  options: WatchAnalyzeOptions
  /**
   * 子进程优先级（Windows 上 ffmpeg 子进程会继承这个优先级类）。
   * 不传 = 不动系统默认。
   */
  priority?: 'normal' | 'below-normal' | 'low'
  /** 正常产出（payload 已经过协议校验） */
  onResult: (payload: WatchWorkerResult) => void | Promise<void>
  /** 失败（含 worker 崩溃、超时、协议错误） */
  onError: (message: string) => void
}

export interface WatchJobManager {
  start(opts: JobStartOptions): string
  status(jobId: string): JobSnapshot | null
  cancel(jobId: string): boolean
  /** 当前所有未结束的任务（用于进程退出时清理） */
  running(): string[]
  /**
   * 最近的任务列表（进行中 + 30 分钟内结束的）。
   * UI 用它做「关掉面板又打开，能接回后台任务」。
   */
  list(): JobSnapshot[]
}

/** 默认超时：一集 24 分钟，慢机器要 10 分钟以上，给足余量 */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000

/**
 * 决定用什么命令跑 worker。
 *
 * - dev（纯 Node）：直接用 PATH 里的 node
 * - Electron 打包版：没有 node，用 electron 自身 + ELECTRON_RUN_AS_NODE=1
 *   注意要**丢掉 NODE_OPTIONS** —— 宿主可能设了 `--inspect` 之类，
 *   子进程带着它启动会去抢调试端口然后卡死。
 */
export function resolveNodeRunner(workerPath: string): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const isElectron = Boolean((process as any).versions?.electron)
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.NODE_OPTIONS
  if (isElectron) {
    return { command: process.execPath, args: [workerPath], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }
  }
  return { command: process.platform === 'win32' ? 'node.exe' : 'node', args: [workerPath], env }
}

/** Windows 上要连子孙进程一起杀（ffmpeg 是 worker 的子进程） */
function killTree(child: ChildProcess) {
  if (child.pid == null) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } catch {
      child.kill('SIGKILL')
    }
    return
  }
  try {
    child.kill('SIGKILL')
  } catch { /* 已经死了 */ }
}

interface JobEntry {
  snapshot: JobSnapshot
  child?: ChildProcess
  cancelled: boolean
  timer?: NodeJS.Timeout
  cleanup: () => void
  /** 结束时刻（done/failed/cancelled）；用于把旧任务从列表里清出去 */
  finishedAt?: number
}

/** 结束后的任务保留多久：够用户在面板关/开之间来回，又不至于无限攒内存 */
const FINISHED_TTL_MS = 30 * 60 * 1000

/** 优先级名 → Node 常量。Node 在三个平台上都支持 setPriority */
function priorityValue(priority: JobStartOptions['priority']): number | null {
  if (priority === 'below-normal') return os.constants.priority.PRIORITY_BELOW_NORMAL
  if (priority === 'low') return os.constants.priority.PRIORITY_LOW
  return null
}

export function createJobManager(): WatchJobManager {
  const jobs = new Map<string, JobEntry>()

  function finish(jobId: string) {
    const job = jobs.get(jobId)
    if (!job) return
    if (!job.finishedAt) job.finishedAt = Date.now()
    if (job.timer) clearTimeout(job.timer)
    try { job.cleanup() } catch { /* ignore */ }
  }

  /** 把过期的结束任务清掉：list() 每次调用顺手做，不需要额外定时器 */
  function pruneFinished() {
    const now = Date.now()
    for (const [jobId, job] of jobs) {
      if (job.finishedAt && now - job.finishedAt > FINISHED_TTL_MS) jobs.delete(jobId)
    }
  }

  return {
    start(opts) {
      const jobId = crypto.randomBytes(8).toString('hex')
      const snapshot: JobSnapshot = {
        jobId,
        key: opts.key,
        episode: opts.episode,
        phase: 'queued',
        percent: 0,
        message: '排队中',
        spent: 0,
        startedAt: Date.now(),
      }

      // 请求 JSON 落到临时文件：命令行传大 JSON 在 Windows 上有引号转义地狱
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-job-'))
      const requestPath = path.join(tempDir, 'request.json')
      const cleanup = () => {
        try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
      }

      try {
        fs.writeFileSync(requestPath, JSON.stringify({
          kind: 'analyze',
          input: opts.input,
          key: opts.key,
          episode: opts.episode,
          options: { ...opts.options, outDir: opts.outDir, prefix: opts.prefix },
        }), 'utf8')
      } catch (error) {
        cleanup()
        throw error
      }

      const entry: JobEntry = { snapshot, cancelled: false, cleanup }
      jobs.set(jobId, entry)

      const runner = resolveNodeRunner(opts.workerPath)
      let child: ChildProcess
      try {
        child = spawn(runner.command, [...runner.args, requestPath], {
          env: runner.env,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (error) {
        // spawn 同步失败（命令不存在）—— 直接判失败，不要留一个永远 queued 的任务
        entry.snapshot.phase = 'failed'
        entry.snapshot.error = error instanceof Error ? error.message : String(error)
        finish(jobId)
        opts.onError(entry.snapshot.error)
        return jobId
      }
      entry.child = child
      entry.snapshot.phase = 'probe'
      entry.snapshot.message = '启动分析进程'

      /*
       * 降优先级：Windows 上子进程会继承父进程的优先级类，所以 worker 里
       * 后续 spawn 的 ffmpeg 也一起变低 —— 这是"分析时系统不被抢到卡死"最有效的一招。
       * 失败不致命（某些沙箱/权限下 setPriority 会抛错）。
       */
      const priority = priorityValue(opts.priority)
      if (priority !== null && typeof child.pid === 'number') {
        try {
          os.setPriority(child.pid, priority)
        } catch {
          // 拿不到权限就当没设，不影响分析
        }
      }

      // stderr 只是日志：转给 console 便于排查，不进状态
      if (child.stderr) {
        readline.createInterface({ input: child.stderr }).on('line', (line) => {
          if (line.trim()) console.log(line)
        })
      }

      if (child.stdout) {
        readline.createInterface({ input: child.stdout }).on('line', (line) => {
          if (!line.trim()) return
          let event: WatchWorkerEvent
          try {
            event = JSON.parse(line)
          } catch {
            // 协议通道里混进非 JSON：记录但不致命（worker 的日志本该死走 stderr）
            console.warn(`[watch-job ${jobId}] 无法解析的 stdout 行：${line.slice(0, 200)}`)
            return
          }
          if (entry.cancelled) return

          if (event.type === 'ready') {
            entry.snapshot.phase = 'probe'
            entry.snapshot.percent = 1
            entry.snapshot.message = '分析进程就绪'
            return
          }
          if (event.type === 'progress') {
            entry.snapshot.phase = event.phase
            entry.snapshot.percent = Math.max(0, Math.min(100, Math.round(event.percent)))
            entry.snapshot.message = event.message
            return
          }
          if (event.type === 'result') {
            entry.snapshot.phase = 'done'
            entry.snapshot.percent = 100
            entry.snapshot.message = '完成'
            finish(jobId)
            Promise.resolve(opts.onResult(event.payload)).catch((error) => {
              // 落盘失败要能被看到：状态切 failed，而不是悄悄停在 100%
              entry.snapshot.phase = 'failed'
              entry.snapshot.error = error instanceof Error ? error.message : String(error)
              opts.onError(entry.snapshot.error)
            })
            return
          }
          if (event.type === 'error') {
            entry.snapshot.phase = 'failed'
            entry.snapshot.error = event.message
            finish(jobId)
            opts.onError(event.message)
          }
        })
      }

      child.on('error', (error) => {
        entry.snapshot.phase = 'failed'
        entry.snapshot.error = `分析进程启动失败：${error.message}`
        finish(jobId)
        opts.onError(entry.snapshot.error)
      })

      child.on('close', (code) => {
        // 正常路径已经在 result/error 事件里收尾了；这里兜底"进程静默退出"
        const phase = entry.snapshot.phase
        if (phase === 'done' || phase === 'failed' || phase === 'cancelled') {
          finish(jobId)
          return
        }
        entry.snapshot.phase = 'failed'
        entry.snapshot.error = `分析进程意外退出（code=${code}）`
        finish(jobId)
        opts.onError(entry.snapshot.error)
      })

      entry.timer = setTimeout(() => {
        entry.snapshot.phase = 'failed'
        entry.snapshot.error = '分析超时'
        killTree(child)
        finish(jobId)
        opts.onError('分析超时')
      }, DEFAULT_TIMEOUT_MS)
      // 超时定时器不能阻止进程退出
      entry.timer.unref?.()

      return jobId
    },

    status(jobId) {
      const job = jobs.get(jobId)
      return job ? { ...job.snapshot } : null
    },

    cancel(jobId) {
      const job = jobs.get(jobId)
      if (!job) return false
      if (job.snapshot.phase === 'done' || job.snapshot.phase === 'failed') return false
      job.cancelled = true
      job.snapshot.phase = 'cancelled'
      job.snapshot.message = '已取消'
      job.snapshot.error = undefined
      if (job.child) killTree(job.child)
      finish(jobId)
      return true
    },

    running() {
      return [...jobs.values()]
        .filter((job) => {
          const phase = job.snapshot.phase
          return phase !== 'done' && phase !== 'failed' && phase !== 'cancelled'
        })
        .map((job) => job.snapshot.jobId)
    },

    list() {
      pruneFinished()
      return [...jobs.values()]
        .map((job) => ({ ...job.snapshot }))
        .sort((a, b) => b.startedAt - a.startedAt)
    },
  }
}
