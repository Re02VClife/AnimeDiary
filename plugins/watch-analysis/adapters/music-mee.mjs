/**
 * adapters/music-mee — 配乐证据（Music Evidence Engine）
 *
 * 这个 adapter 存在的理由：影评的「音声 / 沉浸」两维以前**没有任何依据** ——
 * grid6 只抽画面帧，报告里 `loudness` 是 null，模型只能写"听不到，无法判断"。
 * 接了 MEE 之后，模型至少拿到一组**可复核的测量**（响度/动态/起音密度/结构边界），
 * 能在这些数上做"声音怎么参与叙事"的判断。
 *
 * ⚠️ 边界（写进注释也写进 prompt）：这些是**测量**，不是鉴赏。
 * 「BPM 123」是测出来的；「这段配乐很燃」不是。所以端口把两者的字段分开，
 * 上层提示词只许引用测量值。
 *
 * 三条实测约束：
 *   1. **CLI 会往 stdout 打人类可读进度**（`[结构] 10 个候选边界…`），JSON 是多行
 *      pretty-print 跟在后面 —— 直接 JSON.parse(stdout) 必炸。`parseMeeJson()` 负责抠。
 *   2. **必须先把视频抽成 wav**。MEE 只吃音频文件；我们用 22050Hz 单声道
 *      （引擎自己的 sample_rate 就是 22050，多给的采样率它也会降）。
 *   3. **CPU 上不快**：3 分钟音频约 5 秒，24 分钟约 40–60 秒（见下）。
 *      所以它是可选步骤（`options.music === 'off'` 可关），失败也只是降级、不影响切镜。
 */
import { execFile, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const runFile = promisify(execFile)

export const MEE_SOURCE = 'music-evidence-engine'
/** CLI 的模块入口：`python -m music_evidence_engine <wav> --json` */
const MEE_MODULE = 'music_evidence_engine'
/** 抽音频用的采样率：和引擎内部一致，别用 44100 白占内存 */
const SAMPLE_RATE = 22050
/** 单次分析最多保留多少个能量段（24 分钟实测 30–60 段，全给会让提示词爆掉） */
const MAX_WINDOWS = 40
/** 段边界最多保留几条 */
const MAX_BOUNDARIES = 12

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 裸命令名交给 PATH；带路径的必须存在 */
function existsOrCommand(candidate) {
  if (typeof candidate !== 'string' || candidate.trim() === '') return false
  if (candidate.includes(path.sep) || /^[a-zA-Z]:/.test(candidate)) return fs.existsSync(candidate)
  return true
}

/**
 * Python 候选。MEE 是纯 CPU 的 pip 包，通常装在系统 python 里，
 * 所以 PATH 优先；同时认 conda 环境（有人会装在专用 env 里）。
 */
export function pythonCandidates(env = process.env) {
  const home = env.USERPROFILE || env.HOME || ''
  const list = []
  if (env.ANIMEDIARY_MEE_PYTHON) list.push(env.ANIMEDIARY_MEE_PYTHON)
  if (env.CONDA_PREFIX) {
    list.push(path.join(env.CONDA_PREFIX, 'python.exe'))
    list.push(path.join(env.CONDA_PREFIX, 'bin', 'python'))
  }
  if (home) {
    for (const root of ['miniconda3', 'anaconda3', '.conda']) {
      list.push(path.join(home, root, 'python.exe'))
      list.push(path.join(home, root, 'bin', 'python'))
    }
  }
  list.push('python', 'python3', 'py')
  return list
}

/**
 * 解析运行环境：哪个 python 装了 MEE、版本多少。
 *
 * 探测一次要 spawn 一个 python（约 0.5–1.5 秒），所以结果会被 `createMusicMeeProvider`
 * 缓存；deps 自检走的是自己的探测（`server/deps.ts`），两边口径一致即可。
 */
export function resolveMeeRuntime(env = process.env, run = runSync) {
  for (const candidate of pythonCandidates(env)) {
    if (!existsOrCommand(candidate)) continue
    const result = run(candidate, [
      '-c',
      `import ${MEE_MODULE} as m; print(getattr(m, "__version__", "unknown"))`,
    ])
    if (!result?.ok) continue
    const version = String(result.out ?? '').split(/\r?\n/).map((line) => line.trim()).reverse()
      .find((line) => /^(unknown|\d+\.\d+)/.test(line))
    return {
      ok: true,
      python: candidate,
      version: version && version !== 'unknown' ? version : undefined,
      detail: `${candidate}${version ? ` · MEE ${version}` : ''}`,
    }
  }
  return {
    ok: false,
    python: null,
    reason: '找不到装了 music-evidence-engine 的 Python',
    detail: 'python -m pip install music-evidence-engine（或安装官方 wheel）',
  }
}

/** 同步跑一个短命令（只用于环境探测） */
function runSync(exe, args) {
  try {
    const result = spawnSync(exe, args, {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
      shell: false,
    })
    if (result.error) return null
    return { ok: result.status === 0, out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() }
  } catch {
    return null
  }
}

/** 抽音频：只保留音轨，单声道 22050Hz（MEE 内部就是这个采样率） */
async function extractAudio(input, output, opts = {}) {
  const args = ['-y', '-loglevel', 'error']
  if (opts.start !== undefined) args.push('-ss', String(opts.start))
  if (opts.duration !== undefined) args.push('-t', String(opts.duration))
  args.push('-i', input, '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), output)
  await runFile('ffmpeg', args, { windowsHide: true, timeout: 600_000, maxBuffer: 8 * 1024 * 1024 })
}

/**
 * 从混排输出里抠出 JSON。
 *
 * CLI 会先打一行人类可读的 `[结构] ...`，再打 pretty-print 的 JSON。
 * 所以：整体 parse 不行时，取第一个 `{` 到最后一个 `}` 之间。
 */
export function parseMeeJson(stdout) {
  const raw = String(stdout ?? '').trim()
  if (!raw) return null
  try {
    const direct = JSON.parse(raw)
    if (direct && typeof direct === 'object') return direct
  } catch {
    // 混了日志，继续抠
  }
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const sliced = JSON.parse(raw.slice(start, end + 1))
    return sliced && typeof sliced === 'object' ? sliced : null
  } catch {
    return null
  }
}

/** 把秒数夹到 [0, duration]；duration 无效时不夹 */
function clampSeconds(value, duration) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  if (!Number.isFinite(duration) || duration <= 0) return Math.max(0, n)
  return Math.max(0, Math.min(duration, n))
}

/**
 * MEE 的 JSON → 端口要求的 `MusicResult`。
 *
 * 映射口径：
 *   - 每个 `timeline.energy` 段 = 一个 window（这是引擎自己按内容切的段，比固定窗更有意义）
 *   - `measurements` 只放**测出来的**：响度、起音率、段内结构边界、tempo
 *   - `inferred` 不放东西：MEE 的乐器/人声标签需要分轨模型，本机没装时是空数组，
 *     把空数组当"没有乐器"传下去会误导模型
 *   - 全局读数（BPM/调性/LUFS/可用性）进 `summary`，`notes` 放引擎自报的限制
 */
export function mapMeeResult(parsed, { offset = 0, duration = 0 } = {}) {
  if (!parsed || typeof parsed !== 'object') return null
  const summary = parsed.summary && typeof parsed.summary === 'object' ? parsed.summary : {}
  const timeline = parsed.timeline && typeof parsed.timeline === 'object' ? parsed.timeline : {}
  const activity = parsed.activity && typeof parsed.activity === 'object' ? parsed.activity : {}
  const confidence = parsed.confidence && typeof parsed.confidence === 'object' ? parsed.confidence : {}
  const scope = parsed.scope && typeof parsed.scope === 'object' ? parsed.scope : {}

  const spanStart = Number(scope.start_sec)
  const spanEnd = Number(scope.end_sec)
  const base = Number.isFinite(spanStart) ? spanStart : 0
  const total = Number.isFinite(spanEnd - spanStart) && spanEnd > spanStart
    ? spanEnd - spanStart
    : Number(duration) > 0 ? Number(duration) : 0

  const loudness = summary.loudness && typeof summary.loudness === 'object' ? summary.loudness : {}
  const keyInfo = summary.key && typeof summary.key === 'object' ? summary.key : {}
  const energyRange = summary.energy_range_dbfs && typeof summary.energy_range_dbfs === 'object'
    ? summary.energy_range_dbfs
    : {}

  const boundaries = Array.isArray(timeline.section_boundaries)
    ? timeline.section_boundaries
      .map((item) => ({
        t: Number(item?.time_sec),
        jump: Number(item?.jump_db),
      }))
      .filter((item) => Number.isFinite(item.t))
      .slice(0, MAX_BOUNDARIES)
    : []

  const activitySegments = Array.isArray(activity.timeline) ? activity.timeline : []
  const energySegments = Array.isArray(timeline.energy) ? timeline.energy : []

  /** 找与这个能量段重叠最多的活动段（两边的切段口径可能略有不同） */
  function overlappingActivity(from, to) {
    let best = null
    let bestOverlap = 0
    for (const segment of activitySegments) {
      const start = Number(segment?.start_sec)
      const end = Number(segment?.end_sec)
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue
      const overlap = Math.min(to, end) - Math.max(from, start)
      if (overlap > bestOverlap) {
        bestOverlap = overlap
        best = segment
      }
    }
    return best
  }

  const windows = []
  for (const segment of energySegments.slice(0, MAX_WINDOWS)) {
    const start = Number(segment?.start_sec)
    const end = Number(segment?.end_sec)
    const mean = Number(segment?.mean_dbfs)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue
    const activitySegment = overlappingActivity(start, end)
    const onsetRate = Number(activitySegment?.onset_rate)
    // 段内的声学变化边界（测量值，不是"这里是副歌"那种推断）
    // 边界通常正好落在段交界（前一段 end == 后一段 start），归给后一段更符合直觉
    const innerBoundaries = boundaries
      .filter((item) => item.t >= start && item.t < end)
      .map((item) => clampSeconds(item.t + offset, offset + total))
    windows.push({
      from: clampSeconds(start + offset, offset + total),
      to: clampSeconds(end + offset, offset + total),
      measurements: {
        ...(Number.isFinite(mean) ? { loudness: Math.round(mean * 10) / 10 } : {}),
        ...(Number.isFinite(onsetRate) ? { onsetRate: Math.round(onsetRate * 100) / 100 } : {}),
        ...(Number.isFinite(Number(summary.bpm)) ? { tempo: Number(summary.bpm) } : {}),
        ...(innerBoundaries.length > 0 ? { boundaries: innerBoundaries } : {}),
      },
    })
  }

  const activitySummary = activity.summary && typeof activity.summary === 'object' ? activity.summary : {}
  const reading = confidence.reading && typeof confidence.reading === 'object' ? confidence.reading : {}
  const caveats = Array.isArray(confidence.caveats) ? confidence.caveats.filter(Boolean) : []

  const notes = []
  // 哪些读数可信：引擎自己会标「可用 / 不可用」，这比我们猜准得多
  const unusable = Object.entries(reading)
    .filter(([, value]) => typeof value === 'string' && /不可用|unavailable/i.test(value))
    .map(([key]) => key)
  if (unusable.length > 0) notes.push(`引擎标记不可用：${unusable.join(' / ')}（这些读数不要当事实引用）`)
  const sources = parsed.sources && typeof parsed.sources === 'object' ? parsed.sources : {}
  if (sources.available !== true) {
    notes.push('未做音源分离：无法判断具体乐器/人声，只能引用响度与节奏测量')
  }
  if (caveats.length > 0) notes.push(...caveats.slice(0, 4))
  if (parsed.measurements?.structure_aware === false) notes.push('未启用结构感知，段落是按固定块切的')

  return {
    windows,
    engine: MEE_SOURCE,
    summary: {
      ...(Number.isFinite(Number(summary.bpm)) ? { bpm: Number(summary.bpm) } : {}),
      ...(summary.tempo_stable === true ? { tempoStable: true } : {}),
      ...(keyInfo.best ? { key: String(keyInfo.best) } : {}),
      ...(Number.isFinite(Number(keyInfo.confidence)) ? { keyConfidence: Number(keyInfo.confidence) } : {}),
      ...(Number.isFinite(Number(loudness.lufs)) ? { lufs: Number(loudness.lufs) } : {}),
      ...(Number.isFinite(Number(loudness.rms_dbfs)) ? { rmsDbfs: Number(loudness.rms_dbfs) } : {}),
      ...(Number.isFinite(Number(loudness.peak_dbfs)) ? { peakDbfs: Number(loudness.peak_dbfs) } : {}),
      ...(Number.isFinite(Number(energyRange.std)) ? { energyStd: Number(energyRange.std) } : {}),
      ...(Number.isFinite(Number(activitySummary.onset_rate_per_sec))
        ? { onsetRate: Number(activitySummary.onset_rate_per_sec) }
        : {}),
      segments: windows.length,
      boundaries: boundaries.map((item) => ({
        t: clampSeconds(item.t + offset, offset + total),
        ...(Number.isFinite(item.jump) ? { jumpDb: item.jump } : {}),
      })),
      sourcesAvailable: sources.available === true,
      caveats: caveats.slice(0, 6),
    },
    notes,
  }
}

/** 杀进程树：python 可能再拉子进程（onnxruntime 有时会），单杀父进程会留孤儿 */
function killTree(child) {
  if (!child || child.killed || typeof child.pid !== 'number') return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } else {
      child.kill('SIGKILL')
    }
  } catch {
    // 已经退出
  }
}

/** 超时：MEE 在 CPU 上约 0.25× 实时（24 分钟 ≈ 40–60 秒），给足余量 */
export function timeoutForDuration(duration) {
  const seconds = Number(duration)
  const base = Number.isFinite(seconds) && seconds > 0 ? seconds * 2 + 180 : 600
  return Math.round(Math.min(30 * 60, Math.max(120, base)) * 1000)
}

/**
 * 跑一次 CLI，返回原始 JSON（已抠好）。不抛错：失败返回 `{ ok:false, error }`。
 */
export function runMee({
  python,
  file,
  timeoutMs,
  signal,
  onLog,
}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(python, ['-m', MEE_MODULE, file, '--json'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ ok: false, error: `启动 Python 失败：${errorMessage(error)}` })
      return
    }

    const MAX_STDOUT = 32 * 1024 * 1024
    let stdout = ''
    let stderrTail = ''
    let settled = false
    let timer = null

    const cleanup = () => {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    }
    const finish = (result) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }
    const onAbort = () => {
      killTree(child)
      finish({ ok: false, error: '已取消' })
    }

    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        killTree(child)
        finish({ ok: false, error: `配乐分析超时（${Math.round(timeoutMs / 1000)} 秒）` })
      }, timeoutMs)
      timer.unref?.()
    }

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < MAX_STDOUT) stdout += chunk
    })

    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-4000)
      for (const line of String(chunk).split(/\r?\n/)) {
        const text = line.trim()
        if (!text) continue
        if (/\[结构\]/.test(text)) onLog?.('配乐分析：检测段落边界')
        else if (/BPM|bpm/i.test(text)) onLog?.('配乐分析：估算节拍')
      }
    })

    child.on('error', (error) => {
      finish({ ok: false, error: `启动 Python 失败：${errorMessage(error)}` })
    })

    child.on('close', (code) => {
      if (settled) return
      const parsed = parseMeeJson(stdout)
      if (parsed) {
        finish({ ok: true, parsed, stdout })
        return
      }
      const reason = stderrTail.split(/\r?\n/).filter(Boolean).slice(-1)[0] || `Python 退出码 ${code}`
      finish({ ok: false, error: retargetError(reason) })
    })
  })
}

/** 把 python 的报错翻译成一句人话（用户不该看到 traceback 尾巴） */
function retargetError(reason) {
  const text = String(reason ?? '')
  if (/No module named|ModuleNotFoundError/i.test(text)) return 'Python 里没有 music-evidence-engine'
  if (/onnxruntime/i.test(text)) return '缺少 onnxruntime（pip install onnxruntime）'
  if (/librosa|soundfile/i.test(text)) return '缺少 librosa / soundfile 依赖'
  return text.split(/\r?\n/).filter(Boolean).slice(-1)[0] || '配乐分析失败'
}

/**
 * 工厂：测试可以注入 `runtime()` / `runCli()`，生产用默认实现。
 * 和 transcript-moss 一样 —— 「环境没装好」与「装好了但分析失败」两条降级路径都要能被测。
 */
export function createMusicMeeProvider(deps = {}) {
  let cached = null
  const resolveRuntime = deps.runtime ?? (() => {
    if (!cached) cached = resolveMeeRuntime()
    return cached
  })
  const runCli = deps.runCli ?? runMee

  return {
    id: MEE_SOURCE,
    label: '配乐证据（Music Evidence Engine）',

    async ready() {
      const runtime = resolveRuntime()
      return runtime.ok
        ? { ok: true, detail: runtime.detail, version: runtime.version }
        : { ok: false, reason: runtime.reason, detail: runtime.detail }
    },

    /**
     * 分析整集音轨。**不抛错**：缺环境 / 跑失败 / 没数据都返回 `windows: []` + notes，
     * 让 pipeline 决定报告里写"没做配乐分析"而不是整集失败。
     *
     * @param {{ file: string, duration?: number }} video
     * @param {{ signal?: AbortSignal, onProgress?: (p:number,t:number)=>void, onLog?: (m:string)=>void, from?: number, to?: number }} [opts]
     */
    async analyze(video, opts = {}) {
      const runtime = resolveRuntime()
      if (!runtime.ok) {
        return { windows: [], engine: MEE_SOURCE, notes: [`未做配乐分析：${runtime.reason}`] }
      }
      if (!video || typeof video.file !== 'string' || !fs.existsSync(video.file)) {
        return { windows: [], engine: MEE_SOURCE, notes: ['找不到视频文件，跳过配乐分析'] }
      }
      if (opts.signal?.aborted) return { windows: [], engine: MEE_SOURCE }

      const from = Number(opts.from)
      const to = Number(opts.to)
      const hasWindow = Number.isFinite(from) && Number.isFinite(to) && to > from
      const duration = Number(video.duration)
      const clipLength = hasWindow ? to - from : duration

      const dir = await mkdtemp(path.join(tmpdir(), 'mee-audio-'))
      const wav = path.join(dir, 'audio.wav')
      try {
        opts.onLog?.('配乐分析：抽取音轨（22050Hz 单声道）')
        try {
          await extractAudio(video.file, wav, hasWindow ? { start: from, duration: clipLength } : {})
        } catch (error) {
          // 抽音轨失败（文件损坏 / 没音轨 / ffmpeg 不在）不该让整集分析失败
          return { windows: [], engine: MEE_SOURCE, notes: [`抽取音轨失败：${errorMessage(error)}`] }
        }
        opts.onLog?.(`配乐分析：开始分析${Number.isFinite(clipLength) && clipLength > 0 ? `（${Math.round(clipLength)} 秒）` : ''}`)

        const result = await runCli({
          python: runtime.python,
          file: wav,
          timeoutMs: timeoutForDuration(clipLength),
          signal: opts.signal,
          onLog: opts.onLog,
        })
        if (!result?.ok) {
          return { windows: [], engine: MEE_SOURCE, notes: [`配乐分析失败：${result?.error || '未知原因'}`] }
        }

        const mapped = mapMeeResult(result.parsed, {
          offset: hasWindow ? from : 0,
          duration: clipLength,
        })
        if (!mapped || mapped.windows.length === 0) {
          return { windows: [], engine: MEE_SOURCE, notes: ['配乐分析没有产出可用段落（可能是静音或无音轨）'] }
        }

        opts.onProgress?.(1, 1)
        const version = runtime.version ? `@${runtime.version}` : ''
        return {
          ...mapped,
          engine: `${MEE_SOURCE}${version}`,
          notes: [
            `Music Evidence Engine${version ? ` ${runtime.version}` : ''}：${mapped.windows.length} 段，${mapped.summary?.boundaries?.length ?? 0} 个段落边界`,
            ...mapped.notes,
          ],
        }
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {})
      }
    },
  }
}

/** 生产用单例（和 cut-hsv / transcript-moss 一样的导出形状） */
export const musicMeeProvider = createMusicMeeProvider()

export default musicMeeProvider
