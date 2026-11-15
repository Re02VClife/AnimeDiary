/**
 * ui/api — /api/watch/* 的前端客户端
 *
 * 三条约定（和宿主其它 feature 的 service 保持一致）：
 *
 * 1. **只走相对路径**。dev 下页面在 Vite（5173），打包后页面在 Electron 本地服务
 *    （127.0.0.1:51730），两边都通过同一个 createApiHandler 提供 `/api`；
 *    UI 不猜 host、不拼端口，否则换一种运行方式就得改代码。
 * 2. **错误统一抛 Error**。契约里 `{ ok:false, error }` 一律转成 `Error(message)`，
 *    调用方只写 try/catch，不用逐处判 ok。
 *    例外有两个：
 *      - `/deps` 的 `ok` 表示「必装依赖是否齐全」，依赖不全时 `ok=false` 却没有
 *        `error` —— 那是**正常结果**而不是请求失败；
 *      - `/cancel` 的 `ok=false` 表示「这个任务已经结束/不存在」，同样不是 HTTP 失败，
 *        它该由随后的状态轮询给出最终结论，不该在这里弹错误。
 * 3. **二进制不经过这里**。`/sheet` 返回 PNG，直接给 `<img src>` / antd `Image`
 *    用相对 URL 即可（见 `sheetUrl`），不 fetch、不转 base64。
 *
 * 本文件不 import 任何 `src/`、`server/`：UI 是插件自己的前端，宿主只负责挂载。
 *
 * ── 与任务书契约的两处对齐（Phase 1 后端实现已落地，以实际代码为准）──
 *   a) `POST /analyze` 的 body 现在**必须带 `file`（视频绝对路径）**，只给 key+episode
 *      会 400「缺少 file」。任务书契约写的是 `{ key, episode, options? }`，这里把
 *      file 做成 `analyze` 的可选第 4 参：不传就按契约只发 key/episode，传了才带 file。
 *   b) `GET /sheet` 现在按 `file`（报告里 `Sheet.file`，相对本集 sheet 目录的文件名）取图，
 *      不是任务书写的 `n`。`sheetUrl` 同时带 `n` 和 `file` —— 后备实现按哪个取都成立，
 *      传参签名也保持任务书要求的 `(key, episode, n)`。
 */
import type { WatchReport } from '../core/types'
import type { AnalyzeResponse, ReportResponse, StatusResponse } from '../runtime/protocol'
import type { RenderStrategy } from '../ports/render'

/** `/api/watch/status` 返回的任务快照（形状以 runtime/protocol.ts 的 StatusResponse.job 为准） */
export type WatchJobStatus = NonNullable<StatusResponse['job']>

/**
 * 依赖自检项。
 *
 * 刻意不在 UI 里 import `server/deps.ts`：那是 Node 侧模块（child_process / fs），
 * 拖进前端 bundle 会把 node 内置模块一起打进去。这里按 HTTP 契约声明一份形状，
 * 两边对不上时靠 tsc 之外的手工核对 —— 字段在 server/deps.ts 里有注释。
 */
export interface WatchDependency {
  /** 稳定 id，UI 按它分组/去重 */
  id: string
  label: string
  ok: boolean
  /** 缺了会不会导致整条链路不可用 */
  required: boolean
  version?: string
  path?: string
  /** ok=false 时：怎么补（一行，可直接复制） */
  hint?: string
  /** 补充说明 */
  detail?: string
}

/** GET /api/watch/deps 的响应 */
export interface DepsResponse {
  /** 必装依赖是否齐全（注意：不是「请求是否成功」） */
  ok: boolean
  /** 能不能开始分析 */
  canRun: boolean
  deps: WatchDependency[]
  /** 缺失的必装项 id */
  missingRequired: string[]
}

/**
 * 开始分析时的可选项。
 *
 * 只列 UI 能决定的那些。服务端的 `WatchAnalyzeOptions` 里还有 `outDir` / `prefix` /
 * `budget` 这类由主进程填的字段，前端不该传（也传不了）。
 */
export interface AnalyzeOptions {
  /** 宫格排版策略，默认 auto */
  strategy?: RenderStrategy
  /** 最多取多少帧；0 = 不封顶 */
  maxFrames?: number
  /** 最多几张图；0 = 不封顶 */
  maxSheets?: number
  /** 单图像素预算 */
  budgetPixels?: number
  /** 台词来源：auto 走字幕轨/ASR，off 不要台词 */
  transcript?: 'auto' | 'off'
  /** 只分析这一段（秒） */
  from?: number
  to?: number
}

const API_BASE = '/api/watch'

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
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

/**
 * 发请求并做统一的错误转换。
 *
 * 判定顺序很重要：**先看 body 里的 error**（它比 HTTP 状态码更具体），
 * 再看 `resp.ok`。`ok:false` 且没有 error 的响应原样返回，交给调用方判断语义
 * （目前只有 /deps 会这样）。
 */
async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  let resp: Response
  try {
    resp = await fetch(url, init)
  } catch (e) {
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
 * 启动一次分析。返回的 jobId 用于轮询状态和取消。
 *
 * `file` 是视频绝对路径：任务书契约里由服务端自己解析，所以不要求传；
 * 但当前 Phase 1 的 /analyze 实现要求 body.file，宿主若能拿到本地库路径就传进来
 * （见 WatchTab 的 `videoFile` prop），两边实现都能跑。
 */
export async function analyze(
  key: string,
  episode: number,
  options?: AnalyzeOptions,
  file?: string,
): Promise<{ jobId: string }> {
  const payload: { key: string; episode: number; options?: AnalyzeOptions; file?: string } = {
    key,
    episode,
  }
  if (options) payload.options = options
  if (file) payload.file = file

  const data = await requestJson<AnalyzeResponse>(`${API_BASE}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!data.ok || !data.jobId) throw new Error(data.error || '分析任务没有启动（服务端没有返回 jobId）')
  return { jobId: data.jobId }
}

/** 查询任务快照。轮询用，1.5s 一次就够，不要更密。 */
export async function getStatus(jobId: string): Promise<WatchJobStatus> {
  const data = await requestJson<StatusResponse>(
    `${API_BASE}/status?jobId=${encodeURIComponent(jobId)}`,
  )
  if (!data.ok || !data.job) throw new Error(data.error || '任务状态不可用（可能已被服务端清理）')
  return data.job
}

/**
 * 取消任务。服务端负责杀 worker 子进程树，这里只负责把请求发出去。
 *
 * `ok=false` 只说明「这个 job 不在可取消状态」（已经结束 / 进程重启后丢了），
 * 不是请求失败 —— 不抛错，让调用方的状态轮询给出最终结论。
 */
export async function cancel(jobId: string): Promise<void> {
  const data = await requestJson<{ ok: boolean; cancelled?: boolean; error?: string }>(
    `${API_BASE}/cancel`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId }),
    },
  )
  if (data.ok === false && data.error) throw new Error(data.error)
}

/** 读取已落盘的报告。没跑过分析时抛错（调用方据此显示引导）。 */
export async function getReport(key: string, episode: number): Promise<WatchReport> {
  const data = await requestJson<ReportResponse>(
    `${API_BASE}/report?key=${encodeURIComponent(key)}&episode=${episode}`,
  )
  if (!data.ok || !data.report || typeof data.report !== 'object') {
    throw new Error(data.error || '这一集还没有分析报告')
  }
  // protocol.ts 冻结时把 report 声明成了 unknown（不想让 runtime 反向依赖 core 之外的形状），
  // 这里按 WatchReport 收窄；字段层面的兜底由各组件自己做（缺字段就不渲染那一块）。
  return data.report as WatchReport
}

/**
 * 宫格图的相对 URL，直接塞给 `<img src>` / `<Image src>`。
 *
 * `n` 是 sheets 数组下标（任务书契约 `?key=&episode=&n=`）；
 * 当前 Phase 1 后端按 `file`（报告里 `Sheet.file`，本集 sheet 目录下的文件名）取图，
 * 所以可选传入 `file` 一并带上 —— 两种实现都认，缺哪个都不会 404。
 */
export function sheetUrl(key: string, episode: number, n: number, file?: string): string {
  const base = `${API_BASE}/sheet?key=${encodeURIComponent(key)}&episode=${episode}&n=${n}`
  return file ? `${base}&file=${encodeURIComponent(file)}` : base
}

/**
 * 依赖自检。**注意**：`ok=false` 只代表缺必装依赖，不代表请求失败，
 * 所以这里不会因为 ok=false 抛错（requestJson 只按 error / HTTP 状态判失败）。
 */
export async function getDeps(): Promise<DepsResponse> {
  const data = await requestJson<DepsResponse>(`${API_BASE}/deps`)
  if (!Array.isArray(data.deps)) throw new Error('依赖自检返回的数据不完整（缺少 deps 数组）')

  const missingRequired = Array.isArray(data.missingRequired)
    ? data.missingRequired
    : data.deps.filter((d) => d.required && !d.ok).map((d) => d.id)

  return {
    ok: data.ok === true,
    canRun: data.canRun === true,
    deps: data.deps,
    missingRequired,
  }
}
