/**
 * ui/review-api — AI 影评的 HTTP 客户端
 *
 * 延续 `api.ts` 的三条约定：
 *   1. **只走相对路径**（dev 走 Vite 的 /api，生产走 Electron 本地服务的 /api，
 *      两边是同一个 createApiHandler；UI 不猜 host、不拼端口）；
 *   2. **失败统一抛 Error**，调用方只写 try/catch；
 *   3. **二进制不经过这里** —— 影评正文里的 `![](/api/watch/sheet?...)`
 *      直接交给 `<img src>`，不 fetch、不转 base64。
 *
 * 和 `api.ts` 有两处不同，都是影评这个功能自己的性质决定的：
 *
 *   - **生成是同步长请求**（后端要逐张看分镜图，30–180 秒），必须能把
 *     `AbortSignal` 透传给 fetch —— 关面板/点「取消」时才真的断掉连接，
 *     而不是只在 UI 上假装停了。
 *   - **`resolve` / `review/meta` 是可降级的辅助信息**：后端还没实现、404 或
 *     网络失败时一律返回 `null`，让面板显示「读不到，可手动填写」/「未知」。
 *     这是任务书的硬要求，不要改成抛错（否则详情面板会因为一个辅助字段整块崩）。
 */
import type { AiReview, ReviewRequest, ReviewResponse, ReviewScope } from '../core/review-types'

const API_BASE = '/api/watch'

/** 默认预算：200 万 token（与后端 `server/review.ts` 的 DEFAULT_BUDGET 对齐） */
export const DEFAULT_REVIEW_BUDGET = 2_000_000

/**
 * 影评默认**每集**看几张分镜图（与后端 `DEFAULT_MAX_SHEETS` 的口径不同：后端是总数）。
 *
 * 2026-11-17 实测：单集 200 张 = 117 秒 / 17.2 万输入 token，完全可行。
 * 整季时前端会按集数累加（6 集 × 200 = 1200 张），后端上限 6000。
 */
export const DEFAULT_REVIEW_SHEETS = 20

/** **每集**最多看几张图（整季会按集数累加，后端硬上限 6000） */
export const MAX_REVIEW_SHEETS = 1000

/**
 * `GET /api/watch/review/meta` 的客户端形状。
 *
 * 后端读不到时这里整块返回 `null`（不是抛错），UI 显示「未知」。
 */
export interface ReviewMeta {
  model: string
  promptVersion: string
  budgetLimit: number
}

/**
 * 生成影评的请求体。
 *
 * ⚠️ **契约缺口**：`core/review-types.ts` 的 `ReviewRequest` / `ReviewOptions`
 * 里没有「手动指定的视频绝对路径」字段，但配置页要求手动路径「会随请求发给后端」。
 * 这里作为**顶层扩展字段 `file`** 发送：后端认它就用、不认就当未知字段忽略
 * （JSON 未知字段不会让接口报错）。这条已写进交付报告，等 `review-types.ts`
 * 正式补字段后把扩展接口删掉即可 —— **不要**偷偷去改已冻结的契约文件。
 */
export interface ReviewGenerateRequest extends ReviewRequest {
  /** 手动指定的视频绝对路径（扩展字段，见上） */
  file?: string
}

/** 一次生成的结果；`cached=true` 表示后端返回的是上次落盘的结果 */
export interface GenerateReviewResult {
  review: AiReview
  cached: boolean
}

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

/**
 * 是不是「用户主动取消」。
 *
 * fetch 被 abort 时抛的是 `DOMException(name='AbortError')`；调用方要把它和
 * 真正的失败分开 —— 取消不该弹错误 Alert。
 */
export function isAbortError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false
  return (e as { name?: unknown }).name === 'AbortError'
}

/** 读 JSON；服务端异常时可能返回 HTML/纯文本，这里给出可读的兜底错误 */
async function readJson(resp: Response): Promise<unknown> {
  const text = await resp.text()
  if (!text) return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(text.slice(0, 200) || `HTTP ${resp.status}`)
  }
}

/** 读 JSON 的「降级版」：解析不了就返回 null，供 resolve/meta/review 这类可降级接口用 */
async function readJsonOrNull(resp: Response): Promise<Record<string, unknown> | null> {
  try {
    const text = await resp.text()
    if (!text) return {}
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * 发请求并做统一的错误转换（与 api.ts 的 requestJson 同语义）。
 *
 * 判定顺序：**先看 body 里的 error**（比 HTTP 状态码更具体），再看 `resp.ok`。
 * abort 要原样抛出去，不能包成「连不上」——否则调用方分不清「用户取消」和「服务没起」。
 */
async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  let resp: Response
  try {
    resp = await fetch(url, init)
  } catch (e) {
    if (isAbortError(e)) throw e
    throw new Error(`连不上本地分析服务：${errorText(e)}`)
  }

  const body = await readJson(resp)
  const errorBody = (body && typeof body === 'object' ? body : {}) as { error?: string }
  if (typeof errorBody.error === 'string' && errorBody.error.length > 0) {
    throw new Error(errorBody.error)
  }
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  return body as T
}

/**
 * 生成影评（同步长请求）。
 *
 * 成功返回 `{ review, cached }`；`cached=true` 说明后端命中了上次落盘的结果
 * （没传 `options.force` 时同模型同提示词版本直接复用，避免点两次扣两次钱）。
 * 失败抛 Error（错误原文直接给用户看）；被 abort 时抛 AbortError，调用方用
 * `isAbortError()` 判掉，不当失败处理。
 */
export async function generateReview(
  request: ReviewGenerateRequest,
  signal?: AbortSignal,
): Promise<GenerateReviewResult> {
  const data = await requestJson<ReviewResponse>(`${API_BASE}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  })
  if (!data.ok || !data.review) {
    throw new Error(data.error || '服务端没有返回影评内容')
  }
  return { review: data.review, cached: data.cached === true }
}

/**
 * 生成过程中的进度事件。
 *
 * 服务端在 SSE 里推的是这三类（见 `server/routes.ts` 的 review 分支）：
 *   - `phase`：服务端**真实知道**的阶段（整理输入 / 交给模型 / 解析落盘）
 *   - `delta`：模型吐字进度。`chars` 是正文累计字符，`reasoningChars` 是思维链累计
 *     （推理模型会先想很久，正文一个字都没有 —— 两种情况要分开显示，不能让人以为卡死）
 *   - `done` / `error`
 */
export type ReviewStreamEvent =
  | {
      type: 'phase'
      phase: 'collect' | 'call' | 'parse'
      message: string
      sheets?: number
      episodes?: number[]
      shots?: number
    }
  | { type: 'delta'; chars: number; reasoningChars: number }
  | { type: 'done'; review: AiReview; cached: boolean }
  | { type: 'error'; message: string }

/**
 * 生成影评（流式，带真实进度）。
 *
 * 与 `generateReview`（同步 JSON）的区别：这里带 `Accept: text/event-stream`，
 * 服务端会边跑边推 `phase` / `delta`，前端能显示「正在看 6 张分镜图」「已生成 1234 字」。
 * 服务端不支持 SSE 时（旧版本）自动降级成一次 JSON 响应 —— 功能不能因为"要进度"而断掉。
 *
 * 取消：`signal` 直接透传给 fetch；abort 时抛 AbortError，调用方按取消处理。
 */
export async function generateReviewStream(
  request: ReviewGenerateRequest,
  signal: AbortSignal | undefined,
  onEvent: (event: ReviewStreamEvent) => void,
): Promise<GenerateReviewResult> {
  let resp: Response
  try {
    resp = await fetch(`${API_BASE}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(request),
      signal,
    })
  } catch (e) {
    if (isAbortError(e)) throw e
    throw new Error(`连不上本地分析服务：${errorText(e)}`)
  }

  const contentType = resp.headers.get('content-type') || ''

  // 旧服务端 / 中间层把 SSE 缓冲掉：退回一次 JSON，进度就只有「首尾两帧」
  if (!contentType.includes('text/event-stream')) {
    const body = (await readJson(resp)) as {
      ok?: boolean
      review?: AiReview
      cached?: boolean
      error?: string
    }
    if (!resp.ok || !body.ok || !body.review) {
      throw new Error(body.error || `HTTP ${resp.status}`)
    }
    const done: GenerateReviewResult = { review: body.review, cached: body.cached === true }
    onEvent({ type: 'done', ...done })
    return done
  }

  if (!resp.body) throw new Error('服务端没有返回可读的流')

  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let result: GenerateReviewResult | null = null

  /** 一个 SSE 事件块（`data: {...}` 可多行）；解析失败的行直接跳过，不让脏数据打断整条流 */
  const handleChunk = (raw: string): void => {
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload) continue
      let event: ReviewStreamEvent
      try {
        event = JSON.parse(payload) as ReviewStreamEvent
      } catch {
        continue
      }
      if (event.type === 'error') throw new Error(event.message || '生成失败（服务端没有给原因）')
      if (event.type === 'done') result = { review: event.review, cached: event.cached }
      onEvent(event)
    }
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index = buffer.indexOf('\n\n')
    while (index >= 0) {
      handleChunk(buffer.slice(0, index))
      buffer = buffer.slice(index + 2)
      index = buffer.indexOf('\n\n')
    }
  }
  if (buffer.trim()) handleChunk(buffer)

  const finished = result as GenerateReviewResult | null
  if (!finished) throw new Error('服务端没有返回影评结果（流被提前关闭）')
  return finished
}

/* ─────────────────────────────────────────────────────────
 * 后台任务（关掉面板也继续跑）
 * ───────────────────────────────────────────────────────── */

/**
 * 服务端一个影评任务的快照（`GET /api/watch/review/run?id=`）。
 *
 * 和 SSE 事件的区别：这是**轮询**读的持久状态，关掉面板再回来看得到同一份；
 * `status` 到 `done` 时 `review` 才出现。
 */
export interface ReviewRunSnapshot {
  runId: string
  key: string
  scope: ReviewScope
  status: 'running' | 'done' | 'failed' | 'cancelled'
  phase: 'collect' | 'call' | 'parse' | 'done'
  message: string
  chars: number
  reasoningChars: number
  startedAt: number
  finishedAt?: number
  cached?: boolean
  error?: string
  review?: AiReview
}

/** 创建后台生成任务。立即返回 runId，生成在服务端继续（关面板不影响）。 */
export async function startReviewRun(request: ReviewGenerateRequest): Promise<{ runId: string }> {
  const data = await requestJson<{ ok: boolean; runId?: string; error?: string }>(
    `${API_BASE}/review/run`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    },
  )
  if (!data.ok || !data.runId) throw new Error(data.error || '服务端没有返回任务 id')
  return { runId: data.runId }
}

/** 读任务快照。404/失效返回 null（前端据此停止轮询，不弹错）。 */
export async function getReviewRun(runId: string): Promise<ReviewRunSnapshot | null> {
  try {
    const resp = await fetch(`${API_BASE}/review/run?id=${encodeURIComponent(runId)}`)
    if (resp.status === 404) return null
    const body = await readJsonOrNull(resp)
    if (!body || body.ok !== true || !body.run || typeof body.run !== 'object') return null
    return body.run as ReviewRunSnapshot
  } catch {
    return null
  }
}

/** 列某部番（某个范围）的任务，用来在面板重新打开时接回进行中的那一次。 */
export async function listReviewRuns(filter: {
  key: string
  scope: ReviewScope
}): Promise<ReviewRunSnapshot[]> {
  try {
    const params = new URLSearchParams({ key: filter.key, kind: filter.scope.kind })
    if (filter.scope.kind === 'episode') params.set('episode', String(filter.scope.episode))
    const resp = await fetch(`${API_BASE}/review/runs?${params.toString()}`)
    if (!resp.ok) return []
    const body = await readJsonOrNull(resp)
    const runs = body?.runs
    return Array.isArray(runs) ? (runs as ReviewRunSnapshot[]) : []
  } catch {
    return []
  }
}

/** 取消任务。任务已结束/不存在时返回 false（前端安静收尾）。 */
export async function cancelReviewRun(runId: string): Promise<boolean> {
  try {
    const data = await requestJson<{ ok?: boolean; cancelled?: boolean }>(
      `${API_BASE}/review/cancel`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId }),
      },
    )
    return data.cancelled === true || data.ok === true
  } catch {
    return false
  }
}

/**
 * 读已生成的影评。
 *
 * 契约里「没有结果」是 `200 + { ok:false, error }`，**不是**请求失败，所以这里
 * 返回 `null`（面板据此显示空状态），只有网络/HTTP 5xx 才抛错。
 * 后端还没挂上这个路由时是 404 —— 同样降级成 `null`，面板不该因为后端未就绪而报错。
 */
export async function getExistingReview(
  key: string,
  scope: ReviewScope,
  signal?: AbortSignal,
): Promise<AiReview | null> {
  const params = new URLSearchParams({ key, kind: scope.kind })
  if (scope.kind === 'episode') params.set('episode', String(scope.episode))
  const url = `${API_BASE}/review?${params.toString()}`

  let resp: Response
  try {
    resp = await fetch(url, { signal })
  } catch (e) {
    if (isAbortError(e)) throw e
    throw new Error(`连不上本地分析服务：${errorText(e)}`)
  }

  if (resp.status === 404) return null

  const body = await readJsonOrNull(resp)
  if (!body) throw new Error(`读取已有影评失败：HTTP ${resp.status}`)
  if (!resp.ok) {
    throw new Error(typeof body.error === 'string' && body.error ? body.error : `HTTP ${resp.status}`)
  }
  if (body.ok === true && body.review && typeof body.review === 'object') {
    return body.review as AiReview
  }
  return null
}

/**
 * 某部番已经做过拉片分析的集号（升序）。
 *
 * 这是配置页「选集」的数据来源：没分析过的集生成不出影评，所以不列进选项，
 * 也不去猜总集数。契约只声明了 `ok:true` 的情况，失败按约定抛错。
 */
export async function listAnalyzedEpisodes(key: string): Promise<number[]> {
  const data = await requestJson<{ ok: boolean; episodes?: unknown; error?: string }>(
    `${API_BASE}/episodes?key=${encodeURIComponent(key)}`,
  )
  const raw = Array.isArray(data.episodes) ? data.episodes : []
  const episodes = raw.filter(
    (value): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0,
  )
  if (data.ok !== true && episodes.length === 0) {
    throw new Error(data.error || '读取已分析集号失败')
  }
  return episodes.sort((a, b) => a - b)
}

/**
 * 解析某一集视频的本地绝对路径（配置页只读展示用）。
 *
 * **可降级**：后端没实现 / 404 / 网络失败一律返回 `null`，面板显示
 * 「读不到，可手动填写」并允许用户手动指定。不要改成抛错。
 */
export async function resolveVideoFile(key: string, episode: number): Promise<string | null> {
  const url = `${API_BASE}/resolve?key=${encodeURIComponent(key)}&episode=${episode}`
  try {
    const resp = await fetch(url)
    if (!resp.ok) return null
    const body = await readJsonOrNull(resp)
    if (!body || body.ok === false) return null
    return typeof body.file === 'string' && body.file.length > 0 ? body.file : null
  } catch {
    return null
  }
}

/**
 * 读影评生成用的模型 / 提示词版本 / 默认预算。
 *
 * **可降级**：404 或失败返回 `null`，面板显示「未知」。字段缺失的单项用
 * 「未知」/ 默认预算兜底，保证 UI 永远有东西可显示。
 */
export async function getReviewMeta(): Promise<ReviewMeta | null> {
  try {
    const resp = await fetch(`${API_BASE}/review/meta`)
    if (!resp.ok) return null
    const body = await readJsonOrNull(resp)
    if (!body || body.ok === false) return null

    const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : '未知'
    const promptVersion =
      typeof body.promptVersion === 'string' && body.promptVersion.trim()
        ? body.promptVersion.trim()
        : '未知'
    const budgetLimit =
      typeof body.budgetLimit === 'number' && Number.isFinite(body.budgetLimit) && body.budgetLimit > 0
        ? body.budgetLimit
        : DEFAULT_REVIEW_BUDGET
    return { model, promptVersion, budgetLimit }
  } catch {
    return null
  }
}
