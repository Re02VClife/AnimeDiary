/**
 * server/review-store — AI 影评的落盘
 *
 * 存储位置：`{DATA_DIR}/ai-reviews/{safeKey}/{series|ep03}.json`
 *
 * 和 `server/store.ts`（拉片报告）分开的理由：
 *   - **生命周期不同**：报告是客观测量，可以随时重算；影评是"AI 在某个时刻的看法"，
 *     重算会变，旧版本有对比价值，不能和报告放一起被清掉。
 *   - **清理策略不同**：删掉一集的报告不影响影评（影评里已经引用了那些时间码）；
 *     反过来删影评更不该动报告。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { AiReview, ReviewScope } from '../core/review-types'
import { keyToDirName } from './store'

export interface ReviewStore {
  /** 影评 JSON 的绝对路径 */
  path(key: string, scope: ReviewScope): string
  read(key: string, scope: ReviewScope): AiReview | null
  write(review: AiReview): void
  /** 列出这部番所有已生成的影评（系列 + 各集），按时间倒序 */
  list(key: string): AiReview[]
  remove(key: string, scope: ReviewScope): void
}

/** scope → 文件名：整部番用 `series.json`，单集用 `ep03.json`（补零便于排序） */
export function scopeToFileName(scope: ReviewScope): string {
  if (scope.kind === 'series') return 'series.json'
  return `ep${String(scope.episode).padStart(2, '0')}.json`
}

function atomicWriteJson(file: string, data: unknown): void {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const temporary = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`)
  try {
    const handle = fs.openSync(temporary, 'w')
    try {
      fs.writeSync(handle, JSON.stringify(data, null, 2))
      fs.fsyncSync(handle)
    } finally {
      fs.closeSync(handle)
    }
    fs.renameSync(temporary, file)
  } finally {
    try { fs.unlinkSync(temporary) } catch { /* 已 rename */ }
  }
}

export function createReviewStore(DATA_DIR: string): ReviewStore {
  const root = path.join(DATA_DIR, 'ai-reviews')

  function reviewPath(key: string, scope: ReviewScope): string {
    return path.join(root, keyToDirName(key), scopeToFileName(scope))
  }

  function read(key: string, scope: ReviewScope): AiReview | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(reviewPath(key, scope), 'utf8')) as AiReview
      // 结构版本不对就当没有：让上层重新生成，而不是拿半截数据渲染崩
      if (!parsed || parsed.schema !== 1 || typeof parsed.markdown !== 'string') return null
      return parsed
    } catch {
      return null
    }
  }

  function write(review: AiReview): void {
    atomicWriteJson(reviewPath(review.key, review.scope), review)
  }

  function list(key: string): AiReview[] {
    const dir = path.join(root, keyToDirName(key))
    let names: string[]
    try {
      names = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
    } catch {
      return []
    }
    const out: AiReview[] = []
    for (const name of names) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as AiReview
        if (parsed?.schema === 1) out.push(parsed)
      } catch { /* 坏文件跳过，不因一条坏数据整个列表读不出来 */ }
    }
    // 新的在前
    return out.sort((a, b) => (a.created < b.created ? 1 : -1))
  }

  function remove(key: string, scope: ReviewScope): void {
    try { fs.unlinkSync(reviewPath(key, scope)) } catch { /* 本来就没有 */ }
  }

  return { path: reviewPath, read, write, list, remove }
}
