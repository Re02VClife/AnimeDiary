#!/usr/bin/env node
/**
 * runtime/worker — 拉片分析子进程入口
 *
 * 为什么是独立进程（三条都是硬理由，不是洁癖）：
 *   1. `dsh-video-storyboard` 是纯 ESM，主进程的 api-routes.cjs 是 CJS bundle ——
 *      同进程 import 会在构建期/运行期两头炸；
 *   2. 解一集 24 分钟视频会把 CPU 吃满，放主进程会卡住整个界面；
 *   3. 取消任务 = 杀进程树，比在单线程里到处插检查点干净。
 *
 * 通信：
 *   - 入参：命令行第一个参数 = request JSON 文件路径
 *   - 出参：**stdout 一行一个 JSON 事件**（见 runtime/protocol.ts 的 WatchWorkerEvent）
 *   - 日志：全部走 stderr —— stdout 是协议通道，混进一行日志就会让主进程解析崩掉
 *
 * 退出码：0 成功；1 异常（错误已通过 error 事件发过）；2 参数错误。
 */
import { readFile } from 'node:fs/promises'
import { mkdir, readdir, unlink } from 'node:fs/promises'
import path from 'node:path'

/**
 * 清掉同一集上一次分析留下的图。
 *
 * 为什么必须清：换排版策略时后缀和张数都会变（storyboard 出 798×494 的 PNG、
 * 可能 49 张；grid6 出 1280×1080 的 JPG、18 张）。不清的话旧文件一直躺在
 * `sheets/epN/` 里越积越多，而且前端按旧报告的文件名会 404。
 * 只删本集前缀的图片，不碰 evidence.json 之类别的产物（那是 saveStoryboards 写的）。
 */
async function cleanPreviousSheets(outDir, prefix) {
  try {
    const entries = await readdir(outDir)
    const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+\\.(png|jpe?g)$`, 'i')
    for (const name of entries) {
      if (!pattern.test(name)) continue
      await unlink(path.join(outDir, name)).catch(() => {})
    }
  } catch {
    // 目录不存在 / 权限问题都不该让分析失败 —— 大不了留着旧图
  }
}

/** stdout 单行 JSON —— 唯一允许往 stdout 写的地方 */
function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

/** 日志一律 stderr，前缀标清楚是 worker 里哪一步 */
function log(message) {
  process.stderr.write(`[watch-worker] ${message}\n`)
}

/** 把异常转成可序列化的形状，别把 Error 对象直接 JSON.stringify（会变成 {}） */
function describeError(error) {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack }
  }
  return { message: String(error) }
}

async function main() {
  const requestPath = process.argv[2]
  if (!requestPath) {
    log('缺少 request 文件路径参数')
    process.exit(2)
  }

  let request
  try {
    request = JSON.parse(await readFile(requestPath, 'utf8'))
  } catch (error) {
    log(`读不到 request：${error instanceof Error ? error.message : error}`)
    process.exit(2)
  }

  const { input, options = {} } = request
  if (!input) {
    log('request 缺少 input')
    process.exit(2)
  }

  emit({ type: 'ready', pid: process.pid })

  const startedAt = Date.now()
  const timing = {}

  try {
    // 适配器按需加载：切镜引擎缺失时还能降级，不该在模块加载期就整片崩掉
    const { cutHsvProvider } = await import('../adapters/cut-hsv.mjs')

    /*
     * 排版策略：
     *   grid6（默认）— 2×3 六格，每张 1280×1080 / 每格 640×360。
     *     "写死格数"是用户要的：格子够大，staff 表和表情都能读。
     *   storyboard  — 按切点密度分档排版（798×494 那种），张数更少但格子小。
     *     显式传 compact/standard/skim/full 或 'storyboard' 时才用。
     */
    const renderPolicy = options.strategy && !['grid6', 'auto'].includes(options.strategy)
      ? 'storyboard'
      : 'grid6'
    const renderer = renderPolicy === 'storyboard'
      ? (await import('../adapters/render-storyboard.mjs')).renderStoryboardProvider
      : (await import('../adapters/render-grid23.mjs')).renderGrid23Provider
    log(`render policy: ${renderPolicy}${renderPolicy === 'grid6' ? '（2×3 / 1280×1080）' : ''}`)

    await mkdir(options.outDir, { recursive: true })

    // ── 1. 探测 ──
    emit({ type: 'progress', phase: 'probe', percent: 2, message: '探测视频信息' })
    const probeStarted = Date.now()
    const { probeVideo } = await import('dsh-video-storyboard/probe')
    const info = await probeVideo(input)
    timing.probe = (Date.now() - probeStarted) / 1000
    log(`probe: ${info.width}x${info.height} ${info.fps}fps ${info.duration}s audio=${info.hasAudio} sub=${info.hasSubtitle}`)

    const video = {
      file: input,
      duration: info.duration,
      fps: info.fps,
      width: info.width,
      height: info.height,
    }

    // ── 2. 切点 ──
    emit({ type: 'progress', phase: 'scan', percent: 8, message: '检测镜头切换' })
    const scanStarted = Date.now()
    const cutResult = await cutHsvProvider.detect(video, {
      from: options.from,
      to: options.to,
      onProgress: (done, total) => {
        const ratio = total > 0 ? Math.min(1, done / total) : 0
        emit({
          type: 'progress',
          phase: 'scan',
          percent: 8 + Math.round(ratio * 32),
          message: `扫描切点 ${total > 0 ? `${done}/${total}` : done}`,
        })
      },
    })
    timing.scan = (Date.now() - scanStarted) / 1000
    emit({ type: 'progress', phase: 'scan', percent: 42, message: `找到 ${cutResult.cuts.length} 个切点` })

    // ── 3. 排版 + 拼图 ──
    emit({ type: 'progress', phase: 'render', percent: 45, message: '生成分镜宫格图' })
    const renderStarted = Date.now()

    /*
     * 默认密度：每 10 秒一帧。
     *
     * 为什么不按"一个镜头一帧"：实测一集 23.7 分钟的动画切出 597 个镜头，
     * 塞进 8 张 798×502 的宫格图后每格只有 66×56 px —— 模型只能看出
     * "这是文字块/这是人脸"，读不出 staff 表上的名字，也看不清表情。
     * 按 10 秒一帧约 144 帧 → 每张 11 格、每格约 265×180 px（面积大 13 倍），
     * 实测 staff 表和脸部表情都能辨认，token 只多用 2.25 倍（1864 → 4194）。
     *
     * 用户显式传 maxFrames 时以用户为准（前端「密度」选项会传）。
     */
    const autoMaxFrames = Math.max(60, Math.round((info.duration || 0) / 10))
    const effectiveMaxFrames = options.maxFrames && options.maxFrames > 0
      ? options.maxFrames
      : autoMaxFrames
    log(`maxFrames: ${effectiveMaxFrames}${options.maxFrames ? '（指定）' : `（自动：${Math.round(info.duration)}s / 10）`}`)

    // 换策略后旧图会残留（后缀/张数都不同），渲染前先清本集旧文件
    await cleanPreviousSheets(options.outDir, options.prefix)

    const rendered = await renderer.render(video, cutResult.cuts, {
      strategy: options.strategy,
      maxFrames: effectiveMaxFrames,
      maxSheets: options.maxSheets,
      budgetPixels: options.budgetPixels,
      outDir: options.outDir,
      prefix: options.prefix,
      // storyboard 才吃 precomputed；grid6 是按时间抽帧，不依赖扫描结果
      precomputed: renderPolicy === 'storyboard' ? cutResult.raw : null,
      onProgress: (stage, done, total) => {
        const ratio = total > 0 ? Math.min(1, done / total) : 0
        emit({
          type: 'progress',
          phase: 'render',
          percent: 45 + Math.round(ratio * 50),
          message: `${stage} ${total > 0 ? `${done}/${total}` : done}`,
        })
      },
    })
    timing.render = (Date.now() - renderStarted) / 1000
    emit({
      type: 'progress',
      phase: 'render',
      percent: 96,
      message: `${rendered.shots.length} 个镜头 → ${rendered.sheets.length} 张图`,
    })

    // ── 3.5 弹幕（Kazumi 下载缓存自带，不依赖 ASR/字幕）──
    // 放在字幕之前：字幕要 ASR/外挂文件才有，而弹幕几乎每部 Kazumi 番都有，
    // 是零成本能拿到的"观众视角"证据。
    let danmaku
    const danmakuStarted = Date.now()
    try {
      const { readDanmaku } = await import('../adapters/danmaku-kazumi.mjs')
      const found = await readDanmaku(input, { duration: info.duration })
      if (found && found.buckets.length > 0) {
        danmaku = found
        log(`弹幕: ${found.rawTotal} 条 → ${found.total} 条有效 / ${found.buckets.length} 个时间桶`)
      } else {
        log('没有可用弹幕（只有 Kazumi 缓存目录下才有 danmaku.json）')
      }
    } catch (error) {
      // 弹幕失败不能拖垮分析
      log(`弹幕读取失败（继续）：${error instanceof Error ? error.message : error}`)
    }
    timing.danmaku = (Date.now() - danmakuStarted) / 1000

    // ── 4. 字幕（可选）──
    let transcript
    if (options.transcript !== 'off') {
      emit({ type: 'progress', phase: 'transcript', percent: 97, message: '查找字幕' })
      const transcriptStarted = Date.now()
      try {
        const { transcriptSubtitleProvider } = await import('../adapters/transcript-subtitle.mjs')
        const result = await transcriptSubtitleProvider.transcribe(video, {})
        if (result.segments.length > 0) {
          transcript = {
            source: result.source,
            segments: result.segments,
            chars: result.segments.reduce((n, s) => n + s.text.length, 0),
            notes: result.notes,
          }
        } else {
          log('没有找到可用字幕文件（内嵌字幕轨与 ASR 由后续版本补）')
        }
      } catch (error) {
        // 字幕失败不能拖垮整个分析：画面才是主体
        log(`字幕解析失败（继续）：${error instanceof Error ? error.message : error}`)
      }
      timing.transcript = (Date.now() - transcriptStarted) / 1000
    }

    // ── 5. 音轨证据 ──
    // storyboard 的返回里带 EBU R128 响度序列，直接透传；没有音轨时为 null
    const audio = rendered.audio ?? undefined

    const payload = {
      video: {
        duration: info.duration,
        fps: info.fps,
        width: info.width,
        height: info.height,
        hasAudio: Boolean(info.hasAudio),
        hasSubtitle: Boolean(info.hasSubtitle),
      },
      cuts: cutResult.cuts.map((c) => ({ t: c.t, score: c.score, kind: c.type })),
      shots: rendered.shots,
      sheets: rendered.sheets,
      ...(danmaku ? { danmaku } : {}),
      ...(transcript ? { transcript } : {}),
      ...(audio ? { audio } : {}),
      timing: { ...timing, total: (Date.now() - startedAt) / 1000 },
      ...(rendered.notes?.length ? { warnings: rendered.notes } : {}),
      plan: rendered.plan,
    }

    emit({ type: 'result', payload })
    log(`done: ${rendered.shots.length} shots, ${rendered.sheets.length} sheets, ${(
      (Date.now() - startedAt) / 1000
    ).toFixed(2)}s`)
    process.exit(0)
  } catch (error) {
    const described = describeError(error)
    log(`失败：${described.message}`)
    emit({ type: 'error', ...described })
    process.exit(1)
  }
}

main()
