/**
 * server/review-runs — 影评生成的「后台任务」表
 *
 * 为什么需要它：影评一次要 100–180 秒（推理模型先思考 80 秒才动笔），
 * 以前是**一次同步 HTTP 请求** —— 关掉面板/切走就等于取消，回来只能重跑、再花一次钱。
 * 现在生成跑在服务端内存任务里，HTTP 只负责「创建/查询/取消」：
 *
 *   POST /api/watch/review/run   → { runId }（立即返回）
 *   GET  /api/watch/review/run   → 快照（阶段 / 已生成字数 / 结果）
 *   POST /api/watch/review/cancel
 *
 * 任务表是**进程内的**：AnimeDiary 退出就没了。这是刻意的 —— 影评已经落盘在
 * `ai-reviews/`，进程重启后不需要"恢复任务"，只需要重新生成或读旧结果。
 *
 * 快照里的 `review` 只在 `get()` 返回（列表只给摘要），避免列表接口把几十份正文一起吐出来。
 */
import crypto from 'node:crypto'
import type { AiReview, ReviewRequest, ReviewScope } from '../core/review-types'
import type { ReviewProgressEvent } from './review'

/** 生成过程中的事件：阶段 + 模型吐字进度（delta 由 routes 的流式 describe 转进来） */
export type ReviewRunEvent =
  | ReviewProgressEvent
  | { type: 'delta'; chars: number; reasoningChars: number }

export type ReviewRunStatus = 'running' | 'done' | 'failed' | 'cancelled'

export interface ReviewRunSnapshot {
  runId: string
  key: string
  scope: ReviewScope
  status: ReviewRunStatus
  phase: 'collect' | 'call' | 'parse' | 'done'
  message: string
  /** 正文累计字符（模型还在思考时是 0） */
  chars: number
  /** 思维链累计字符（推理模型会先想几十秒） */
  reasoningChars: number
  startedAt: number
  finishedAt?: number
  cached?: boolean
  error?: string
  /** 只有 get() 给；list() 不带（列表要轻） */
  review?: AiReview
}

interface RunEntry {
  snapshot: ReviewRunSnapshot
  controller: AbortController
}

export interface ReviewRunFilter {
  key?: string
  scopeKind?: 'series' | 'episode'
  episode?: number
}

export interface ReviewRunManager {
  start(req: ReviewRequest): { runId: string }
  get(runId: string): ReviewRunSnapshot | null
  list(filter?: ReviewRunFilter): ReviewRunSnapshot[]
  cancel(runId: string): boolean
}

/** 结束的任务保留多久：够用户关/开面板来回；再久就清掉（内存里不攒正文） */
const RUN_TTL_MS = 30 * 60 * 1000

export interface ReviewRunManagerOptions {
  /**
   * 真正跑一次生成。必须把进度通过 onEvent 报回来 —— run manager 只做记账，不猜阶段。
   * 抛错 = 任务失败（错误原文进快照，前端显示）。
   */
  generate: (
    req: ReviewRequest,
    signal: AbortSignal,
    onEvent: (event: ReviewRunEvent) => void,
  ) => Promise<{ review: AiReview; cached: boolean }>
}

export function createReviewRunManager(opts: ReviewRunManagerOptions): ReviewRunManager {
  const runs = new Map<string, RunEntry>()

  function prune() {
    const now = Date.now()
    for (const [runId, entry] of runs) {
      const finishedAt = entry.snapshot.finishedAt
      if (finishedAt && now - finishedAt > RUN_TTL_MS) runs.delete(runId)
    }
  }

  /** 列表用的轻量副本：去掉 review 正文 */
  function summary(snapshot: ReviewRunSnapshot): ReviewRunSnapshot {
    const { review, ...rest } = snapshot
    void review
    return { ...rest }
  }

  return {
    start(req) {
      const runId = crypto.randomBytes(8).toString('hex')
      const controller = new AbortController()
      const snapshot: ReviewRunSnapshot = {
        runId,
        key: req.key,
        scope: req.scope,
        status: 'running',
        phase: 'collect',
        message: '排队中',
        chars: 0,
        reasoningChars: 0,
        startedAt: Date.now(),
      }
      runs.set(runId, { snapshot, controller })

      // 不 await：HTTP 立刻返回 runId，生成在后台继续
      void (async () => {
        try {
          const result = await opts.generate(req, controller.signal, (event) => {
            if (event.type === 'phase') {
              snapshot.phase = event.phase
              snapshot.message = event.message
              return
            }
            if (event.type === 'delta') {
              snapshot.chars = event.chars
              snapshot.reasoningChars = event.reasoningChars
              return
            }
            // done：generate 的 onEvent 已经带上结果，这里先记下来
            snapshot.status = 'done'
            snapshot.phase = 'done'
            snapshot.review = event.review
            snapshot.cached = event.cached
          })

          // 兜底：有的路径可能没发 done 事件（例如缓存命中只发 done、或异常分支）
          if (snapshot.status === 'running') {
            snapshot.status = 'done'
            snapshot.phase = 'done'
            snapshot.review = result.review
            snapshot.cached = result.cached
          }
        } catch (error) {
          snapshot.status = controller.signal.aborted ? 'cancelled' : 'failed'
          snapshot.error = error instanceof Error ? error.message : String(error)
        } finally {
          snapshot.finishedAt = Date.now()
        }
      })()

      return { runId }
    },

    get(runId) {
      const entry = runs.get(runId)
      if (!entry) return null
      return { ...entry.snapshot }
    },

    list(filter = {}) {
      prune()
      return [...runs.values()]
        .map((entry) => summary(entry.snapshot))
        .filter((snapshot) => {
          if (filter.key && snapshot.key !== filter.key) return false
          if (filter.scopeKind && snapshot.scope.kind !== filter.scopeKind) return false
          if (
            filter.episode !== undefined
            && Number.isInteger(filter.episode)
            && filter.episode > 0
            && (snapshot.scope.kind !== 'episode' || snapshot.scope.episode !== filter.episode)
          ) {
            return false
          }
          return true
        })
        .sort((a, b) => b.startedAt - a.startedAt)
    },

    cancel(runId) {
      const entry = runs.get(runId)
      if (!entry) return false
      if (entry.snapshot.status !== 'running') return false
      entry.controller.abort()
      entry.snapshot.status = 'cancelled'
      entry.snapshot.message = '已取消'
      entry.snapshot.finishedAt = Date.now()
      return true
    },
  }
}
