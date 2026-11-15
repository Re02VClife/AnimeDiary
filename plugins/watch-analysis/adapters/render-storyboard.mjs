/**
 * adapters/render-storyboard — 宫格拼图渲染：复用 dsh-video-storyboard 的档位 + DP 装箱
 *
 * 职责边界：
 *   - 输入切点（`Cut[]`，来自 cut adapter），输出**带档位的镜头** + 落盘的宫格图文件名；
 *   - 不产生 Buffer 穿进程边界：`runStoryboard` 返回的 `sheets[].png` 是 Buffer，
 *     24 分钟一集能到几十 MB，塞进 IPC 会 base64 膨胀 —— 这里只落盘、只回相对文件名；
 *   - 不跑 ASR：Phase 1 台词由 transcript adapter 负责，这里固定 `transcript: 'off'`。
 *
 * 已冻结的依赖契约（升级 dsh-video-storyboard 后先跑
 * `scripts/probe-storyboard-contract.mjs` 复核）：
 *   runStoryboard({ input, strategy, maxFrames, maxSheets, budget, maxCanvasSide,
 *                   transcript, precomputed, onProgress })
 *     → { sheets: [{ cells: [{ i, sheet, t_start, t_end, t_frame, tier, cuts?, text? }],
 *                    width, height, png: Buffer }],
 *         plan: { strategy, sheets, frames, fill, canvas, tiers, ... },
 *         audio: { mean, peak, series, step, silences: [{from,to}], ... } | null,
 *         degraded?: 'motion' | null }
 *   saveStoryboards(result, outPath, { quality }) → string[]（**实际落盘路径**，多张时自动加 `-N` 后缀）
 */
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

import { runStoryboard, saveStoryboards } from 'dsh-video-storyboard/pipeline'

/**
 * 把一集的 cell 摊平成协议里的 shots。
 *
 * storyboard 的 `cell.i` 从 1 开始（它面向人读的清单），协议要求从 0 开始 —— 减一在**这里**做，
 * 上层不再关心两套编号。
 *
 * @param {object} result runStoryboard 的返回
 * @returns {Array<{ i: number, start: number, end: number, frameAt: number, tier: number,
 *                   text?: string, cuts?: number }>}
 */
function mapShots(result) {
  const shots = []
  for (const sheet of result.sheets ?? []) {
    for (const cell of sheet.cells ?? []) {
      shots.push({
        i: cell.i - 1,
        start: cell.t_start,
        end: cell.t_end,
        frameAt: cell.t_frame,
        tier: cell.tier,
        // 没有台词/没有切点时 storyboard 不带这两个键，这里也不硬塞 undefined
        ...(cell.text ? { text: cell.text } : {}),
        ...(cell.cuts ? { cuts: cell.cuts } : {}),
      })
    }
  }
  // DP 装箱按 bin 顺序出格，正常情况下已经按时间升序；协议要求保证，排序是 O(n log n) 的保险
  return shots.sort((a, b) => a.start - b.start || a.i - b.i)
}

/** 相对出图目录的路径，统一成正斜杠（协议里的 `Sheet.file` 形如 `ep01-2.png`，跨平台可比） */
function relativeName(outDir, absolutePath) {
  return path.relative(outDir, absolutePath).split(path.sep).join('/')
}

/**
 * 静音段统一成 `[from, to]` 元组。
 * dsh-video-storyboard 当前给的是 `{ from, to }` 对象，但协议要元组；
 * 新版万一直接给数组也照样吃下 —— 这个字段会进 IPC，形状必须钉死。
 *
 * @param {{from?:number,to?:number}|[number,number]} entry
 * @returns {[number, number]}
 */
function toTuple(entry) {
  if (Array.isArray(entry)) return [Number(entry[0]), Number(entry[1])]
  return [Number(entry?.from), Number(entry?.to)]
}

/**
 * 音轨证据（EBU R128 瞬时响度序列 + 静音段）。
 * 它是图底部波形条和报告里"响度曲线"的共同数据源，跟画面同等重要，所以单独透传。
 * 没有音轨时返回 undefined（worker 用 `?? undefined` 判空，别给 null）。
 */
function mapAudio(audio) {
  if (!audio) return undefined
  return {
    mean: audio.mean,
    peak: audio.peak,
    // number[]，每 step 秒一个采样（当前是 0.1s = 10Hz）
    series: audio.series,
    step: audio.step,
    silences: (audio.silences ?? []).map(toTuple),
  }
}

export const renderStoryboardProvider = {
  /** 稳定 id —— 会写进报告的 `engine.storyboard` */
  id: 'storyboard',
  label: '宫格拼图（dsh-video-storyboard）',

  async ready() {
    return { ok: true }
  },

  /**
   * @param {{ file: string, duration?: number, fps?: number, width?: number, height?: number }} video
   * @param {Array<{ t: number, score: number }>} cuts 切点（当前版本只用来校验；实际路径走 precomputed）
   * @param {{
   *   strategy?: string, maxFrames?: number, maxSheets?: number, budgetPixels?: number,
   *   transcript?: unknown, outDir: string, prefix: string, signal?: AbortSignal,
   *   onProgress?: (stage: string, done: number, total: number) => void,
   *   precomputed?: object|null,
   * }} opts
   * @returns {Promise<{
   *   shots: object[], sheets: object[], plan: object, notes?: string[],
   *   audio?: { mean: number, peak: number, series: number[], step: number,
   *             silences: Array<[number, number]> },
   * }>}
   */
  async render(video, cuts, opts) {
    if (!video?.file) throw new Error('render-storyboard: video.file 缺失，无法出图')
    if (!opts?.outDir) throw new Error('render-storyboard: opts.outDir 缺失（必须是绝对目录）')
    if (opts.signal?.aborted) throw new DOMException('渲染已取消', 'AbortError')

    const outDir = path.resolve(opts.outDir)
    const prefix = String(opts.prefix || 'sheet')
    // 落盘目录由主进程创建，这里再兜一层：直接调这个 adapter（测试/脚本）时不会因为目录不存在而白跑一次扫描
    await mkdir(outDir, { recursive: true })

    const result = await runStoryboard({
      input: video.file,
      // auto = 拿同一批帧把 compact/standard/full 各排一次，挑"最小格还认得出、张数又最少"的
      strategy: opts.strategy ?? 'auto',
      // 0 = 不封顶（协议语义）：帧数由切点决定，张数是排布的结果而不是输入
      maxFrames: opts.maxFrames ?? 0,
      maxSheets: opts.maxSheets ?? 0,
      budget: opts.budgetPixels ?? 360_000,
      maxCanvasSide: 800,
      // Phase 1 不要台词：ASR 是另一条链路（transcript adapter），这里开它只会白等一轮模型
      transcript: 'off',
      // **关键**：复用 cut-hsv 已经算好的扫描结果，不再解一遍码。
      // 传了 precomputed 后 pipeline 会跳过 scanShots / 切点链路 / 缓存读写，只做排版 + 取帧 + 拼图。
      precomputed: opts.precomputed ?? null,
      // runStoryboard 的进度回调来自扫描阶段；传了 precomputed 就没有扫描，回调自然不触发。
      // 这里把对象形状翻译成端口的 (stage, done, total)，total 用探测到的 fps 估算。
      onProgress: (progress) => {
        const fps = Number(video.fps) > 0 ? Number(video.fps) : 0
        const duration = Number(video.duration) > 0 ? Number(video.duration) : 0
        const total = fps > 0 && duration > 0 ? Math.round(duration * fps) : -1
        opts.onProgress?.('scan', Number(progress?.frames) || 0, total)
      },
    })

    // ---- 落盘：返回的是**实际路径数组**（多张图时 saveStoryboards 会自动加 `-2`、`-3` 后缀）
    // 注意：pass 的是同一个 basename，不要让调用方自己拼下标 —— 后缀规则是它的
    const target = path.join(outDir, `${prefix}.png`)
    const written = await saveStoryboards(result, target, { quality: 4 })

    // ---- 映射成 runtime/protocol.ts 的 WatchWorkerResult 子集
    const shots = mapShots(result)
    const sheets = (result.sheets ?? []).map((sheet, index) => {
      const file = written[index]
      if (!file) throw new Error(`render-storyboard: 第 ${index + 1} 张图没有落盘路径`)
      return {
        file: relativeName(outDir, file),
        width: sheet.width,
        height: sheet.height,
        // 这张图里放了几帧（注意不是 `sheet.cells` 数组本身，协议这里是数量）
        cells: (sheet.cells ?? []).length,
        // storyboard 的 cell.i 从 1 开始 → 协议里从 0 开始
        shots: (sheet.cells ?? []).map((c) => c.i - 1),
      }
    })

    const plan = {
      strategy: result.plan.strategy,
      sheets: result.plan.sheets,
      frames: result.plan.frames,
      // 注意：storyboard 给的是**百分比**（0–100，保留一位小数），不是 0–1 —— 原样透传，
      // 由上层决定怎么展示；协议里没有规定单位。
      fill: result.plan.fill,
      canvas: result.plan.canvas,
      tiers: result.plan.tiers,
    }

    return {
      shots,
      sheets,
      plan,
      // 引擎警告：degraded = 'motion' 表示"连续运镜导致切点数不可信"
      ...(result.degraded
        ? { notes: [`切点数不可信：${result.degraded}（连续运镜/甩镜会被逐帧判成切点）`] }
        : {}),
      audio: mapAudio(result.audio),
    }
  },
}
