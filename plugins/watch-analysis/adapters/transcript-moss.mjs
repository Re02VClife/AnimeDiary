/**
 * adapters/transcript-moss — 本地语音识别（MOSS-Transcribe-Diarize）
 *
 * 台词来源优先级里的 **2（兜底）**：内嵌字幕轨 0 → 同目录字幕文件 1 → **ASR 2**。
 * 有字幕就该用字幕（准且快）；这条链路存在的理由只有一个 ——
 * Kazumi 那种下载缓存里没有外挂字幕的番，画面和弹幕都有了，却一句台词都没有。
 *
 * 走 `adapters/moss_bridge.py` 子进程：模型加载几秒、推理 0.4× 实时，一集只跑一次，
 * 不值得为它常驻一个服务（和 ocr_bridge.py 同一个思路：一次 subprocess 换一行 JSON）。
 *
 * 三条实测出来的约束：
 *   1. **直接喂视频文件**。MOSS 的 `load_audio_av()` 用 PyAV 解容器音轨，
 *      所以不需要先 ffmpeg 抽 wav —— 少一步、少一份临时文件、也不用依赖 PATH 里的 ffmpeg。
 *   2. **模型目录要显式传**。本机权重在 `D:\models\...`，不传 `--model` 会去 HuggingFace
 *      拉 1.7GB；而 HuggingFace 在境内经常连不上，用户只会看到"卡住"。
 *   3. **stdout 只能有一行 JSON**。transformers/torch 的警告走 stderr，但保险起见
 *      `parseMossOutput()` 仍然逐行找「最后一个能解析且带 ok 字段的对象」，
 *      而不是盲信 `stdout` 整段就是 JSON。
 *
 * 降级约定（照抄 ports/transcript.ts）：缺 Python / 缺权重 / 转写失败 / 没识别出内容，
 * 一律返回**空 segments + notes**，不抛错 —— pipeline 会继续，报告里如实写"没有台词"。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const MOSS_SOURCE = 'asr-moss'

/** bridge 脚本和本文件同目录；打包后一起被 asarUnpack 出去 */
const BRIDGE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'moss_bridge.py')

/** 没有本地权重时的兜底：让 transformers 自己去 HuggingFace 拉（境内大概率失败，但比直接报错更有得救） */
const HF_MODEL_ID = 'OpenMOSS-Team/MOSS-Transcribe-Diarize'

/** 转写超时：按「实时率 0.4 + 模型加载」估，再给 5 分钟余量；上下限夹住，防止异常值 */
function timeoutForDuration(duration) {
  const seconds = Number(duration)
  const base = Number.isFinite(seconds) && seconds > 0 ? seconds * 1.5 + 300 : 900
  return Math.round(Math.min(45 * 60, Math.max(10 * 60, base)) * 1000)
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 文件存在才当候选；裸命令名（`python`）交给 PATH 解析 */
function existsOrCommand(candidate) {
  if (typeof candidate !== 'string' || candidate.trim() === '') return false
  if (candidate.includes(path.sep) || /^[a-zA-Z]:/.test(candidate)) return fs.existsSync(candidate)
  return true
}

/**
 * 找 Python 解释器。顺序：环境变量 → 常见的 conda moss env → PATH。
 *
 * 为什么不只认 `python`：本机跑 MOSS 的是 conda env `moss`（Python 3.12 + torch cu128），
 * 系统 python 里没装 `moss_transcribe_diarize`，直接用 PATH 那个必然 import 失败。
 */
export function pythonCandidates(env = process.env) {
  const home = env.USERPROFILE || env.HOME || ''
  const list = []
  if (env.ANIMEDIARY_MOSS_PYTHON) list.push(env.ANIMEDIARY_MOSS_PYTHON)
  // conda activate 过的 shell 会带 CONDA_PREFIX，直接用它最准
  if (env.CONDA_PREFIX && /[\\/]envs[\\/]moss$/i.test(env.CONDA_PREFIX)) {
    list.push(path.join(env.CONDA_PREFIX, 'python.exe'))
    list.push(path.join(env.CONDA_PREFIX, 'bin', 'python'))
  }
  if (home) {
    for (const root of ['miniconda3', 'anaconda3', '.conda']) {
      list.push(path.join(home, root, 'envs', 'moss', 'python.exe'))
      list.push(path.join(home, root, 'envs', 'moss', 'bin', 'python'))
    }
  }
  list.push('python', 'python3')
  return list
}

/** 找模型目录。本机权重优先，找不到再退回 HuggingFace id。 */
export function modelCandidates(env = process.env) {
  const home = env.USERPROFILE || env.HOME || ''
  const list = []
  if (env.ANIMEDIARY_MOSS_MODEL) list.push(env.ANIMEDIARY_MOSS_MODEL)
  list.push('D:\\models\\MOSS-Transcribe-Diarize')
  if (home) list.push(path.join(home, 'models', 'MOSS-Transcribe-Diarize'))
  list.push(HF_MODEL_ID)
  return list
}

/** 是目录还是 HF id：决定"存在性"该怎么校验 */
function isLocalPath(candidate) {
  return path.isAbsolute(candidate) || /^[a-zA-Z]:[\\/]/.test(candidate) || candidate.startsWith('.')
}

/**
 * 解析一次运行环境。**纯函数**（只读 fs / env），测试可以直接调。
 *
 * 返回 `ok:false` 时 `reason` 是可读的一句话，`detail` 是补装线索 ——
 * deps.ts 和 UI 都靠这两句告诉用户"差什么"。
 */
export function resolveMossRuntime(env = process.env) {
  const bridge = BRIDGE_FILE
  const bridgeExists = fs.existsSync(bridge)

  const python = pythonCandidates(env).find(existsOrCommand) ?? null
  const model = modelCandidates(env).find((candidate) => (isLocalPath(candidate) ? fs.existsSync(candidate) : true)) ?? null

  if (!bridgeExists) {
    return {
      ok: false,
      bridge,
      python,
      model,
      reason: '缺少适配器脚本 moss_bridge.py（安装包不完整）',
      detail: bridge,
    }
  }
  if (!python) {
    return {
      ok: false,
      bridge,
      python,
      model,
      reason: '找不到 MOSS 的 Python 环境',
      detail: '设置 ANIMEDIARY_MOSS_PYTHON 指向装了 moss_transcribe_diarize 的解释器',
    }
  }
  if (!model) {
    return {
      ok: false,
      bridge,
      python,
      model,
      reason: '找不到 MOSS 模型权重',
      detail: '用 ANIMEDIARY_MOSS_MODEL 指向模型目录，或配好能访问 HuggingFace 的网络',
    }
  }
  return {
    ok: true,
    bridge,
    python,
    model,
    detail: `${python} · ${isLocalPath(model) ? model : 'HuggingFace（首次会下载）'}`,
  }
}

/**
 * 把 bridge 的 stdout 解析成结果对象。
 *
 * 逐行**从后往前**找：turnstile 的警告、torch 的 NOTE 偶尔会漏到 stdout，
 * 只有最后那条 `{"ok":...}` 才是结果。找不到返回 null（调用方当失败处理）。
 */
export function parseMossOutput(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim()
    if (!line.startsWith('{') || !line.endsWith('}')) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object' && 'ok' in parsed) return parsed
    } catch {
      // 不是 JSON 就继续往前找
    }
  }
  return null
}

/**
 * bridge 的 segments → 端口要求的 Segment[]。
 *
 * 丢掉的东西：时间不成区间（end <= start）、空文本。这两类在真实输出里都出现过
 * （模型会把一段话拆出 0.0–0.0 的空壳），塞进报告只会让 UI 画出一堆零长度行。
 */
export function mapMossSegments(rawSegments) {
  if (!Array.isArray(rawSegments)) return []
  const segments = []
  for (const item of rawSegments) {
    const start = Number(item?.start)
    const end = Number(item?.end)
    const text = String(item?.text ?? '').trim()
    if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue
    const speaker = typeof item?.speaker === 'string' && item.speaker.trim() ? item.speaker.trim() : undefined
    segments.push({
      start,
      end,
      text,
      source: MOSS_SOURCE,
      ...(speaker ? { speaker } : {}),
    })
  }
  // 报告的台词按时间排序（模型偶尔会把短句排到后面）
  return segments.sort((a, b) => a.start - b.start)
}

/** 统计不重复的说话人编号 */
export function countSpeakers(segments) {
  const seen = new Set()
  for (const segment of segments) {
    if (segment?.speaker) seen.add(segment.speaker)
  }
  return seen.size
}

/** 杀进程树：Windows 上 python 会再拉子进程，单杀父进程会把它们留成孤儿 */
function killTree(child) {
  if (!child || child.killed || typeof child.pid !== 'number') return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } else {
      child.kill('SIGKILL')
    }
  } catch {
    // 进程可能已经退出，没什么可做的
  }
}

/**
 * 真正跑一次 bridge。
 *
 * 用 Promise 包着（而不是 child_process.execFile）：需要逐行读 stderr 当进度提示，
 * 而且超时要能主动杀树。`settled` 保证 resolve 只发生一次（退出事件和超时会撞车）。
 */
export function runMossBridge({
  python,
  bridge,
  model,
  file,
  timeoutMs,
  signal,
  onLog,
}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(python, [bridge, file, '--model', model], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ ok: false, error: `启动 Python 失败：${errorMessage(error)}` })
      return
    }

    const MAX_STDOUT = 16 * 1024 * 1024
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
        finish({ ok: false, error: `转写超时（${Math.round(timeoutMs / 1000)} 秒）` })
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
      // 逐行转成进度文案：模型加载 / 推理是这条链路里唯一能给的阶段信息
      for (const line of String(chunk).split(/\r?\n/)) {
        const text = line.trim()
        if (!text) continue
        if (/\[moss\]\s*模型加载/.test(text)) onLog?.('本地语音识别：模型已加载，开始推理')
        else if (/\[moss\]\s*device=/.test(text)) onLog?.('本地语音识别：加载模型（首次约 10–30 秒）')
        else if (/\[moss\]\s*推理/.test(text)) onLog?.('本地语音识别：推理完成，整理台词')
      }
    })

    child.on('error', (error) => {
      finish({ ok: false, error: `启动 Python 失败：${errorMessage(error)}` })
    })

    child.on('close', (code) => {
      if (settled) return
      const parsed = parseMossOutput(stdout)
      if (parsed?.ok === true) {
        finish({ ok: true, segments: parsed.segments ?? [], raw: parsed.raw, elapsed: parsed.elapsed })
        return
      }
      const reason = parsed?.error
        || stderrTail.split(/\r?\n/).filter(Boolean).slice(-1)[0]
        || `Python 退出码 ${code}`
      finish({ ok: false, error: reason })
    })
  })
}

/**
 * 工厂：测试可以注入 `runtime()` / `runBridge()`，生产用默认实现。
 * 这也让「环境没装好」和「装好了但转写失败」两条降级路径都能被单测覆盖。
 */
export function createTranscriptMossProvider(deps = {}) {
  const resolveRuntime = deps.runtime ?? (() => resolveMossRuntime())
  const runBridge = deps.runBridge ?? runMossBridge

  return {
    id: MOSS_SOURCE,
    label: 'MOSS 本地语音识别（含说话人分离）',
    priority: 2,

    async ready() {
      const runtime = resolveRuntime()
      return runtime.ok
        ? { ok: true, detail: runtime.detail }
        : { ok: false, reason: runtime.reason, detail: runtime.detail }
    },

    /**
     * 转写整集。**不抛错**：缺环境 / 跑失败 / 没识别出内容都返回空 segments + notes，
     * 让 pipeline 决定是"没台词"还是"这条通道不可用"。
     *
     * @param {{ file: string, duration?: number }} video
     * @param {{ signal?: AbortSignal, onProgress?: (processed: number, total: number) => void, onLog?: (message: string) => void }} [opts]
     */
    async transcribe(video, opts = {}) {
      const runtime = resolveRuntime()
      if (!runtime.ok) {
        return { segments: [], source: MOSS_SOURCE, notes: [`未做语音识别：${runtime.reason}`] }
      }
      if (!video || typeof video.file !== 'string' || !fs.existsSync(video.file)) {
        return { segments: [], source: MOSS_SOURCE, notes: ['找不到视频文件，跳过语音识别'] }
      }
      if (opts.signal?.aborted) return { segments: [], source: MOSS_SOURCE }

      const onLog = typeof opts.onLog === 'function' ? opts.onLog : undefined
      // 「加载模型」那句由 bridge 的 stderr（`[moss] device=`）触发，这里不重复喊一遍
      opts.onProgress?.(0, 3)

      const result = await runBridge({
        python: runtime.python,
        bridge: runtime.bridge,
        model: runtime.model,
        file: video.file,
        timeoutMs: timeoutForDuration(video.duration),
        signal: opts.signal,
        onLog,
      })

      if (!result?.ok) {
        return { segments: [], source: MOSS_SOURCE, notes: [`MOSS 转写失败：${result?.error || '未知原因'}`] }
      }

      const segments = mapMossSegments(result.segments)
      if (segments.length === 0) {
        return { segments: [], source: MOSS_SOURCE, notes: ['MOSS 没有识别出任何台词（这一集可能几乎没有对白）'] }
      }

      opts.onProgress?.(3, 3)
      const notes = ['MOSS 本地转写（含说话人分离），同音字可能有错别字']
      if (Number.isFinite(result.elapsed)) notes.push(`转写耗时 ${result.elapsed} 秒`)

      return {
        segments,
        source: MOSS_SOURCE,
        notes,
        speakers: countSpeakers(segments),
      }
    },
  }
}

/** 生产用单例（和 cut-hsv / transcript-subtitle 一样的导出形状） */
export const transcriptMossProvider = createTranscriptMossProvider()
