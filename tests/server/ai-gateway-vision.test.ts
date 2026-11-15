/**
 * 多模态请求的序列化路径
 *
 * Phase 0 的核心风险不是"模型支不支持图"，而是**我们有没有把图发出去**。
 * 这里用假 fetch 直接检查最终请求体：content 是不是变成了 OpenAI 的
 * `[{type:'text'},{type:'image_url'}]` 形状，纯文本时是不是还保持字符串。
 *
 * 为什么要单独测：`buildBody()` 是 `messages: req.messages` 原样透传，
 * 一旦有人为了"兼容"把 content 强制 toString，图片会在没人发现的情况下
 * 变成 `[object Object]` 发出去 —— 模型不会报错，只会说"我没看到图"。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createAIClient } from '../../server/ai-gateway'
import type { ContentPart } from '../../server/ai-gateway'

function fakeResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    async json() { return body },
    async text() { return JSON.stringify(body) },
    async arrayBuffer() { return new ArrayBuffer(0) },
  }
}

function chatOk(content: string) {
  return {
    model: 'deepseek-v4.1-flash',
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  }
}

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-vision-test-'))
})

afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

function makeClient(handler: (init: any) => unknown) {
  const client = createAIClient({
    DATA_DIR: dir,
    fetchImpl: async (_url: string, init: any) => handler(init) as any,
  })
  client.saveConfig({
    provider: 'opencode-go',
    baseUrl: 'https://gw.test/v1',
    model: 'deepseek-v4.1-flash',
    apiKey: 'test-key',
    maxTokens: 1000,
  })
  return client
}

describe('多模态消息序列化', () => {
  it('ContentPart[] 原样进请求体，不被降级成字符串', async () => {
    let captured: any = null
    const client = makeClient((init) => {
      captured = init
      return fakeResponse(chatOk('绿底红圆'))
    })

    const dataUrl = 'data:image/png;base64,iVBORw0KGgo='
    const content: ContentPart[] = [
      { type: 'text', text: '这张图里有什么？' },
      { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } },
    ]

    await client.chat({
      messages: [{ role: 'user', content }],
      purpose: 'watch-vision-test',
    })

    const body = JSON.parse(captured.body)
    const msg = body.messages[0]
    expect(Array.isArray(msg.content)).toBe(true)
    expect(msg.content).toHaveLength(2)
    expect(msg.content[0]).toEqual({ type: 'text', text: '这张图里有什么？' })
    expect(msg.content[1]).toEqual({
      type: 'image_url',
      image_url: { url: dataUrl, detail: 'low' },
    })
    // 关键：不是 "[object Object]" 这种字符串化产物
    expect(typeof msg.content).not.toBe('string')
  })

  it('纯文本消息仍然序列化成字符串（向后兼容）', async () => {
    let captured: any = null
    const client = makeClient((init) => {
      captured = init
      return fakeResponse(chatOk('ok'))
    })

    await client.chat({ messages: [{ role: 'user', content: 'hi' }] })

    const body = JSON.parse(captured.body)
    expect(body.messages[0].content).toBe('hi')
    expect(typeof body.messages[0].content).toBe('string')
  })

  it('系统消息与多模态用户消息可以混在同一次请求里', async () => {
    let captured: any = null
    const client = makeClient((init) => {
      captured = init
      return fakeResponse(chatOk('ok'))
    })

    await client.chat({
      messages: [
        { role: 'system', content: '你是一个图片描述器。' },
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }],
        },
      ],
    })

    const body = JSON.parse(captured.body)
    expect(body.messages).toHaveLength(2)
    expect(body.messages[0].content).toBe('你是一个图片描述器。')
    expect(Array.isArray(body.messages[1].content)).toBe(true)
    // detail 没传时不应凭空补一个
    expect(body.messages[1].content[0].image_url.detail).toBeUndefined()
  })
})
