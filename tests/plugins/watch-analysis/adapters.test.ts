// @vitest-environment node
/**
 * worker 侧两个 adapter 的**真实调用**集成测试（不 mock、不打桩）
 *
 * 为什么不用 mock：这两个 adapter 的整个价值就是"把 dsh-video-storyboard 的真实返回翻译成
 * 冻结协议"—— 返回结构、单位、0/1 起点这些坑只有跑真视频才暴露。mock 掉依赖等于把被测对象
 * 一起 mock 掉了，升级 dsh-video-storyboard 后它变了我这里也不会红。
 *
 * 素材：tests/fixtures/watch-sample.mp4（640×360 / 24fps / 9s，红蓝绿三段纯色 + 正弦音轨，
 * 切点在 3s 与 6s）。这就是"切点检测"和"音轨证据"两件事的黄金样本：
 *   - 颜色突变在 HSV 差分上是 255 分的满格刀，不存在"阈值微调就漂"的模糊地带；
 *   - 音轨是恒定响度的正弦波，EBU R128 的 mean 应当≈ -21.8 LUFS（依赖自己探针报过的数）。
 *
 * 为什么动态 import 而不是 `import ... from '...mjs'`：
 *   适配器是 .mjs —— worker 子进程直接 import 它们，Node 不认 TS，所以不能写成 .ts；
 *   而仓库的 tsconfig 没开 allowJs、也不该为两个 JS 文件加 .d.ts（本阶段只允许这 3 个文件）。
 *   用"非字面量说明符"的动态 import 让 tsc 不去解析模块（类型由下面的局部 interface 兜住），
 *   运行期则走 Node 原生 ESM —— 这也正是 worker 里 `await import('../adapters/...mjs')` 的同一条路径。
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** tests/plugins/watch-analysis → tests/fixtures */
const FIXTURE = path.resolve(HERE, '../../fixtures/watch-sample.mp4')
/** 仓库根的 plugins/watch-analysis/adapters */
const ADAPTERS_DIR = path.resolve(HERE, '../../../plugins/watch-analysis/adapters')

/** 和 ports/cut.ts、ports/render.ts、runtime/protocol.ts 对齐的局部类型（只为让测试读起来有约束） */
interface Cut {
  t: number
  score: number
}
interface ReadyState {
  ok: boolean
  reason?: string
  detail?: string
}
interface SheetCellShot {
  i: number
  start: number
  end: number
  frameAt: number
  tier: number
  text?: string
  cuts?: number
}
interface SheetFile {
  file: string
  width: number
  height: number
  cells: number
  shots: number[]
}
interface AudioEvidence {
  mean: number
  peak: number
  series: number[]
  step: number
  silences: Array<[number, number]>
}
interface RenderPlanShape {
  strategy: string
  sheets: number
  frames: number
  fill: number
  canvas: { width: number; height: number }
  tiers: Record<string, number>
}
interface RenderOut {
  shots: SheetCellShot[]
  sheets: SheetFile[]
  plan: RenderPlanShape
  notes?: string[]
  audio?: AudioEvidence
}
interface CutProviderLike {
  id: string
  label: string
  ready(): Promise<ReadyState>
  detect(video: VideoLike, opts?: Record<string, unknown>): Promise<{ cuts: Cut[]; raw: unknown }>
}
interface RendererLike {
  id: string
  label: string
  ready(): Promise<ReadyState>
  render(video: VideoLike, cuts: Cut[], opts: Record<string, unknown>): Promise<RenderOut>
}
interface VideoLike {
  file: string
  duration: number
  fps: number
  width: number
  height: number
}

/** 素材的已核实元数据（ffprobe 口径，见 tests/fixtures/storyboard-contract.json 的 info 段） */
const VIDEO: VideoLike = {
  file: FIXTURE,
  duration: 9,
  fps: 24,
  width: 640,
  height: 360,
}

/** 见文件头：非字面量说明符 ⇒ tsc 不解析、运行期走 Node ESM */
async function importAdapter<T>(fileName: string): Promise<T> {
  return (await import(pathToFileURL(path.join(ADAPTERS_DIR, fileName)).href)) as T
}

let cutProvider: CutProviderLike
let renderProvider: RendererLike
let cutResult: { cuts: Cut[]; raw: unknown }
let rendered: RenderOut
let outDir: string

beforeAll(async () => {
  expect(existsSync(FIXTURE)).toBe(true)

  const cutModule = await importAdapter<{ cutHsvProvider: CutProviderLike }>('cut-hsv.mjs')
  const renderModule = await importAdapter<{ renderStoryboardProvider: RendererLike }>('render-storyboard.mjs')
  cutProvider = cutModule.cutHsvProvider
  renderProvider = renderModule.renderStoryboardProvider

  outDir = mkdtempSync(path.join(tmpdir(), 'watch-adapters-'))

  // 一次真实扫描（~0.1s）—— render 阶段就是靠这份 raw 复用，不再二次解码
  cutResult = await cutProvider.detect(VIDEO)

  rendered = await renderProvider.render(VIDEO, cutResult.cuts, {
    outDir,
    prefix: 'ep01',
    // 生产路径：worker 把 cut-hsv 的 raw 透传给 render，避免二次扫描
    precomputed: cutResult.raw,
  })
}, 180_000)

afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true })
})

describe('adapters 的导出形状', () => {
  it('两个 provider 都有稳定的 id / label / ready()', async () => {
    expect(typeof cutProvider.id).toBe('string')
    expect(cutProvider.id).toBe('hsv')
    expect(typeof cutProvider.label).toBe('string')
    expect(typeof cutProvider.detect).toBe('function')

    expect(typeof renderProvider.id).toBe('string')
    expect(renderProvider.id).toBe('storyboard')
    expect(typeof renderProvider.label).toBe('string')
    expect(typeof renderProvider.render).toBe('function')

    // ready() **不抛错**：缺依赖时返回 { ok:false, reason }，pipeline 据此降级
    await expect(cutProvider.ready()).resolves.toMatchObject({ ok: true })
    await expect(renderProvider.ready()).resolves.toMatchObject({ ok: true })
  })
})

describe('cut-hsv：真实扫描 watch-sample.mp4', () => {
  it('返回 { cuts, raw }，raw 是 scanShots 的完整返回（留给 render 复用）', () => {
    expect(Array.isArray(cutResult.cuts)).toBe(true)
    expect(cutResult.raw).toBeTruthy()
    const raw = cutResult.raw as { cuts?: Cut[]; summary?: unknown; threshold?: number }
    // render 的 precomputed 分支会读 cuts / summary / threshold / prints
    expect(Array.isArray(raw.cuts)).toBe(true)
    expect(raw.summary).toBeTruthy()
    expect(typeof raw.threshold).toBe('number')
  })

  it('至少 2 个切点，且落在 3s 与 6s（±0.5s）', () => {
    expect(cutResult.cuts.length).toBeGreaterThanOrEqual(2)

    const near = (t: number) => cutResult.cuts.some((c) => Math.abs(c.t - t) <= 0.5)
    expect(near(3)).toBe(true)
    expect(near(6)).toBe(true)

    // 纯色三段：切点应该正好压在两段交界，分数是满格（HSV 差 0–255 口径）
    for (const cut of cutResult.cuts) {
      expect(cut.t).toBeGreaterThanOrEqual(0)
      expect(cut.t).toBeLessThanOrEqual(VIDEO.duration)
      expect(cut.score).toBeGreaterThan(0)
    }
  })
})

describe('render-storyboard：真实排版 + 落盘', () => {
  it('shots 是 0 起序号、首尾相接、不重叠、覆盖全片', () => {
    const { shots } = rendered
    expect(shots.length).toBeGreaterThanOrEqual(1)

    // i 从 0 开始且连续（storyboard 的 cell.i 从 1 开始，adapter 负责 -1）
    expect(shots.map((s) => s.i)).toEqual(shots.map((_, i) => i))

    // shots[0].start === 0 是半开区间 [start, end) 的起点约定
    expect(shots[0].start).toBe(0)

    for (let i = 0; i < shots.length - 1; i += 1) {
      // 相邻镜头首尾相接：不留缝（end !== start）
      expect(shots[i].end).toBe(shots[i + 1].start)
      // 不重叠（等价于上一行，但失败信息更直白）
      expect(shots[i].end).toBeLessThanOrEqual(shots[i + 1].start)
    }

    // 最后一段吃到片尾（9s，±0.1 = 2 帧的取整余量）
    expect(Math.abs((shots.at(-1)?.end ?? 0) - VIDEO.duration)).toBeLessThan(0.1)

    for (const shot of shots) {
      expect(shot.end).toBeGreaterThan(shot.start)
      expect(shot.tier).toBeGreaterThanOrEqual(1)
      expect(shot.tier).toBeLessThanOrEqual(8)
      expect(shot.frameAt).toBeGreaterThanOrEqual(shot.start)
      expect(shot.frameAt).toBeLessThanOrEqual(shot.end)
    }
  })

  it('plan.frames 与 shots.length 一致（帧 = 镜头，一格对应一段）', () => {
    expect(rendered.plan.frames).toBe(rendered.shots.length)
    expect(typeof rendered.plan.strategy).toBe('string')
    expect(rendered.plan.canvas.width).toBeGreaterThan(0)
    expect(rendered.plan.canvas.height).toBeGreaterThan(0)
    expect(rendered.plan.tiers).toBeTypeOf('object')
  })

  it('sheets：至少一张，file 是相对 outDir 的名字且在磁盘上真实存在', () => {
    expect(Array.isArray(rendered.sheets)).toBe(true)
    expect(rendered.sheets.length).toBeGreaterThanOrEqual(1)

    const allShotIndexes: number[] = []
    for (const sheet of rendered.sheets) {
      // 只回文件名（相对 outDir），**绝不回 Buffer / 绝对路径**（IPC 会炸）
      expect(path.isAbsolute(sheet.file)).toBe(false)
      expect(sheet.file.endsWith('.png')).toBe(true)
      expect(sheet.width).toBeGreaterThan(0)
      expect(sheet.height).toBeGreaterThan(0)

      const absolute = path.join(outDir, sheet.file)
      expect(existsSync(absolute)).toBe(true)

      // cells 是"这张图里放了几帧"（数量），shots 是镜头序号（cell.i - 1）
      expect(sheet.cells).toBeGreaterThan(0)
      expect(sheet.shots.length).toBe(sheet.cells)
      for (const shotIndex of sheet.shots) {
        expect(shotIndex).toBeGreaterThanOrEqual(0)
        expect(shotIndex).toBeLessThan(rendered.shots.length)
      }
      allShotIndexes.push(...sheet.shots)
    }

    // 每张图的格子合起来 = 全部镜头，不重不漏
    expect(allShotIndexes.slice().sort((a, b) => a - b)).toEqual(
      rendered.shots.map((s) => s.i).sort((a, b) => a - b),
    )
  })

  it('audio：透传 EBU R128 响度证据（mean 为负 ≈ -21.8 LUFS，series 非空）', () => {
    const audio = rendered.audio
    expect(audio).toBeTruthy()
    expect(typeof audio?.mean).toBe('number')
    // 纯正弦音轨实测 -21.8 LUFS：量级不对（0 或正数）说明字段接错了
    expect(audio?.mean).toBeLessThan(0)
    expect(audio?.mean).toBeCloseTo(-21.8, 0)
    expect(audio?.peak).toBeLessThan(0)
    expect(Array.isArray(audio?.series)).toBe(true)
    expect(audio?.series.length).toBeGreaterThan(0)
    expect(audio?.step).toBeGreaterThan(0)
    // 静音段必须是 [from, to] 元组（会进 IPC，形状钉死；一段恒定正弦可能一个都没有）
    expect(Array.isArray(audio?.silences)).toBe(true)
    for (const silence of audio?.silences ?? []) {
      expect(silence).toHaveLength(2)
      expect(typeof silence[0]).toBe('number')
      expect(typeof silence[1]).toBe('number')
      expect(silence[1]).toBeGreaterThan(silence[0])
    }
  })
})
