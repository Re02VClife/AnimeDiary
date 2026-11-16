/**
 * runtime/pipeline 的 buildReport 映射单测
 *
 * 这层是「worker 的 payload」→「落盘的 WatchReport」之间唯一的翻译。
 * 它错了不会崩，只会产出**看起来对、实际字段对不上**的报告 ——
 * 比如 UI 拿不到 loudness、或者 shots 找不到自己属于哪张图。
 * 所以逐个字段钉。
 */
// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { buildReport } from '../../../plugins/watch-analysis/runtime/pipeline'
import type { WatchWorkerResult } from '../../../plugins/watch-analysis/runtime/protocol'

function makePayload(overrides: Partial<WatchWorkerResult> = {}): WatchWorkerResult {
  return {
    video: { duration: 1440, fps: 23.976, width: 1920, height: 1080, hasAudio: true, hasSubtitle: false },
    cuts: [
      { t: 5.2, score: 120, kind: 'hardcut' },
      { t: 12.8, score: 88, kind: 'motion' },
    ],
    shots: [
      { i: 0, start: 0, end: 5.2, frameAt: 2.6, tier: 2, cuts: 1 },
      { i: 1, start: 5.2, end: 12.8, frameAt: 9, tier: 4, text: '这句是台词' },
      { i: 2, start: 12.8, end: 20, frameAt: 16, tier: 1 },
    ],
    sheets: [
      { file: 'ep01.png', width: 800, height: 450, cells: 2, shots: [0, 1] },
      { file: 'ep01-2.png', width: 800, height: 300, cells: 1, shots: [2] },
    ],
    audio: { mean: -21.8, peak: -21.5, series: [1, 2, 3], step: 0.1, silences: [[10, 12]] },
    timing: { probe: 0.03, scan: 0.08, render: 0.7, transcript: 0.2, total: 1.01 },
    plan: {
      strategy: 'compact',
      sheets: 2,
      frames: 3,
      fill: 87.5,
      canvas: { width: 798, height: 443 },
      tiers: { 1: 1, 2: 1, 4: 1 },
    },
    ...overrides,
  }
}

const REQ = { key: '模板::葬送的芙莉莲', episode: 3, file: 'D:/anime/ep03.mkv' }

describe('buildReport', () => {
  it('补全 schema / key / episode / 视频信息', () => {
    const report = buildReport(makePayload(), REQ, '1.3.26')
    expect(report.schema).toBe(1)
    expect(report.key).toBe(REQ.key)
    expect(report.episode).toBe(3)
    expect(report.video.duration).toBe(1440)
    expect(report.video.file).toBe(REQ.file)
    expect(report.appVersion).toBe('1.3.26')
    expect(Number.isNaN(Date.parse(report.created))).toBe(false)
  })

  it('cuts 带上引擎标识（A/B 对比时要能分辨是谁切的）', () => {
    const report = buildReport(makePayload(), REQ, '1')
    expect(report.cuts).toHaveLength(2)
    expect(report.cuts[0]).toMatchObject({ t: 5.2, score: 120, engine: 'hsv' })
  })

  it('shots 保留台词与档位，并标出属于哪张图', () => {
    const report = buildReport(makePayload(), REQ, '1')
    expect(report.shots).toHaveLength(3)
    expect(report.shots[1].text).toBe('这句是台词')
    expect(report.shots[1].tier).toBe(4)
    // 第 0、1 个镜头在第一张图，第 2 个在第二张
    expect(report.shots[0].cell?.sheet).toBe(0)
    expect(report.shots[1].cell?.sheet).toBe(0)
    expect(report.shots[2].cell?.sheet).toBe(1)
  })

  it('payload 没有台词时，报告里也不该出现 transcript 字段', () => {
    const report = buildReport(makePayload(), REQ, '1')
    expect(report.transcript).toBeUndefined()
    // engine 要如实说"没有台词来源"
    expect(report.engine.transcript).toBe('none')
  })

  it('有台词时映射 segments、来源与字符数', () => {
    const report = buildReport(makePayload({
      transcript: {
        source: 'subtitle-file',
        segments: [{ start: 5.2, end: 8.0, text: '第一句' }, { start: 8.0, end: 10, text: '第二句' }],
        chars: 6,
        notes: ['ep03.ass'],
      },
    }), REQ, '1')
    expect(report.transcript?.source).toBe('subtitle-file')
    expect(report.transcript?.segments).toHaveLength(2)
    expect(report.transcript?.segments[0]).toMatchObject({ start: 5.2, end: 8, text: '第一句' })
    expect(report.engine.transcript).toBe('subtitle-file')
    expect(report.transcript?.notes).toEqual(['ep03.ass'])
  })

  it('ASR 台词的说话人编号要透传，外挂字幕不该凭空多出 speaker 字段', () => {
    const report = buildReport(makePayload({
      transcript: {
        source: 'asr-moss',
        segments: [
          { start: 0, end: 2, text: '第一句', speaker: 'S01' },
          { start: 2, end: 4, text: '第二句' },
        ],
        chars: 6,
        speakers: 1,
      },
    }), REQ, '1')
    expect(report.transcript?.source).toBe('asr-moss')
    expect(report.engine.transcript).toBe('asr-moss')
    expect(report.transcript?.segments[0].speaker).toBe('S01')
    expect(report.transcript?.segments[1]).not.toHaveProperty('speaker')
    expect(report.transcript?.speakers).toBe(1)
  })

  it('音轨响度映射到 loudness（不是 audio —— 那个留给配乐证据）', () => {
    const report = buildReport(makePayload(), REQ, '1')
    expect(report.loudness).toEqual({ mean: -21.8, peak: -21.5, series: [1, 2, 3], step: 0.1, silences: [[10, 12]] })
    expect(report.audio).toBeUndefined()
  })

  it('没有音轨时不生成 loudness', () => {
    const report = buildReport(makePayload({ audio: undefined }), REQ, '1')
    expect(report.loudness).toBeUndefined()
  })

  it('排版参数落进 render（复盘"这次为什么是 2 张图"用）', () => {
    const report = buildReport(makePayload(), REQ, '1')
    expect(report.render).toEqual({
      strategy: 'compact',
      sheets: 2,
      frames: 3,
      fill: 87.5,
      canvas: { width: 798, height: 443 },
      tiers: { 1: 1, 2: 1, 4: 1 },
    })
  })

  it('引擎警告进 notes，不会伪装成台词', () => {
    const report = buildReport(makePayload({ warnings: ['连续运镜导致切点数不可信'] }), REQ, '1')
    expect(report.notes).toEqual(['连续运镜导致切点数不可信'])
    expect(report.transcript).toBeUndefined()
  })

  it('timing 原样带上各阶段耗时', () => {
    const report = buildReport(makePayload(), REQ, '1')
    expect(report.timing.probe).toBe(0.03)
    expect(report.timing.scan).toBe(0.08)
    expect(report.timing.render).toBe(0.7)
    expect(report.timing.transcript).toBe(0.2)
    expect(report.timing.total).toBe(1.01)
  })

  it('预算默认给满 200 万、零消耗（Phase 1 不调模型）', () => {
    const report = buildReport(makePayload(), REQ, '1')
    expect(report.budget.limit).toBe(2_000_000)
    expect(report.budget.spent).toBe(0)
    expect(report.budget.exhausted).toBe(false)
  })

  it('sheets 原样透传（files / 尺寸 / 覆盖哪些镜头）', () => {
    const report = buildReport(makePayload(), REQ, '1')
    expect(report.sheets).toHaveLength(2)
    expect(report.sheets[1]).toMatchObject({ file: 'ep01-2.png', width: 800, height: 300, cells: 1, shots: [2] })
  })
})
