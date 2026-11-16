// @vitest-environment node
/**
 * adapters/transcript-moss 单测
 *
 * 这条适配器最容易出的问题不是"转写不准"（那是模型的锅），而是**桥接层的形状问题**：
 *   - 环境探测顺序错 → 系统 python 抢在 conda env 前面，用户在面板上看到"已就绪"但一跑就 import 失败；
 *   - stdout 解析太天真 → transformers 漏一行警告到 stdout 就整条链路判死；
 *   - 失败抛错而不是降级 → 没有 MOSS 的机器连"只做画面"都跑不了。
 *
 * 所以这里全部用注入的假 runtime / 假 runBridge，**不加载模型、不碰 GPU**。
 * 真实调用留给 `AI_LIVE=1` 那类手工验证（一集 24 分钟要 10 分钟，不适合进 CI）。
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
// .mjs 适配器是给 worker 直接 import 的，项目没开 allowJs、也没有 d.ts，
// 所以 tsc 会报 TS7016；这里用 @ts-expect-error 压掉，再把导出 cast 成明确形状。
// @ts-expect-error —— .mjs 没有类型声明
import * as mossModule from '../../../plugins/watch-analysis/adapters/transcript-moss.mjs'

interface MossSegment {
  start: number
  end: number
  text: string
  source: string
  speaker?: string
}
interface MossRuntime {
  ok: boolean
  python: string | null
  bridge: string
  model: string | null
  reason?: string
  detail?: string
}
interface MossResult {
  segments: MossSegment[]
  source: string
  notes?: string[]
  speakers?: number
}
interface MossProvider {
  id: string
  label: string
  priority: number
  ready(): Promise<{ ok: boolean; reason?: string; detail?: string }>
  transcribe(
    video: { file: string; duration?: number },
    opts?: { signal?: AbortSignal; onLog?: (message: string) => void; onProgress?: (done: number, total: number) => void },
  ): Promise<MossResult>
}

const {
  MOSS_SOURCE,
  countSpeakers,
  createTranscriptMossProvider,
  mapMossSegments,
  modelCandidates,
  parseMossOutput,
  pythonCandidates,
  resolveMossRuntime,
  runMossBridge,
} = mossModule as unknown as {
  MOSS_SOURCE: string
  countSpeakers: (segments: Array<{ speaker?: string; text?: string }>) => number
  createTranscriptMossProvider: (deps?: { runtime?: () => MossRuntime; runBridge?: (options: Record<string, unknown>) => Promise<unknown> }) => MossProvider
  mapMossSegments: (raw: unknown) => MossSegment[]
  modelCandidates: (env?: NodeJS.ProcessEnv) => string[]
  parseMossOutput: (stdout: unknown) => { ok: boolean; segments?: unknown[]; error?: string; elapsed?: number } | null
  pythonCandidates: (env?: NodeJS.ProcessEnv) => string[]
  resolveMossRuntime: (env?: NodeJS.ProcessEnv) => MossRuntime
  runMossBridge: (options: {
    python: string
    bridge: string
    model: string
    file: string
    timeoutMs?: number
    signal?: AbortSignal
    onLog?: (message: string) => void
  }) => Promise<{ ok: boolean; error?: string; segments?: unknown[]; elapsed?: number }>
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.resolve(HERE, '../../fixtures/watch-sample.mp4')

describe('环境探测', () => {
  it('python 候选：环境变量优先，然后 conda 的 moss env，最后才是 PATH', () => {
    const candidates = pythonCandidates({
      ANIMEDIARY_MOSS_PYTHON: 'C:\\custom\\python.exe',
      USERPROFILE: 'C:\\Users\\tester',
    })
    expect(candidates[0]).toBe('C:\\custom\\python.exe')
    // 本机约定：conda env 叫 moss，权重和 torch 都在里面
    expect(candidates.some((p: string) => p.includes(path.join('miniconda3', 'envs', 'moss')))).toBe(true)
    expect(candidates.at(-1)).toBe('python3')
  })

  it('CONDA_PREFIX 指向 moss env 时直接用它（conda activate 过的 shell 最准）', () => {
    const candidates = pythonCandidates({
      CONDA_PREFIX: 'C:\\Users\\tester\\miniconda3\\envs\\moss',
      USERPROFILE: 'C:\\Users\\tester',
    })
    expect(candidates[0]).toBe(path.join('C:\\Users\\tester\\miniconda3\\envs\\moss', 'python.exe'))
  })

  it('模型候选：环境变量 → 本机 D 盘权重 → HF id 兜底', () => {
    const candidates = modelCandidates({
      ANIMEDIARY_MOSS_MODEL: 'E:\\weights\\moss',
      USERPROFILE: 'C:\\Users\\tester',
    })
    expect(candidates[0]).toBe('E:\\weights\\moss')
    expect(candidates).toContain('D:\\models\\MOSS-Transcribe-Diarize')
    expect(candidates.at(-1)).toBe('OpenMOSS-Team/MOSS-Transcribe-Diarize')
  })

  it('探测结果带可读的补装线索（ok=false 时 reason/detail 都不能空）', () => {
    const runtime = resolveMossRuntime({ USERPROFILE: 'C:\\Users\\tester' })
    expect(runtime.bridge.endsWith('moss_bridge.py')).toBe(true)
    // 有 bridge、有 python 兜底、没有本地权重时退回 HF id —— 所以这里应当是「就绪但可能要下载」
    expect(typeof runtime.ok).toBe('boolean')
    if (!runtime.ok) {
      expect(runtime.reason).toBeTruthy()
      expect(runtime.detail).toBeTruthy()
    }
  })
})

describe('parseMossOutput', () => {
  it('stdout 混进警告时，取最后一条带 ok 的 JSON', () => {
    const stdout = [
      'W1116 torch note: redirects not supported',
      '{"ok": false, "error": "旧的一行"}',
      '{"ok": true, "segments": [{"start": 0, "end": 1, "speaker": "S01", "text": "台词"}]}',
    ].join('\n')
    const parsed = parseMossOutput(stdout)
    expect(parsed).toMatchObject({ ok: true })
    expect(parsed?.segments).toHaveLength(1)
  })

  it('没有任何 JSON 时返回 null（调用方当失败处理，不抛错）', () => {
    expect(parseMossOutput('boom\nTraceback (most recent call last):')).toBeNull()
    expect(parseMossOutput('')).toBeNull()
    expect(parseMossOutput('{ 不是合法的 json }')).toBeNull()
  })
})

describe('mapMossSegments', () => {
  it('过滤空文本和零长度区间，按时间排序，来源统一是 asr-moss', () => {
    const segments = mapMossSegments([
      { start: 9, end: 11, speaker: 'S02', text: ' 第二句 ' },
      { start: 5, end: 5, speaker: 'S01', text: '零长度的空壳' },
      { start: 0, end: 2.5, speaker: 'S01', text: '第一句' },
      { start: 3, end: 4, speaker: 'S01', text: '   ' },
    ])
    expect(segments).toHaveLength(2)
    expect(segments[0]).toMatchObject({ start: 0, end: 2.5, text: '第一句', speaker: 'S01', source: MOSS_SOURCE })
    expect(segments[1]).toMatchObject({ start: 9, end: 11, text: '第二句', speaker: 'S02' })
  })

  it('没有 speaker 时不塞 undefined 字段（报告里不该出现 "speaker": null）', () => {
    const segments = mapMossSegments([{ start: 0, end: 1, text: '没有说话人' }])
    expect(segments[0]).not.toHaveProperty('speaker')
  })

  it('countSpeakers 只数出现过的说话人', () => {
    expect(countSpeakers([
      { speaker: 'S01' },
      { speaker: 'S01' },
      { speaker: 'S03' },
      { text: '旁白没有编号' },
    ])).toBe(2)
    expect(countSpeakers([])).toBe(0)
  })
})

describe('createTranscriptMossProvider', () => {
  const okRuntime = () => ({
    ok: true,
    python: 'C:\\python.exe',
    bridge: 'C:\\bridge.py',
    model: 'D:\\models\\MOSS-Transcribe-Diarize',
    detail: 'fake',
  })

  it('环境未就绪：返回空 segments + notes，不抛错、也不去起子进程', async () => {
    const runBridge = vi.fn()
    const provider = createTranscriptMossProvider({
      runtime: () => ({ ok: false, python: null, bridge: '', model: null, reason: '找不到 MOSS 的 Python 环境' }),
      runBridge,
    })

    await expect(provider.ready()).resolves.toMatchObject({ ok: false, reason: '找不到 MOSS 的 Python 环境' })
    const result = await provider.transcribe({ file: FIXTURE, duration: 9 })
    expect(result.segments).toEqual([])
    expect(result.notes?.[0]).toContain('未做语音识别')
    expect(runBridge).not.toHaveBeenCalled()
  })

  it('转写成功：映射 segments、统计说话人、把耗时与免责声明写进 notes', async () => {
    const onLog = vi.fn()
    const onProgress = vi.fn()
    const provider = createTranscriptMossProvider({
      runtime: okRuntime,
      // 模拟真实 bridge：它会往 stderr 打阶段日志，adapter 转成 onLog
      runBridge: vi.fn().mockImplementation(async (options: { onLog?: (message: string) => void }) => {
        options.onLog?.('本地语音识别：模型已加载，开始推理')
        return {
          ok: true,
          elapsed: 12.5,
          segments: [
            { start: 0.5, end: 2, speaker: 'S01', text: '第一句' },
            { start: 2, end: 4, speaker: 'S02', text: '第二句' },
            { start: 4, end: 6, speaker: 'S01', text: '第三句' },
          ],
        }
      }),
    })

    const result = await provider.transcribe(
      { file: FIXTURE, duration: 9 },
      { onLog, onProgress },
    )

    expect(result.segments).toHaveLength(3)
    expect(result.source).toBe(MOSS_SOURCE)
    // 说话人分离是这个 adapter 相对「外挂字幕」的唯一增量，必须传出去
    expect(result.speakers).toBe(2)
    expect(result.segments[2]).toMatchObject({ start: 4, end: 6, speaker: 'S01' })
    expect(result.notes?.join(' ')).toContain('同音字')
    expect(result.notes?.join(' ')).toContain('12.5')
    // 进度：至少通知了开始，且把阶段文案转给了 UI
    expect(onProgress).toHaveBeenCalled()
    expect(onLog).toHaveBeenCalled()
    expect(onLog.mock.calls.some((call: unknown[]) => String(call[0]).includes('模型已加载'))).toBe(true)
  })

  it('转写失败：同样降级成空 segments，失败原因进 notes（不让整次分析失败）', async () => {
    const provider = createTranscriptMossProvider({
      runtime: okRuntime,
      runBridge: vi.fn().mockResolvedValue({ ok: false, error: 'CUDA out of memory' }),
    })

    const result = await provider.transcribe({ file: FIXTURE, duration: 9 })
    expect(result.segments).toEqual([])
    expect(result.notes?.[0]).toContain('CUDA out of memory')
  })

  it('识别成功但没有一句话（纯环境音）时明确说「没识别出内容」', async () => {
    const provider = createTranscriptMossProvider({
      runtime: okRuntime,
      runBridge: vi.fn().mockResolvedValue({ ok: true, segments: [] }),
    })

    const result = await provider.transcribe({ file: FIXTURE, duration: 9 })
    expect(result.segments).toEqual([])
    expect(result.speakers).toBeUndefined()
    expect(result.notes?.[0]).toContain('没有识别出任何台词')
  })

  it('视频文件不存在时直接返回空，不起子进程', async () => {
    const runBridge = vi.fn()
    const provider = createTranscriptMossProvider({ runtime: okRuntime, runBridge })
    const result = await provider.transcribe({ file: path.join(HERE, 'no-such-video.mp4'), duration: 9 })
    expect(result.segments).toEqual([])
    expect(result.notes?.[0]).toContain('找不到视频文件')
    expect(runBridge).not.toHaveBeenCalled()
  })
})

describe('runMossBridge', () => {
  it('解释器不存在时返回 { ok:false }，不抛错（端口约定：异常降级成空结果）', async () => {
    const result = await runMossBridge({
      python: path.join(HERE, 'definitely-not-a-python-xyz'),
      bridge: path.join(HERE, '../../../plugins/watch-analysis/adapters/moss_bridge.py'),
      model: 'fake',
      file: FIXTURE,
      timeoutMs: 5_000,
    })
    expect(result.ok).toBe(false)
    expect(typeof result.error).toBe('string')
  })

  it('bridge 脚本真实存在（打包靠 asarUnpack，缺了这条链路会静默失效）', () => {
    expect(existsSync(path.resolve(HERE, '../../../plugins/watch-analysis/adapters/moss_bridge.py'))).toBe(true)
  })
})
