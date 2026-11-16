/**
 * server/routes — /api/watch/* 路由
 *
 * 端点一览：
 *   GET  /api/watch/ping          插件挂载成功没有
 *   GET  /api/watch/deps          依赖自检（ffmpeg / python / 分镜引擎 / ASR / MEE）
 *   POST /api/watch/vision-test   真发一张图给模型，确认多模态链路通
 *   POST /api/watch/analyze       起一个分析任务 → { jobId }
 *   GET  /api/watch/status        任务进度
 *   POST /api/watch/cancel        取消任务（杀进程树）
 *   GET  /api/watch/report        读落盘报告
 *   GET  /api/watch/sheet         读宫格图（PNG）
 *   GET  /api/watch/episodes      某一部番已经分析过的集号
 *
 * 路由层只做三件事：解析请求、调 runtime、回 JSON/二进制。
 * 任何"怎么切镜""怎么排版"的逻辑都不许出现在这个文件里。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAIClient, AIGatewayError } from '../../../server/ai-gateway'
import type { AIUsage } from '../../../server/ai-gateway'
import { checkDependencies } from './deps'
import type { DependencyStatus } from './deps'
import { createWatchStore } from './store'
import { createReviewStore } from './review-store'
import { createReviewGenerator, REVIEW_PROMPT_VERSION } from './review'
import type { ReviewGenerator } from './review'
import { createReviewRunManager } from './review-runs'
import { createWatchSettings } from './settings'
import { resolvePerformance } from '../core/performance'
import { createAnalyzer, resolveWorkerPath } from '../runtime/pipeline'
import type { WatchAnalyzer } from '../runtime/pipeline'
import type { WatchAnalyzeOptions } from '../runtime/protocol'
import type { ReviewScope } from '../core/review-types'

interface RouterLike {
  use(prefix: string, handler: (req: any, res: any) => void): void
}

export interface WatchRoutesOptions {
  DATA_DIR: string
  fetchImpl?: (url: string, init?: Record<string, unknown>) => Promise<any>
  /**
   * 由宿主注入：按「模板::标题 + 集号」解析出本地视频的绝对路径。
   *
   * 为什么不让前端传 file：前端只知道 `dirPath + relPath`（本地番剧库的
   * `LocalFolder.dirPath` / `LocalEpisode.relPath`），拼绝对路径是**平台相关**的
   * （Windows 反斜杠、UNC、盘符大小写），而且把"这台机器的磁盘路径"暴露给页面没什么好处。
   * 宿主侧已经有 `createLocalLibrary`，让它解析最省事。
   *
   * 返回 null = 这一集没绑定/找不到，路由会回 400 并告诉用户去「设置 → 本地」绑定目录。
   */
  resolveLocalFile?: (key: string, episode: number) => string | null
}

function sendJson(res: any, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

function readJsonBody(req: any, limitBytes = 1024 * 1024): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limitBytes) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf-8')
      if (!text) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch (e) {
        reject(new Error(`请求体不是合法 JSON：${e instanceof Error ? e.message : e}`))
      }
    })
    req.on('error', reject)
  })
}

/** 从 URL 取参数（宿主没帮我们解析，所以每次自己 new URL） */
function query(req: any): URLSearchParams {
  try {
    return new URL(req.url || '/', 'http://localhost').searchParams
  } catch {
    return new URLSearchParams()
  }
}

/** 读软件版本：dev 走 cwd，打包后读不到就记 unknown（它只是报告里的元数据） */
function readAppVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * 自检用的测试图：64×64，深绿底 + 红色圆。
 *
 * 为什么内置而不是现场画：这张图唯一的作用是「确认模型真的收到了像素」，
 * 它必须**在所有机器上都一样**（同样的字节、同样的 token 数），
 * 现场生成会因为编码器差异导致结果不可比。
 */
const VISION_TEST_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA' +
  '7DAcdvqGQAAAF0SURBVHhe7dA7bsQwDAXAPcteN4feQEWAYCCvZX1sCWIxDQvy8b3eP+/Pzl4OdhMFONhNFOBgN1GAg91EAQ5G+bxel7ljhKEF+FAL' +
  'd/cypADD9+StVl0LMOxI3q7VrQAD3sEMNboUYLA7meWq5gIM9AQzXdFUgEGeZLZS1QUYYAZmLFFVgIdnYtYzlwvw4IzM/E0U4OAbD83M7EeiAAdHPLA' +
  'Cf8iJAhwccfkK/CGnqAAXr8RfFAU4yHHpSvxFUYCDHJeuxF8UBTiQC1fjPzotIHHpSvxFUYCDHJeuxF8UBTjIcelK/EVRgIMjLl6BP+REAQ6OuHwF/pB' +
  'TXEDigZmZ/UgU4OCMh2Zk5m+iAAclPDgTs56pKiDx8AzMWKK6gMQATzJbqaYCEoM8wUxXNBeQGOhOZrmqSwGJwe5ghhrdCkgMOJK3a3Ut4I9he/JWqyE' +
  'F/DF8C3f3MrSA/3yohDtGuK2AWUUBDnYTBTjYTRTgYDfbF/ALKKQxY+4d7l4AAAAASUVORK5CYII='

interface VisionTestResult {
  ok: boolean
  answer?: string
  usage?: AIUsage
  model?: string
  provider?: string
  latencyMs?: number
  error?: string
  errorCode?: string
  hint?: string
}

async function runVisionTest(client: ReturnType<typeof createAIClient>): Promise<VisionTestResult> {
  try {
    const result = await client.chat({
      messages: [
        { role: 'system', content: '你是一个图片描述器。只描述你实际看到的内容，不要推测、不要客套。' },
        {
          role: 'user',
          content: [
            { type: 'text', text: '这张图里有什么？只回答底色和图形，20 个字以内。' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${VISION_TEST_PNG}`, detail: 'low' } },
          ],
        },
      ],
      maxTokens: 256,
      purpose: 'watch-vision-test',
    })
    return {
      ok: true,
      answer: result.content,
      usage: result.usage,
      model: result.model,
      provider: result.provider,
      latencyMs: result.latencyMs,
    }
  } catch (e) {
    const gw = e instanceof AIGatewayError ? e : null
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      errorCode: gw?.code,
      hint: gw?.code === 'no_config' || gw?.code === 'no_key'
        ? '先在「设置 → AI」里配好 provider 和 API Key'
        : '模型可能不支持图片输入；换一个多模态模型再试',
    }
  }
}

function looksLikeItSaw(answer: string | undefined): boolean {
  if (!answer) return false
  const text = answer.toLowerCase()
  return /绿|green|红|red/.test(text) && /圆|circle|round|圆点/.test(text)
}

/** 分析请求的 options 白名单：前端传什么就收什么，其余一律丢弃 */
function pickAnalyzeOptions(raw: any): Partial<WatchAnalyzeOptions> {
  const out: Partial<WatchAnalyzeOptions> = {}
  if (!raw || typeof raw !== 'object') return out
  if (typeof raw.strategy === 'string') out.strategy = raw.strategy as WatchAnalyzeOptions['strategy']
  if (Number.isFinite(raw.maxFrames)) out.maxFrames = Math.max(0, Math.round(raw.maxFrames))
  if (Number.isFinite(raw.minSheets)) out.minSheets = Math.min(10_000, Math.max(0, Math.round(raw.minSheets)))
  if (Number.isFinite(raw.maxSheets)) out.maxSheets = Math.min(10_000, Math.max(0, Math.round(raw.maxSheets)))
  if (Number.isFinite(raw.budgetPixels)) out.budgetPixels = Math.max(100_000, Math.round(raw.budgetPixels))
  if (raw.transcript === 'auto' || raw.transcript === 'off' || raw.transcript === 'asr') {
    out.transcript = raw.transcript
  }
  if (Number.isFinite(raw.from)) out.from = Math.max(0, Number(raw.from))
  if (Number.isFinite(raw.to)) out.to = Math.max(0, Number(raw.to))
  return out
}

export function registerWatchRoutes(router: RouterLike, opts: WatchRoutesOptions): void {
  // ── 依赖注装（一次性）──
  const store = createWatchStore(opts.DATA_DIR)
  const appVersion = readAppVersion()
  /** 性能设置落盘在 DATA_DIR，每次分析前重读（用户可能刚改过） */
  const watchSettings = createWatchSettings(opts.DATA_DIR)
  let analyzer: WatchAnalyzer | null = null
  function getAnalyzer(): WatchAnalyzer {
    analyzer ??= createAnalyzer({
      DATA_DIR: opts.DATA_DIR,
      workerPath: resolveWorkerPath(),
      store,
      appVersion,
      performance: () => {
        const settings = watchSettings.read()
        return { ...resolvePerformance(settings, os.cpus().length), priority: settings.priority }
      },
    })
    return analyzer
  }

  // AI 客户端延迟创建：大多数 /api/watch/* 端点不需要它
  let client: ReturnType<typeof createAIClient> | null = null
  function getClient() {
    client ??= createAIClient({ DATA_DIR: opts.DATA_DIR, fetchImpl: opts.fetchImpl })
    return client
  }

  /**
   * 流式 describe —— SSE 与「后台影评任务」共用同一份实现。
   *
   * 两处唯一区别是 `onDelta` 把累计字数写到哪：SSE 直接写响应流，后台任务写进内存快照。
   * 网关不支持「JSON 输出 + stream」时自动退回一次性生成，并通过 `onFallback` 告诉 UI。
   */
  function createStreamingDescribe(
    onDelta: (chars: number, reasoningChars: number) => void,
    onFallback?: () => void,
  ) {
    let contentChars = 0
    let reasoningChars = 0

    return async ({
      system,
      prompt,
      images,
      jsonMode,
      maxTokens,
      timeoutMs,
      signal,
    }: {
      system: string
      prompt: string
      images: string[]
      jsonMode: boolean
      maxTokens: number
      timeoutMs: number
      signal?: AbortSignal
    }) => {
      const messages = [
        { role: 'system' as const, content: system },
        {
          role: 'user' as const,
          content: [
            { type: 'text' as const, text: prompt },
            ...images.map((url) => ({
              type: 'image_url' as const,
              image_url: { url, detail: 'high' as const },
            })),
          ],
        },
      ]

      /** 统一 chat / chatStream 两种结果的形状（review.ts 只认 text/usage/model） */
      const toResult = (result: {
        content: string
        usage: { promptTokens: number; completionTokens: number; totalTokens: number; reasoningTokens?: number }
        model: string
      }) => ({
        text: result.content,
        usage: {
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          totalTokens: result.usage.totalTokens,
          ...(result.usage.reasoningTokens ? { reasoningTokens: result.usage.reasoningTokens } : {}),
        },
        model: result.model,
      })

      try {
        const result = await getClient().chatStream(
          { messages, maxTokens, jsonMode, timeoutMs, purpose: 'watch-review', signal },
          (event) => {
            if (event.type === 'reasoning') reasoningChars += event.text?.length ?? 0
            else if (event.type === 'delta') contentChars += event.text?.length ?? 0
            else return
            onDelta(contentChars, reasoningChars)
          },
        )
        return toResult(result)
      } catch (error) {
        if (signal?.aborted) throw error
        // 有的网关对「JSON 输出 + stream」直接 400。看进度不该把功能弄没：退回一次性生成。
        onFallback?.()
        const result = await getClient().chat({
          messages, maxTokens, jsonMode, timeoutMs, purpose: 'watch-review', signal,
        })
        contentChars = result.content.length
        onDelta(contentChars, 0)
        return toResult(result)
      }
    }
  }

  // ── AI 影评 ──
  const reviewStore = createReviewStore(opts.DATA_DIR)

  /**
   * 影评后台任务：关掉面板/切走都不再取消，重新打开可以接回进度。
   *
   * 任务表只在内存里 —— 进程退出就结束（影评本身已经落盘，重开读旧结果即可）。
   * 这里用流式 describe，但**不往外推 SSE**：进度写进内存快照，前端轮询读取。
   */
  const reviewRuns = createReviewRunManager({
    generate: (req, signal, onEvent) => {
      const generator = createReviewGenerator({
        store,
        reviewStore,
        appVersion,
        describe: createStreamingDescribe(
          (chars, reasoningChars) => onEvent({ type: 'delta', chars, reasoningChars }),
          () => onEvent({ type: 'phase', phase: 'call', message: '流式不可用，改用一次性生成' }),
        ),
      })
      return generator.generate(req, signal, onEvent)
    },
  })

  let reviewGenerator: ReviewGenerator | null = null
  function getReviewGenerator(): ReviewGenerator {
    reviewGenerator ??= createReviewGenerator({
      store,
      reviewStore,
      appVersion,
      describe: async ({ system, prompt, images, jsonMode, maxTokens, timeoutMs, signal }) => {
        const result = await getClient().chat({
          messages: [
            { role: 'system', content: system },
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                // 分镜图要看格子里的内容，用 high detail；low 会压成一团色块，读不出构图
                ...images.map((url) => ({
                  type: 'image_url' as const,
                  image_url: { url, detail: 'high' as const },
                })),
              ],
            },
          ],
          maxTokens,
          jsonMode,
          // 影评要 110–180 秒，而网关默认 timeoutMs 只有 120 秒 —— 必须显式传
          timeoutMs,
          purpose: 'watch-review',
          signal,
        })
        return { text: result.content, usage: result.usage, model: result.model }
      },
    })
    return reviewGenerator
  }

  router.use('/api/watch/ping', (_req, res) => {
    sendJson(res, 200, { ok: true, plugin: 'watch-analysis', phase: 1 })
  })

  router.use('/api/watch/deps', (req, res) => {
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'Method Not Allowed' })
      return
    }
    let deps: DependencyStatus[]
    try {
      deps = checkDependencies()
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
      return
    }
    const blocking = deps.filter((d) => d.required && !d.ok)
    sendJson(res, 200, {
      ok: blocking.length === 0,
      canRun: blocking.length === 0,
      deps,
      missingRequired: blocking.map((d) => d.id),
    })
  })

  // ── 性能设置（CPU 上限 / 进程优先级 / MOSS 低显存）──
  router.use('/api/watch/settings', async (req, res) => {
    if (req.method === 'GET') {
      const settings = watchSettings.read()
      sendJson(res, 200, {
        ok: true,
        settings,
        file: watchSettings.file,
        cores: os.cpus().length,
        resolved: resolvePerformance(settings, os.cpus().length),
      })
      return
    }
    if (req.method !== 'PUT' && req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'Method Not Allowed' })
      return
    }
    let body: any
    try {
      body = await readJsonBody(req)
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) })
      return
    }
    const settings = watchSettings.write({
      ...(body?.cpuPercent !== undefined ? { cpuPercent: Number(body.cpuPercent) } : {}),
      ...(typeof body?.priority === 'string' ? { priority: body.priority } : {}),
      ...(body?.asrChunkSeconds !== undefined ? { asrChunkSeconds: Number(body.asrChunkSeconds) } : {}),
      ...(body?.asrLowMemory !== undefined ? { asrLowMemory: body.asrLowMemory === true } : {}),
    })
    sendJson(res, 200, {
      ok: true,
      settings,
      file: watchSettings.file,
      cores: os.cpus().length,
      resolved: resolvePerformance(settings, os.cpus().length),
    })
  })

  // ── 后台任务列表：关掉面板再打开时用它把进行中的任务接回来 ──
  router.use('/api/watch/jobs', (req, res) => {
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'Method Not Allowed' })
      return
    }
    const params = query(req)
    const key = params.get('key') || ''
    const episode = Number(params.get('episode'))
    const jobs = getAnalyzer().list().filter((job) => {
      if (key && job.key !== key) return false
      if (Number.isInteger(episode) && episode > 0 && job.episode !== episode) return false
      return true
    })
    sendJson(res, 200, { ok: true, jobs })
  })

  router.use('/api/watch/vision-test', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'Method Not Allowed' })
      return
    }
    try {
      await readJsonBody(req)
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) })
      return
    }
    const result = await runVisionTest(getClient())
    sendJson(res, 200, { ...result, looksLikeItSaw: looksLikeItSaw(result.answer) })
  })

  // ── 起任务 ──
  router.use('/api/watch/analyze', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'Method Not Allowed' })
      return
    }
    let body: any
    try {
      body = await readJsonBody(req)
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) })
      return
    }

    const key = typeof body?.key === 'string' ? body.key.trim() : ''
    const episode = Number(body?.episode)
    if (!key) { sendJson(res, 400, { ok: false, error: '缺少 key（模板::标题）' }); return }
    if (!Number.isInteger(episode) || episode < 1) { sendJson(res, 400, { ok: false, error: 'episode 必须是 ≥1 的整数' }); return }

    // file 可以不给：宿主从本地番剧库按 key+episode 解析（前端只该传 key/episode）
    let file = typeof body?.file === 'string' ? body.file.trim() : ''
    if (!file) {
      const resolved = opts.resolveLocalFile?.(key, episode) ?? null
      if (!resolved) {
        sendJson(res, 400, {
          ok: false,
          error: '找不到这一集的本地文件：先在「设置 → 本地」绑定番剧目录，或在请求里直接给 file（绝对路径）',
        })
        return
      }
      file = resolved
    }
    if (!path.isAbsolute(file)) { sendJson(res, 400, { ok: false, error: 'file 必须是绝对路径' }); return }
    if (!fs.existsSync(file)) { sendJson(res, 400, { ok: false, error: `找不到视频文件：${file}` }); return }

    try {
      const { jobId } = getAnalyzer().analyze({
        key,
        episode,
        file,
        options: pickAnalyzeOptions(body?.options),
      })
      sendJson(res, 200, { ok: true, jobId })
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  })

  // ── 进度 ──
  router.use('/api/watch/status', (req, res) => {
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'Method Not Allowed' })
      return
    }
    const jobId = query(req).get('jobId') || ''
    if (!jobId) { sendJson(res, 400, { ok: false, error: '缺少 jobId' }); return }
    const job = getAnalyzer().status(jobId)
    if (!job) { sendJson(res, 404, { ok: false, error: '任务不存在或已过期（进程重启会丢）' }); return }
    sendJson(res, 200, { ok: true, job })
  })

  // ── 取消 ──
  router.use('/api/watch/cancel', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'Method Not Allowed' })
      return
    }
    let body: any
    try {
      body = await readJsonBody(req)
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) })
      return
    }
    const jobId = typeof body?.jobId === 'string' ? body.jobId : ''
    if (!jobId) { sendJson(res, 400, { ok: false, error: '缺少 jobId' }); return }
    const cancelled = getAnalyzer().cancel(jobId)
    sendJson(res, 200, { ok: cancelled, cancelled })
  })

  // ── 读报告 ──
  router.use('/api/watch/report', (req, res) => {
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'Method Not Allowed' })
      return
    }
    const params = query(req)
    const key = params.get('key') || ''
    const episode = Number(params.get('episode'))
    if (!key) { sendJson(res, 400, { ok: false, error: '缺少 key' }); return }
    if (!Number.isInteger(episode) || episode < 1) { sendJson(res, 400, { ok: false, error: 'episode 必须是 ≥1 的整数' }); return }
    const report = store.read(key, episode)
    if (!report) { sendJson(res, 404, { ok: false, error: '这一集还没有分析结果' }); return }
    sendJson(res, 200, { ok: true, report })
  })

  // ── 读宫格图 ──
  router.use('/api/watch/sheet', (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { ok: false, error: 'Method Not Allowed' })
      return
    }
    const params = query(req)
    const key = params.get('key') || ''
    const episode = Number(params.get('episode'))
    const file = params.get('file') || ''
    if (!key || !Number.isInteger(episode) || episode < 1) {
      sendJson(res, 400, { ok: false, error: '缺少 key / episode' })
      return
    }
    // 文件名由报告给出（相对 sheetDir），这里再挡一次目录穿越
    const target = store.sheetFile(key, episode, file)
    if (!target) { sendJson(res, 400, { ok: false, error: '非法的文件名' }); return }
    let stat: fs.Stats
    try {
      stat = fs.statSync(target)
    } catch {
      sendJson(res, 404, { ok: false, error: '图片不存在' })
      return
    }
    res.statusCode = 200
    // 2×3 渲染器出的是 JPEG（PNG 每张近 800KB，18 张就是 14MB）；按扩展名给 MIME
    res.setHeader('Content-Type', /\.jpe?g$/i.test(target) ? 'image/jpeg' : 'image/png')
    res.setHeader('Content-Length', String(stat.size))
    // 图一旦生成就不会变（文件名带集号），可以放心长缓存
    res.setHeader('Cache-Control', 'private, max-age=86400')
    if (req.method === 'HEAD') { res.end(); return }
    fs.createReadStream(target).pipe(res)
  })

  // ── 已分析的集号 ──
  router.use('/api/watch/episodes', (req, res) => {
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'Method Not Allowed' })
      return
    }
    const key = query(req).get('key') || ''
    if (!key) { sendJson(res, 400, { ok: false, error: '缺少 key' }); return }
    sendJson(res, 200, { ok: true, episodes: store.listEpisodes(key) })
  })

  // ── 视频路径解析：前端点「AI 影评」时先问一句"这一集的文件在哪" ──
  router.use('/api/watch/resolve', (req, res) => {
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'Method Not Allowed' })
      return
    }
    const params = query(req)
    const key = params.get('key') || ''
    const episode = Number(params.get('episode'))
    if (!key) { sendJson(res, 400, { ok: false, error: '缺少 key' }); return }
    if (!Number.isInteger(episode) || episode < 1) {
      sendJson(res, 400, { ok: false, error: 'episode 必须是 ≥1 的整数' })
      return
    }
    const file = opts.resolveLocalFile?.(key, episode) ?? null
    sendJson(res, 200, { ok: true, file, bound: Boolean(file) })
  })

  // ── 影评后台任务：列表 / 查询 / 创建 / 取消 ──
  // **必须先于 `/api/watch/review` 注册**（前缀匹配，先注册先命中）；
  // `/review/runs` 又要先于 `/review/run`，否则 runs 会被 run 吃掉。
  router.use('/api/watch/review/runs', (req, res) => {
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'Method Not Allowed' })
      return
    }
    const params = query(req)
    const key = params.get('key') || ''
    const kind = params.get('kind')
    const episode = Number(params.get('episode'))
    const runs = reviewRuns.list({
      ...(key ? { key } : {}),
      ...(kind === 'series' || kind === 'episode' ? { scopeKind: kind as 'series' | 'episode' } : {}),
      ...(Number.isInteger(episode) && episode > 0 ? { episode } : {}),
    })
    sendJson(res, 200, { ok: true, runs })
  })

  router.use('/api/watch/review/run', async (req, res) => {
    // 查询任务快照（含已生成的结果）
    if (req.method === 'GET') {
      const runId = query(req).get('id') || ''
      if (!runId) { sendJson(res, 400, { ok: false, error: '缺少 id' }); return }
      const run = reviewRuns.get(runId)
      if (!run) { sendJson(res, 404, { ok: false, error: '任务不存在或已过期' }); return }
      sendJson(res, 200, { ok: true, run })
      return
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'Method Not Allowed' })
      return
    }

    let body: any
    try {
      body = await readJsonBody(req, 8 * 1024 * 1024)
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) })
      return
    }

    const key = typeof body?.key === 'string' ? body.key.trim() : ''
    if (!key) { sendJson(res, 400, { ok: false, error: '缺少 key' }); return }
    let scope: ReviewScope = { kind: 'series' }
    const rawScope = body?.scope
    if (rawScope && rawScope.kind === 'episode') {
      const episode = Number(rawScope.episode)
      if (!Number.isInteger(episode) || episode < 1) {
        sendJson(res, 400, { ok: false, error: 'scope.episode 必须是 ≥1 的整数' })
        return
      }
      scope = { kind: 'episode', episode }
    }

    // 202：任务已经接走，结果靠 GET /review/run?id= 或重开面板时拉
    const { runId } = reviewRuns.start({
      key,
      scope,
      userContext: body?.userContext && typeof body.userContext === 'object' ? body.userContext : undefined,
      options: body?.options && typeof body.options === 'object' ? body.options : undefined,
    })
    sendJson(res, 202, { ok: true, runId })
  })

  router.use('/api/watch/review/cancel', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'Method Not Allowed' })
      return
    }
    let body: any
    try {
      body = await readJsonBody(req)
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) })
      return
    }
    const runId = typeof body?.runId === 'string' ? body.runId.trim() : ''
    if (!runId) { sendJson(res, 400, { ok: false, error: '缺少 runId' }); return }
    const cancelled = reviewRuns.cancel(runId)
    sendJson(res, 200, { ok: cancelled, cancelled })
  })

  // ── 影评元信息 ──
  // **必须在 `/api/watch/review` 之前注册**：分发逻辑是"先注册先匹配"，
  // 而 `/api/watch/review` 的前缀也会吃掉 `/api/watch/review/meta`。
  router.use('/api/watch/review/meta', (req, res) => {
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'Method Not Allowed' })
      return
    }
    let model = 'unknown'
    let provider = 'unknown'
    try {
      const cfg = getClient().publicConfig()
      model = String((cfg as any).model ?? 'unknown')
      provider = String((cfg as any).provider ?? 'unknown')
    } catch {
      // 还没配 AI 就当未知：影评面板会显示"未知"，仍能看历史结果
    }
    sendJson(res, 200, {
      ok: true,
      model,
      provider,
      promptVersion: REVIEW_PROMPT_VERSION,
      budgetLimit: 2_000_000,
    })
  })

  // ── 影评：读（GET）/ 生成（POST） ──
  router.use('/api/watch/review', async (req, res) => {
    // 精确路径判断：子路径 `review/meta` 已由上面那个 handler 接管
    const pathname = String(req.url || '').split('?')[0]
    if (pathname !== '/api/watch/review') {
      sendJson(res, 404, { ok: false, error: 'Not Found' })
      return
    }

    const scopeFromQuery = (): { scope: ReviewScope; key: string } => {
      const params = query(req)
      const key = params.get('key') || ''
      const kind = params.get('kind') || 'series'
      if (kind === 'episode') {
        const episode = Number(params.get('episode'))
        return { key, scope: { kind: 'episode', episode } }
      }
      return { key, scope: { kind: 'series' } }
    }

    // ── 读 ──
    if (req.method === 'GET') {
      const { key, scope } = scopeFromQuery()
      if (!key) { sendJson(res, 400, { ok: false, error: '缺少 key' }); return }
      if (scope.kind === 'episode' && (!Number.isInteger(scope.episode) || scope.episode < 1)) {
        sendJson(res, 400, { ok: false, error: 'episode 必须是 ≥1 的整数' })
        return
      }
      const review = getReviewGenerator().read({ key, scope })
      if (!review) { sendJson(res, 404, { ok: false, error: '还没有生成过影评' }); return }
      sendJson(res, 200, { ok: true, review })
      return
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'Method Not Allowed' })
      return
    }

    // ── 生成 ──
    let body: any
    try {
      body = await readJsonBody(req, 8 * 1024 * 1024)
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) })
      return
    }

    const key = typeof body?.key === 'string' ? body.key.trim() : ''
    if (!key) { sendJson(res, 400, { ok: false, error: '缺少 key' }); return }

    let scope: ReviewScope = { kind: 'series' }
    const rawScope = body?.scope
    if (rawScope && rawScope.kind === 'episode') {
      const episode = Number(rawScope.episode)
      if (!Number.isInteger(episode) || episode < 1) {
        sendJson(res, 400, { ok: false, error: 'scope.episode 必须是 ≥1 的整数' })
        return
      }
      scope = { kind: 'episode', episode }
    }

    // 生成要调多模态模型（30–180 秒），别让默认请求超时把连接掐掉
    if (typeof res.setTimeout === 'function') res.setTimeout(0)
    if (typeof req.setTimeout === 'function') req.setTimeout(0)

    // 客户端断开（用户点了取消/关了面板）时要能中止调用，别白烧 token
    const controller = new AbortController()
    let closed = false
    res.on('close', () => {
      if (!closed) controller.abort()
    })

    const requestPayload = {
      key,
      scope,
      userContext: body?.userContext && typeof body.userContext === 'object' ? body.userContext : undefined,
      options: body?.options && typeof body.options === 'object' ? body.options : undefined,
    }

    /*
     * ── 流式（SSE）：真进度 ──
     *
     * 前端带 `Accept: text/event-stream` 才走这条；不带就是原来的同步 JSON 接口
     * （旧前端/脚本仍然能用）。事件三类：
     *   phase —— 服务端真实知道的阶段（整理输入 / 交给模型 / 解析落盘）
     *   delta —— 模型吐字进度（chars = 正文累计字符，reasoningChars = 思维链累计）
     *   done / error
     */
    if (String((req.headers as any)?.accept || '').includes('text/event-stream')) {
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
      res.setHeader('Cache-Control', 'no-cache, no-transform')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('X-Accel-Buffering', 'no')
      if (typeof res.flushHeaders === 'function') res.flushHeaders()

      const write = (payload: unknown) => {
        if (closed) return
        res.write(`data: ${JSON.stringify(payload)}\n\n`)
      }

      const describeStreaming = createStreamingDescribe(
        (chars, reasoningChars) => write({ type: 'delta', chars, reasoningChars }),
        () => write({ type: 'phase', phase: 'call', message: '流式不可用，改用一次性生成' }),
      )

      const streamingGenerator = createReviewGenerator({
        store,
        reviewStore,
        appVersion,
        describe: describeStreaming,
      })

      try {
        await streamingGenerator.generate(requestPayload, controller.signal, (event) => {
          if (event.type === 'phase') write(event)
          else write({ type: 'done', review: event.review, cached: event.cached })
        })
      } catch (e) {
        // 用户主动取消时不发 error：前端已经断开，写了也没人收
        if (!controller.signal.aborted) {
          write({ type: 'error', message: e instanceof Error ? e.message : String(e) })
        }
      } finally {
        closed = true
        res.end()
      }
      return
    }

    try {
      const { review, cached } = await getReviewGenerator().generate(requestPayload, controller.signal)
      closed = true
      sendJson(res, 200, { ok: true, review, cached })
    } catch (e) {
      closed = true
      const message = e instanceof Error ? e.message : String(e)
      // 用户主动取消不算错误，回 499 让前端安静收尾
      if (controller.signal.aborted) {
        sendJson(res, 499, { ok: false, error: '已取消' })
        return
      }
      sendJson(res, 500, { ok: false, error: message })
    }
  })
}
