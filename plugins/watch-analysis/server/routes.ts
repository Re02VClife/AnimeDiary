/**
 * server/routes — /api/watch/* 路由
 *
 * Phase 0 只提供三件事：
 *   GET  /api/watch/deps         依赖自检（ffmpeg / python / 分镜引擎 / ASR / MEE）
 *   GET  /api/watch/ping         插件挂载成功没有
 *   POST /api/watch/vision-test  真发一张图给模型，确认多模态链路通
 *
 * 后面几期会在这里加 analyze / status / cancel / report / sheet / budget。
 * 路由层只做「解析请求 → 调 runtime → 回 JSON」，不放任何业务逻辑。
 */
import { createAIClient, AIGatewayError } from '../../../server/ai-gateway'
import type { AIUsage } from '../../../server/ai-gateway'
import { checkDependencies } from './deps'
import type { DependencyStatus } from './deps'

interface RouterLike {
  use(prefix: string, handler: (req: any, res: any) => void): void
}

export interface WatchRoutesOptions {
  DATA_DIR: string
  fetchImpl?: (url: string, init?: Record<string, unknown>) => Promise<any>
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

/**
 * 自检用的测试图：64×64，深绿底 + 红色圆。
 *
 * 为什么内置而不是现场画：这张图唯一的作用是「确认模型真的收到了像素」，
 * 它必须**在所有机器上都一样**（同样的字节、同样的 token 数），
 * 现场生成会因为编码器差异导致结果不可比。绿底红圆的好处是：
 * 即使模型只看一眼也能说出两个明确特征，便于判断"是看了图"还是"在瞎编"。
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

/**
 * 真发一次多模态请求。
 *
 * 判断标准不是「有没有报错」，而是**回答里提到绿/红/圆** ——
 * 一个不支持图片的模型不会报错，它会忽略图、然后编一句"我看到一张图片"。
 * 所以这里把原文交回去让人判断，同时给一个 `looksLikeItSaw` 的粗判供 UI 显示。
 */
async function runVisionTest(client: ReturnType<typeof createAIClient>): Promise<VisionTestResult> {
  try {
    const result = await client.chat({
      messages: [
        {
          role: 'system',
          content: '你是一个图片描述器。只描述你实际看到的内容，不要推测、不要客套。',
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: '这张图里有什么？只回答底色和图形，20 个字以内。' },
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${VISION_TEST_PNG}`, detail: 'low' },
            },
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

/** 粗判：回答里有没有出现测试图的两个特征。只用于 UI 提示，不参与判定。 */
function looksLikeItSaw(answer: string | undefined): boolean {
  if (!answer) return false
  const text = answer.toLowerCase()
  const color = /绿|green|红|red/.test(text)
  const shape = /圆|circle|round|圆点/.test(text)
  return color && shape
}

export function registerWatchRoutes(router: RouterLike, opts: WatchRoutesOptions): void {
  // 复用同一个 client：内部会缓存配置，反复 new 会每次读盘
  let client: ReturnType<typeof createAIClient> | null = null
  function getClient() {
    client ??= createAIClient({ DATA_DIR: opts.DATA_DIR, fetchImpl: opts.fetchImpl })
    return client
  }

  router.use('/api/watch/ping', (_req, res) => {
    sendJson(res, 200, { ok: true, plugin: 'watch-analysis', phase: 0 })
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
      /** 必装项是否齐全：不全就无法开始分析 */
      canRun: blocking.length === 0,
      deps,
      missingRequired: blocking.map((d) => d.id),
    })
  })

  router.use('/api/watch/vision-test', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'Method Not Allowed' })
      return
    }
    try {
      await readJsonBody(req) // 允许空体，但非法 JSON 要报出来
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) })
      return
    }
    const result = await runVisionTest(getClient())
    sendJson(res, 200, { ...result, looksLikeItSaw: looksLikeItSaw(result.answer) })
  })
}
