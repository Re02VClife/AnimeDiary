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
