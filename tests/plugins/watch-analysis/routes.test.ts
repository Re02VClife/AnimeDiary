/**
 * plugins/watch-analysis/server/routes —— /api/watch/sheet 的回归
 *
 * 2026-11-17 实测故障：`GET /api/watch/sheet?file=`（空文件名）
 *   → store.sheetFile 返回图片目录本身（path.resolve(base, '') === base）
 *   → statSync 成功（目录）
 *   → createReadStream(目录) 抛 EISDIR，且没有 error 监听
 *   → **未捕获异常，整个 API 进程退出**（dev 里是 vite 挂掉，生产里是所有 /api 全挂）
 *
 * 这里用假 router / req / res 直接调 handler，不需要真的起 HTTP 服务。
 */
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import { registerWatchRoutes } from '../../../plugins/watch-analysis/server/routes'
import { keyToDirName } from '../../../plugins/watch-analysis/server/store'

type Handler = (req: any, res: any) => void
const KEY = 'a::b'
const URL_KEY = encodeURIComponent(KEY)

/** 收集注册的路由：use(prefix, handler) */
function makeRouter() {
  const routes = new Map<string, Handler>()
  return {
    routes,
    use(prefix: string, handler: Handler) {
      routes.set(prefix, handler)
    },
  }
}

function sheetHandler(): Handler {
  const router = makeRouter()
  registerWatchRoutes(router, { DATA_DIR: dataDir })
  const handler = router.routes.get('/api/watch/sheet')
  if (!handler) throw new Error('没有注册 /api/watch/sheet')
  return handler
}

/** 最小的 Response：能收 header、能当 Writable 被 pipe、能读出 body */
class FakeRes extends Writable {
  statusCode = 200
  headers: Record<string, string> = {}
  chunks: Buffer[] = []

  setHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = String(value)
    return this
  }

  getHeader(name: string) {
    return this.headers[name.toLowerCase()]
  }

  _write(chunk: Buffer, _encoding: string, callback: () => void) {
    this.chunks.push(Buffer.from(chunk))
    callback()
  }

  get body() {
    return Buffer.concat(this.chunks)
  }
}

/** 1×1 PNG（合法图片字节，够 stat/stream 走完） */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

let dataDir: string
let sheetsDir: string

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-routes-test-'))
  sheetsDir = path.join(dataDir, 'watch-reports', keyToDirName(KEY), 'sheets', 'ep1')
  fs.mkdirSync(sheetsDir, { recursive: true })
})

afterEach(() => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

/** 调一次 handler；返回 res，并把「有没有未捕获异常」也带出来 */
async function call(method: string, url: string): Promise<{ res: FakeRes; crashed: boolean }> {
  let crashed = false
  const onUncaught = () => { crashed = true }
  process.once('uncaughtException', onUncaught)
  const res = new FakeRes()
  try {
    await sheetHandler()({ method, url }, res)
    // pipe 是异步的：给事件循环一轮，让流（以及可能的 EISDIR）有机会冒出来
    await new Promise((resolve) => setTimeout(resolve, 30))
  } finally {
    process.off('uncaughtException', onUncaught)
  }
  return { res, crashed }
}

describe('GET /api/watch/sheet', () => {
  it('空文件名 → 400，且不会去读目录（曾经把进程打挂）', async () => {
    const { res, crashed } = await call('GET', `/api/watch/sheet?key=${URL_KEY}&episode=1&file=`)
    expect(crashed).toBe(false)
    expect(res.statusCode).toBe(400)
    expect(res.body.toString('utf8')).toContain('非法的文件名')
  })

  it('`file=.` / `file=..` / 穿越路径 → 400', async () => {
    for (const file of ['.', '..', '../../1.json', 'sub/../../x.png']) {
      const { res } = await call(
        'GET',
        `/api/watch/sheet?key=${URL_KEY}&episode=1&file=${encodeURIComponent(file)}`,
      )
      expect(res.statusCode, `file=${file}`).toBe(400)
    }
  })

  it('图片不存在 → 404', async () => {
    const { res } = await call('GET', `/api/watch/sheet?key=${URL_KEY}&episode=1&file=ep01-1.png`)
    expect(res.statusCode).toBe(404)
  })

  it('传子目录名（是目录不是文件）→ 404，不抛未捕获异常', async () => {
    fs.mkdirSync(path.join(sheetsDir, 'sub'), { recursive: true })
    const { res, crashed } = await call('GET', `/api/watch/sheet?key=${URL_KEY}&episode=1&file=sub`)
    expect(crashed).toBe(false)
    expect(res.statusCode).toBe(404)
  })

  it('正常 PNG → 200 image/png，body 与文件一致', async () => {
    fs.writeFileSync(path.join(sheetsDir, 'ep01-1.png'), PNG_1X1)
    const { res } = await call('GET', `/api/watch/sheet?key=${URL_KEY}&episode=1&file=ep01-1.png`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    expect(res.headers['content-length']).toBe(String(PNG_1X1.length))
    expect(res.body.equals(PNG_1X1)).toBe(true)
  })

  it('HEAD → 200 且不写 body', async () => {
    fs.writeFileSync(path.join(sheetsDir, 'ep01-1.png'), PNG_1X1)
    const { res } = await call('HEAD', `/api/watch/sheet?key=${URL_KEY}&episode=1&file=ep01-1.png`)
    expect(res.statusCode).toBe(200)
    expect(res.body.length).toBe(0)
  })
})
