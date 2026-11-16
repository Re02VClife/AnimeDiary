/**
 * render-grid23.mjs — 2×3 六格宫格渲染器（每张 1280×1080，每格 640×360）
 *
 * 为什么不用 dsh-video-storyboard 的排版：它的画布比例**锁定视频比例**（16:9），
 * 档位只决定"每行放几格"。实测把 maxCanvasSide 拉到 1300，画布也只到 1050×591、
 * 每格 150×84 —— 想要 2 列 3 行（1280×1080 / 4:3.4）必须自己拼。
 *
 * 这个渲染器刻意做成独立 adapter：`SheetRenderer` 端口只要求
 * `render(video, cuts, opts) → { shots, sheets, plan }`，
 * 所以换排版策略不会碰到 pipeline / worker / 报告格式。
 *
 * 帧的选择是**按时间均分**：每张图覆盖 80 秒，内部 6 等分（每格约 13 秒），
 * 格子里取该区间中点抽帧。不依赖切点——切点仍然是分析产物（影评里会引用
 * "597 个镜头/595 个切点"这类统计），但不参与这个渲染器的取样。
 */
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** 2 列 × 3 行 */
const COLS = 2
const ROWS = 3
/** 单格尺寸：640×360（16:9），整图 1280×1080 */
const CELL_W = 640
const CELL_H = 360
const SHEET_W = COLS * CELL_W // 1280
const SHEET_H = ROWS * CELL_H // 1080
const CELLS_PER_SHEET = COLS * ROWS // 6

/** 每张图覆盖多少秒。80 秒 × 6 格 = 每格约 13 秒，一集 24 分钟出 18 张 */
const SHEET_SECONDS = 80
/**
 * 默认张数上限：不传参数时最多 40 张（3 小时的片也能出，不至于撑爆请求体）。
 * 用户在面板上可以配到 `MAX_SHEET_LIMIT`，那时代替这个默认值。
 */
const MAX_SHEETS = 40
/** 面板允许配置的硬上限：10000 张（再高就是重复抽同一帧了，没有意义） */
export const MAX_SHEET_LIMIT = 10_000
/** 同时最多几个 ffmpeg（抽帧是 CPU 密集，开太多反而慢） */
const CONCURRENCY = 4

async function ffmpeg(args) {
  return run('ffmpeg', args, {
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  })
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw new DOMException('渲染已取消', 'AbortError')
}

/**
 * 抽一帧并缩放/补边到 640×360。
 *
 * `-ss` 放在 `-i` 前面是**快速 seek**（跳到最近关键帧），对"取一张代表帧"足够，
 * 而且比精确 seek 快一个数量级 —— 一集要抽一百多帧，这个差别很实在。
 * `decrease + pad` 保证非 16:9 的素材不拉伸变形（黑边补足）。
 */
async function extractFrame(video, seconds, outPath, signal) {
  assertNotAborted(signal)
  const vf = [
    `scale=${CELL_W}:${CELL_H}:force_original_aspect_ratio=decrease`,
    `pad=${CELL_W}:${CELL_H}:(ow-iw)/2:(oh-ih)/2:black`,
  ].join(',')
  await ffmpeg([
    '-y', '-loglevel', 'error',
    '-ss', String(Math.max(0, seconds)),
    '-i', video,
    '-frames:v', '1',
    '-vf', vf,
    outPath,
  ])
}

/** 把 6 张单格拼成 2 列 × 3 行 */
async function tileSheet(frames, outPath) {
  if (frames.length !== CELLS_PER_SHEET) {
    throw new Error(`tileSheet 需要 ${CELLS_PER_SHEET} 帧，实际 ${frames.length} 张`)
  }
  const inputs = frames.flatMap((file) => ['-i', file])
  // 注意：不要在末尾挂无标签的 `format=rgb24` —— ffmpeg 会把它当成需要新输入流的滤镜，
  // 报 "Cannot find an unused video input stream to feed the unlabeled input pad"。
  // vstack 的输出会自动成为 filtergraph 的输出，PNG 编码器自己会做像素格式转换。
  const filter = [
    '[0][1]hstack[r0]',
    '[2][3]hstack[r1]',
    '[4][5]hstack[r2]',
    // vstack 默认只吃 2 个输入，3 行必须显式 inputs=3（否则报 "3 > 2"）
    `[r0][r1][r2]vstack=inputs=${ROWS}`,
  ].join(';')
  await ffmpeg([
    '-y', '-loglevel', 'error',
    ...inputs,
    '-filter_complex', filter,
    '-frames:v', '1',
    // JPEG 而不是 PNG：1280×1080 的 PNG 每张近 800KB，18 张就是 14MB，
    // 转成 base64 后请求体根本发不出去（实测 8 张图就把上游撑到 140 秒被掐）。
    // q:v 3 约 250KB，肉眼看不出差别，staff 小字照样能读。
    '-q:v', '3',
    outPath,
  ])
}

/** 限并发的简单任务池 */
async function runPool(tasks, limit) {
  const results = new Array(tasks.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= tasks.length) return
      results[index] = await tasks[index]()
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * 规划每张图覆盖哪段时间、每格取哪一帧。
 *
 * 抽成纯函数是为了能单测：给定时长和张数，输出的时间段必须首尾相接、不重叠、
 * 覆盖全片 —— 这个渲染器最容易错的地方就是时间轴算歪，
 * 而算歪了不会报错，只会让影评引用的时间码对不上画面。
 *
 * 张数规则（2026-11-16 起支持自定义上下限）：
 *   自动张数 = ceil(时长 / sheetSeconds)   // 默认每 80 秒一张
 *   实际张数 = clamp(自动张数, minSheets, maxSheets)
 * 所以 `{ minSheets: 100, maxSheets: 1000 }` 对 24 分钟的片会出 100 张（自动只有 18）；
 * `{ maxSheets: 10 }` 会压到 10 张（每格覆盖更久）。两个都传 0 / 不传 = 自动。
 *
 * 上下限写反时按**下限优先**纠正（lower 胜出），不返回空计划 ——
 * 用户把 1000 填在左边是常见手误，静默给空图比给多几张图更糟。
 */
export function planGrid23(duration, {
  sheetSeconds = SHEET_SECONDS,
  minSheets = 1,
  maxSheets = MAX_SHEETS,
} = {}) {
  const total = Number(duration)
  if (!Number.isFinite(total) || total <= 0) return []

  const auto = Math.max(1, Math.ceil(total / sheetSeconds))
  const lower = Math.min(
    MAX_SHEET_LIMIT,
    Math.max(1, Math.round(Number(minSheets) || 1)),
  )
  const upper = Math.min(
    MAX_SHEET_LIMIT,
    Math.max(lower, Math.round(Number(maxSheets) || MAX_SHEETS)),
  )
  const sheetCount = Math.min(upper, Math.max(lower, auto))

  const sheetSpan = total / sheetCount
  const cellSpan = sheetSpan / CELLS_PER_SHEET
  const sheets = []
  for (let s = 0; s < sheetCount; s += 1) {
    const cells = []
    for (let c = 0; c < CELLS_PER_SHEET; c += 1) {
      const start = s * sheetSpan + c * cellSpan
      const end = start + cellSpan
      cells.push({ start, end, at: start + cellSpan / 2 })
    }
    sheets.push({ index: s, start: s * sheetSpan, end: (s + 1) * sheetSpan, cells })
  }
  return sheets
}

export const renderGrid23Provider = {
  id: 'grid6',
  label: '2×3 六格（1280×1080）',

  async ready() {
    // ffmpeg 缺失由实际调用暴露，这里不做重复探测（server/deps.ts 负责依赖视图）
    return { ok: true, detail: '内置 ffmpeg 抽帧 + tile 拼图' }
  },

  /**
   * @param {{ file: string, duration: number, fps?: number }} video
   * @param {Array<{ t: number, score: number }>} _cuts 切点（本渲染器不参与取样，保留签名兼容端口）
   * @param {{ outDir: string, prefix?: string, signal?: AbortSignal, onProgress?: Function }} opts
   */
  async render(video, _cuts, opts) {
    if (!video?.file) throw new Error('render-grid23: video.file 缺失，无法出图')
    if (!opts?.outDir) throw new Error('render-grid23: opts.outDir 缺失（必须是绝对目录）')
    assertNotAborted(opts.signal)

    const outDir = path.resolve(opts.outDir)
    const prefix = String(opts.prefix || 'sheet')
    await mkdir(outDir, { recursive: true })

    const planned = planGrid23(video.duration, {
      minSheets: opts.minSheets,
      maxSheets: opts.maxSheets,
    })
    if (planned.length === 0) throw new Error('render-grid23: 视频时长无效，无法规划宫格')

    const scratch = await mkdtemp(path.join(tmpdir(), 'grid23-'))
    const shots = []
    const sheets = []

    try {
      for (const sheet of planned) {
        assertNotAborted(opts.signal)
        const frames = sheet.cells.map((cell, c) => {
          const index = sheet.index * CELLS_PER_SHEET + c
          return {
            index,
            cell,
            file: path.join(scratch, `s${sheet.index}-${c}.png`),
          }
        })

        await runPool(
          frames.map((frame) => () => extractFrame(video.file, frame.cell.at, frame.file, opts.signal)),
          CONCURRENCY,
        )

        // 输出 JPEG（不是 PNG）：见 tileSheet 里 -q:v 的注释，体积差 3 倍
        const file = `${prefix}-${sheet.index + 1}.jpg`
        await tileSheet(frames.map((frame) => frame.file), path.join(outDir, file))

        for (const frame of frames) {
          shots.push({
            i: frame.index,
            start: Math.round(frame.cell.start * 100) / 100,
            end: Math.round(frame.cell.end * 100) / 100,
            frameAt: Math.round(frame.cell.at * 100) / 100,
            // tier 固定 2 只是为了让报告里的"档位"字段有意义：这个渲染器不按切密度分档，
            // 所有格子同尺寸（这本来就是「写死 2×3」的语义）
            tier: 2,
          })
        }
        sheets.push({
          file,
          width: SHEET_W,
          height: SHEET_H,
          cells: CELLS_PER_SHEET,
          shots: frames.map((frame) => frame.index),
        })
        opts.onProgress?.('render', sheet.index + 1, planned.length)
      }
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => {})
    }

    return {
      shots,
      sheets,
      plan: {
        strategy: 'grid6',
        sheets: sheets.length,
        frames: shots.length,
        // 6 格固定填满，填充率恒为 100
        fill: 100,
        canvas: { width: SHEET_W, height: SHEET_H },
        tiers: { 2: shots.length },
      },
      notes: [
        `2×3 布局：每张图 ${CELLS_PER_SHEET} 格 640×360，每格约 ${Math.round((video.duration || 0) / Math.max(1, shots.length) * 100) / 100} 秒`,
      ],
    }
  },
}

export default renderGrid23Provider
