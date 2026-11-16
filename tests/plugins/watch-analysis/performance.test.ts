// @vitest-environment node
/**
 * 性能预留的单测：`core/performance`（纯映射）+ `server/settings`（落盘与降级）
 *
 * 这两块最容易出的不是崩溃，而是**口径漂移**：
 *   - 面板上显示"16 核 → 8 线程"，实际 ffmpeg 拿到 4 → 用户觉得设置没用；
 *   - 配置文件被手改坏 → 整个拉片面板打不开。
 * 所以这里逐个钉：百分比映射、非法输入回落、坏 JSON 回落、未知优先级回落。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  normalizeCpuPercent,
  normalizePriority,
  resolvePerformance,
} from '../../../plugins/watch-analysis/core/performance'
import { createWatchSettings, DEFAULT_WATCH_SETTINGS } from '../../../plugins/watch-analysis/server/settings'

describe('resolvePerformance', () => {
  it('16 核 50% → 8 线程 / 4 并发', () => {
    expect(resolvePerformance({ cpuPercent: 50 }, 16)).toMatchObject({
      threads: 8,
      concurrency: 4,
      cores: 16,
      cpuPercent: 50,
    })
  })

  it('4 核 25% → 1 线程 / 1 并发（给系统留出余量）', () => {
    expect(resolvePerformance({ cpuPercent: 25 }, 4)).toMatchObject({ threads: 1, concurrency: 1 })
  })

  it('100% 也不会超过 4 并发（抽帧再高没有收益，只会互相抢 IO）', () => {
    expect(resolvePerformance({ cpuPercent: 100 }, 32).concurrency).toBe(4)
  })

  it('非法输入回落：百分比 50、核数 1', () => {
    expect(resolvePerformance({ cpuPercent: 'abc' as unknown as number }, 16).cpuPercent).toBe(50)
    expect(resolvePerformance(null, 0).cores).toBe(1)
    expect(resolvePerformance(undefined, Number.NaN).threads).toBe(1)
  })

  it('normalizeCpuPercent 夹在 25–100', () => {
    expect(normalizeCpuPercent(1)).toBe(25)
    expect(normalizeCpuPercent(999)).toBe(100)
    expect(normalizeCpuPercent(undefined)).toBe(50)
  })

  it('normalizePriority 只认三个值', () => {
    expect(normalizePriority('low')).toBe('low')
    expect(normalizePriority('below-normal')).toBe('below-normal')
    expect(normalizePriority('normal')).toBe('normal')
    expect(normalizePriority('high')).toBe('below-normal')
  })
})

describe('watch-settings 落盘', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-settings-'))
  })

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('没有配置文件时返回默认值', () => {
    const store = createWatchSettings(dir)
    expect(store.read()).toEqual(DEFAULT_WATCH_SETTINGS)
  })

  it('写入只覆盖传入字段，其余保持原值', () => {
    const store = createWatchSettings(dir)
    store.write({ cpuPercent: 25 })
    const next = store.write({ priority: 'low' })
    expect(next).toMatchObject({ cpuPercent: 25, priority: 'low' })
    // 落盘后重新读一遍：不是只改内存
    expect(createWatchSettings(dir).read()).toMatchObject({ cpuPercent: 25, priority: 'low' })
  })

  it('配置文件是坏 JSON 时回落默认值，不抛错', () => {
    fs.writeFileSync(path.join(dir, 'watch-settings.json'), '{ 这不是 json', 'utf8')
    const store = createWatchSettings(dir)
    expect(() => store.read()).not.toThrow()
    expect(store.read()).toEqual(DEFAULT_WATCH_SETTINGS)
  })

  it('未知优先级 / 越界百分比被夹住（手改配置文件也不该产生怪值）', () => {
    fs.writeFileSync(
      path.join(dir, 'watch-settings.json'),
      JSON.stringify({ cpuPercent: 1000, priority: 'turbo', asrLowMemory: 'yes' }),
      'utf8',
    )
    const settings = createWatchSettings(dir).read()
    expect(settings.cpuPercent).toBe(100)
    expect(settings.priority).toBe('below-normal')
    expect(settings.asrLowMemory).toBe(false)
  })
})
