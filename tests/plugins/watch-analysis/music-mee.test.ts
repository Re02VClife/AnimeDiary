/**
 * adapters/music-mee 单测
 *
 * 这层最怕的是**把日志当数据**：CLI 会先往 stdout 打 `[结构] ...` 再把 pretty-print 的
 * JSON 跟在后面（实测），直接 JSON.parse 必炸；而它炸了不会报错，只会让报告里
 * 悄悄没有配乐证据、影评继续写"听不到"。所以解析和映射两条都要钉住。
 *
 * 映射部分用**真实跑出来的输出**做 fixture（2026-11-17，3 分钟动画音轨），
 * 只截掉不影响断言的字段。
 */
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// @ts-expect-error .mjs 没有类型声明（和 cut-hsv / shot-builder 同一套约定）
import * as meeModule from '../../../plugins/watch-analysis/adapters/music-mee.mjs'

/* ── 局部类型：仓库没为 .mjs 开 allowJs，这里按端口契约收窄 ── */

interface MappedWindow {
  from: number
  to: number
  measurements: {
    loudness?: number
    onsetRate?: number
    tempo?: number
    boundaries?: number[]
  }
}

interface MappedResult {
  windows: MappedWindow[]
  engine: string
  summary?: {
    bpm?: number
    tempoStable?: boolean
    key?: string
    keyConfidence?: number
    lufs?: number
    rmsDbfs?: number
    peakDbfs?: number
    energyStd?: number
    onsetRate?: number
    segments: number
    boundaries: Array<{ t: number; jumpDb?: number }>
    sourcesAvailable: boolean
    caveats?: string[]
  }
  notes?: string[]
}

interface ProviderReady {
  ok: boolean
  reason?: string
  detail?: string
  version?: string
}

interface ProviderResult {
  windows: MappedWindow[]
  engine?: string
  notes?: string[]
}

interface MusicProvider {
  ready(): Promise<ProviderReady>
  analyze(
    video: { file: string; duration?: number },
    opts?: Record<string, unknown>,
  ): Promise<ProviderResult>
}

const parseMeeJson = meeModule.parseMeeJson as (stdout: unknown) => Record<string, any> | null
const mapMeeResult = meeModule.mapMeeResult as (
  parsed: unknown,
  opts?: { offset?: number; duration?: number },
) => MappedResult | null
const createMusicMeeProvider = meeModule.createMusicMeeProvider as (
  deps?: Record<string, unknown>,
) => MusicProvider

/** 真实输出的精简版（结构、字段名、单位都和线上一致） */
function makeMeeJson(overrides: Record<string, unknown> = {}) {
  return {
    scope: { start_sec: 0, end_sec: 180.04, duration_sec: 180.04, file_duration_sec: 180.04 },
    summary: {
      duration_sec: 180.04,
      bpm: 123,
      tempo_stable: true,
      key: { best: 'G minor', confidence: 0.676 },
      loudness: { peak_dbfs: -1.55, rms_dbfs: -21.62, lufs: -20.54, clipped: false },
      energy_range_dbfs: { min: -34.18, max: -22.03, std: 4.15 },
    },
    timeline: {
      energy: [
        { start_sec: 0, end_sec: 14.4, mean_dbfs: -27.8 },
        { start_sec: 14.4, end_sec: 58.6, mean_dbfs: -22 },
        { start_sec: 58.6, end_sec: 102.8, mean_dbfs: -31.6 },
        { start_sec: 102.8, end_sec: 114.2, mean_dbfs: -34.2 },
        { start_sec: 114.2, end_sec: 133.3, mean_dbfs: -23.7 },
      ],
      section_boundaries: [
        { time_sec: 14.4, jump_db: 5.7 },
        { time_sec: 58.6, jump_db: 9.6 },
        { time_sec: 114.2, jump_db: 10.4 },
      ],
    },
    activity: {
      summary: { onset_rate_per_sec: 4.25, active_band_ratio: 0.83, spectral_flux: 0.0866 },
      timeline: [
        { start_sec: 0, end_sec: 14.4, onset_rate: 3.89, onsets: 56 },
        { start_sec: 14.4, end_sec: 58.6, onset_rate: 3.981, onsets: 176 },
        { start_sec: 58.6, end_sec: 102.8, onset_rate: 5.2, onsets: 230 },
        { start_sec: 102.8, end_sec: 114.2, onset_rate: 2.1, onsets: 24 },
        { start_sec: 114.2, end_sec: 133.3, onset_rate: 4.8, onsets: 91 },
      ],
    },
    confidence: {
      fit: { beat: 0.937, tonality: 0.36, chords: 0.173 },
      reading: { beat: '可用', tonality: '不可用', chords: '不可用' },
      caveats: ['和弦已降级为『根音候选骨架』', '所有数值均来自混音整体，未做音源分离'],
    },
    measurements: { sample_rate: 22050, beat_count: 369, structure_aware: true },
    sources: { available: false, reason: 'onnxruntime 或声源模型缺失' },
    ...overrides,
  }
}

describe('parseMeeJson', () => {
  it('干净 JSON 直接解析', () => {
    const parsed = parseMeeJson(JSON.stringify(makeMeeJson()))
    expect(parsed).not.toBeNull()
    expect(parsed!.summary.bpm).toBe(123)
  })

  it('混了 `[结构] ...` 这类进度行时，从第一个 `{` 抠出 JSON', () => {
    // 这就是 CLI 的真实输出形状：一行中文进度 + 多行 pretty JSON
    const raw = `[结构] 10 个候选边界（强 6 个）→ 7 段\n${JSON.stringify(makeMeeJson(), null, 2)}\n`
    const parsed = parseMeeJson(raw)
    expect(parsed).not.toBeNull()
    expect(parsed!.timeline.energy).toHaveLength(5)
  })

  it('完全不是 JSON 时返回 null（调用方当失败处理）', () => {
    expect(parseMeeJson('Traceback (most recent call last): ...')).toBeNull()
    expect(parseMeeJson('')).toBeNull()
    expect(parseMeeJson(null)).toBeNull()
  })

  it('JSON 后面又跟了一段日志时仍然能解析', () => {
    const raw = `${JSON.stringify(makeMeeJson())}\n[done] 结束\n`
    expect(parseMeeJson(raw)).not.toBeNull()
  })
})

describe('mapMeeResult', () => {
  it('每个能量段 → 一个 window，响度与起音率落在 measurements 里', () => {
    const mapped = mapMeeResult(makeMeeJson())!
    expect(mapped.windows).toHaveLength(5)
    expect(mapped.windows[0].from).toBe(0)
    expect(mapped.windows[0].to).toBe(14.4)
    expect(mapped.windows[0].measurements).toMatchObject({
      loudness: -27.8,
      onsetRate: 3.89,
      tempo: 123,
    })
    // 第二段最响
    expect(mapped.windows[1].measurements.loudness).toBe(-22)
  })

  it('段落边界是测量值，挂在该段的 measurements.boundaries', () => {
    const mapped = mapMeeResult(makeMeeJson())!
    // 14.4 正好是第一段 end / 第二段 start —— 归给后一段
    expect(mapped.windows[0].measurements.boundaries).toBeUndefined()
    expect(mapped.windows[1].measurements.boundaries).toEqual([14.4])
    expect(mapped.windows[2].measurements.boundaries).toEqual([58.6])
    // 边界本身也在 summary 里（带 dB 跳变）
    expect(mapped.summary?.boundaries).toEqual([
      { t: 14.4, jumpDb: 5.7 },
      { t: 58.6, jumpDb: 9.6 },
      { t: 114.2, jumpDb: 10.4 },
    ])
  })

  it('整集读数进 summary（BPM / 调性 / LUFS / 起音率）', () => {
    const mapped = mapMeeResult(makeMeeJson())!
    expect(mapped.summary).toMatchObject({
      bpm: 123,
      tempoStable: true,
      key: 'G minor',
      lufs: -20.54,
      rmsDbfs: -21.62,
      peakDbfs: -1.55,
      onsetRate: 4.25,
      segments: 5,
      sourcesAvailable: false,
    })
  })

  it('引擎自报的不可用项要进 notes（否则模型会把不可靠读数当事实）', () => {
    const mapped = mapMeeResult(makeMeeJson())!
    expect(mapped.notes?.some((note) => note.includes('不可用'))).toBe(true)
    expect(mapped.notes?.some((note) => note.includes('音源分离'))).toBe(true)
    expect(mapped.notes?.some((note) => note.includes('根音候选'))).toBe(true)
  })

  it('传了 offset 时时间戳整体平移（只分析片段时用）', () => {
    const mapped = mapMeeResult(makeMeeJson(), { offset: 300, duration: 180 })!
    expect(mapped.windows[0].from).toBe(300)
    expect(mapped.windows[0].to).toBeCloseTo(314.4, 1)
    expect(mapped.summary?.boundaries[0].t).toBeCloseTo(314.4, 1)
  })

  it('没有能量段时返回空 windows（不编造段）', () => {
    const mapped = mapMeeResult(makeMeeJson({
      timeline: { energy: [], section_boundaries: [] },
    }))!
    expect(mapped.windows).toEqual([])
  })

  it('坏输入返回 null', () => {
    expect(mapMeeResult(null)).toBeNull()
    expect(mapMeeResult('not-an-object')).toBeNull()
  })
})

describe('musicMeeProvider', () => {
  it('环境没装好时不抛错，只给 notes 说明', async () => {
    const provider = createMusicMeeProvider({
      runtime: () => ({ ok: false, python: null, reason: '找不到装了 MEE 的 Python' }),
    })
    const ready = await provider.ready()
    expect(ready.ok).toBe(false)
    expect(String(ready.reason)).toContain('找不到')

    const result = await provider.analyze({ file: __filename, duration: 180 })
    expect(result.windows).toEqual([])
    expect(result.notes?.[0]).toContain('未做配乐分析')
  })

  it('视频不存在时降级成空 windows + notes（不影响整集分析）', async () => {
    const provider = createMusicMeeProvider({
      runtime: () => ({ ok: true, python: 'python', version: '0.1.5' }),
    })
    const result = await provider.analyze({
      file: path.join(os.tmpdir(), 'no-such-video-xyz.mp4'),
      duration: 180,
    })
    expect(result.windows).toEqual([])
    expect(result.notes?.join('')).toContain('找不到视频文件')
  })

  it('抽不到音轨（不是视频文件）时也不抛错', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mee-test-'))
    const fake = path.join(dir, 'fake.mp4')
    fs.writeFileSync(fake, 'not a video at all')
    try {
      const provider = createMusicMeeProvider({
        runtime: () => ({ ok: true, python: 'python', version: '0.1.5' }),
        // CLI 不该被调用到（ffmpeg 会先失败），真调了也无所谓
        runCli: vi.fn(async () => ({ ok: false, error: '不该走到这里' })),
      })
      const result = await provider.analyze({ file: fake, duration: 180 })
      expect(result.windows).toEqual([])
      expect(result.notes?.join('')).toMatch(/抽取音轨失败|配乐分析失败/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ready 成功时带上版本号（面板上能看出跑的是哪个引擎）', async () => {
    const provider = createMusicMeeProvider({
      runtime: () => ({
        ok: true,
        python: 'C:/Python311/python.exe',
        version: '0.1.5',
        detail: 'python · MEE 0.1.5',
      }),
    })
    const ready = await provider.ready()
    expect(ready.ok).toBe(true)
    expect(ready.version).toBe('0.1.5')
  })
})
