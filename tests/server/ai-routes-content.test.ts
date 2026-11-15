/**
 * /api/ai/chat 的入参收敛（normalizeContent）
 *
 * 前端能传什么，这里就该挡什么。重点测三类：
 *   1. 正常的字符串 / 多模态数组 —— 原样放行
 *   2. 不认识的 part（Anthropic 的 image、瞎编的 type）—— 丢掉，不报错
 *   3. 没有可用正文的消息 —— 返回 null，调用方整条丢弃
 *
 * 为什么"丢掉而不是报错"：一条消息里混了个不认识的 part 时，
 * 整条请求失败会让用户莫名其妙；丢掉那个 part 至少图片还能发出去。
 */
import { describe, it, expect } from 'vitest'
import { normalizeContent } from '../../server/ai-routes'
import type { ContentPart } from '../../server/ai-gateway'

describe('normalizeContent', () => {
  it('字符串原样返回', () => {
    expect(normalizeContent('hello')).toBe('hello')
  })

  it('null / undefined 变成空串（带工具调用的 assistant 消息就是这种）', () => {
    expect(normalizeContent(null)).toBe('')
    expect(normalizeContent(undefined)).toBe('')
  })

  it('合法的 text + image_url 原样保留', () => {
    const raw = [
      { type: 'text', text: '看图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA', detail: 'high' } },
    ]
    const out = normalizeContent(raw) as ContentPart[]
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({ type: 'text', text: '看图' })
    expect(out[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,AAA', detail: 'high' },
    })
  })

  it('detail 非法时丢掉 detail，但保留图片', () => {
    const out = normalizeContent([
      { type: 'image_url', image_url: { url: 'https://x/y.png', detail: 'ultra' } },
    ]) as ContentPart[]
    expect(out).toHaveLength(1)
    expect((out[0] as any).image_url.url).toBe('https://x/y.png')
    expect((out[0] as any).image_url.detail).toBeUndefined()
  })

  it('没有 url 的图片被丢掉', () => {
    expect(normalizeContent([{ type: 'image_url', image_url: {} }])).toBeNull()
    expect(normalizeContent([{ type: 'image_url' }])).toBeNull()
    expect(normalizeContent([{ type: 'image_url', image_url: { url: '   ' } }])).toBeNull()
  })

  it('不认识的 part（例如 Anthropic 的 image + source）被丢掉', () => {
    const out = normalizeContent([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
      { type: 'text', text: '还在' },
    ]) as ContentPart[]
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({ type: 'text', text: '还在' })
  })

  it('全部都是非法 part 时返回 null（调用方整条丢弃）', () => {
    expect(normalizeContent([{ type: 'audio', data: 'x' }])).toBeNull()
    expect(normalizeContent([])).toBeNull()
    expect(normalizeContent([null, 42, 'oops'])).toBeNull()
  })

  it('非数组非字符串直接判死', () => {
    expect(normalizeContent(123)).toBeNull()
    expect(normalizeContent({ type: 'text', text: 'x' })).toBeNull()
  })

  it('空 text 的 part 仍然保留（模型据此知道"这里没内容"）', () => {
    const out = normalizeContent([{ type: 'text', text: '' }]) as ContentPart[]
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({ type: 'text', text: '' })
  })
})
