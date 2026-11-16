/**
 * server/deps — 拉片插件的依赖自检
 *
 * 设计目标：**缺什么就说什么、怎么补**，绝不静默失败。
 * 这个模式直接照抄仓库里 `character-voice.ts` 的 ffmpeg 探测器：
 * 用户在设置页看到一行红灯 + 一行可复制的安装命令，比看一份空报告强。
 *
 * 为什么不用 `require.resolve('dsh-video-storyboard')`：
 * 本文件会被 esbuild 打成 CJS bundle，字面量 `require.resolve` 会让构建期去
 * 解析这个包 —— 包没装就构建失败。这里只用 fs 探测目录，运行时才真正加载。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export interface DependencyStatus {
  /** 稳定 id，UI 按它渲染图标 */
  id: string
  label: string
  ok: boolean
  /** 缺了会不会导致整条链路不可用 */
  required: boolean
  /** 版本号（能拿到就给） */
  version?: string
  /** 可执行文件 / 目录路径 */
  path?: string
  /** ok=false 时：怎么补。一行，可直接复制 */
  hint?: string
  /** 补充说明（探测细节、为什么不可用） */
  detail?: string
}

/** 跑一个命令拿退出码与首行输出。找不到命令时返回 null（不是抛错）。 */
function run(exe: string, args: string[]): { ok: boolean; out: string } | null {
  try {
    const result = spawnSync(exe, args, {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
      shell: false,
    })
    if (result.error) return null
    const out = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
    return { ok: result.status === 0, out }
  } catch {
    return null
  }
}

/** 找 ffmpeg：环境变量优先（打包版用户可能装在 PATH 外），其次 PATH。 */
function detectFfmpeg(): DependencyStatus {
  const candidates = [
    process.env.ANIMEDIARY_FFMPEG,
    process.env.FFMPEG_PATH,
    'ffmpeg',
    'ffmpeg.exe',
  ].filter((v): v is string => typeof v === 'string' && v.length > 0)

  for (const exe of candidates) {
    const r = run(exe, ['-version'])
    if (r?.ok) {
      const m = r.out.match(/ffmpeg version (\S+)/i)
      return {
        id: 'ffmpeg',
        label: 'FFmpeg',
        ok: true,
        required: true,
        version: m?.[1],
        path: exe,
      }
    }
  }
  return {
    id: 'ffmpeg',
    label: 'FFmpeg',
    ok: false,
    required: true,
    hint: 'winget install Gyan.FFmpeg（装完重启 AnimeDiary）',
    detail: '拉片的所有解码、抽帧、拼图都依赖它',
  }
}

/** 找 Python 3.10+：python / python3 / py -3 依次试。 */
function detectPython(): DependencyStatus {
  const candidates: Array<{ exe: string; args: string[] }> = [
    ...(process.env.ANIMEDIARY_PYTHON ? [{ exe: process.env.ANIMEDIARY_PYTHON, args: [] }] : []),
    { exe: 'python', args: [] },
    { exe: 'python3', args: [] },
    { exe: 'py', args: ['-3'] },
  ]

  for (const { exe, args } of candidates) {
    const r = run(exe, [...args, '--version'])
    if (!r?.ok) continue
    const m = r.out.match(/Python (\d+)\.(\d+)\.(\d+)/)
    if (!m) continue
    const major = Number(m[1])
    const minor = Number(m[2])
    if (major < 3 || (major === 3 && minor < 10)) {
      return {
        id: 'python',
        label: 'Python',
        ok: false,
        required: false,
        version: `${m[1]}.${m[2]}.${m[3]}`,
        path: exe,
        hint: '需要 Python 3.10+（TransNet / Music Evidence Engine 用）',
        detail: '当前版本太旧；缺它只会少「配乐分析」和「TransNet 切镜」两块',
      }
    }
    return {
      id: 'python',
      label: 'Python',
      ok: true,
      required: false,
      version: `${m[1]}.${m[2]}.${m[3]}`,
      path: exe,
    }
  }

  return {
    id: 'python',
    label: 'Python',
    ok: false,
    required: false,
    hint: 'winget install Python.Python.3.12（装完重启 AnimeDiary）',
    detail: '缺只会少「配乐分析」和「TransNet 切镜」，切镜仍可用内置 HSV 差分',
  }
}

/**
 * 探测 node_modules 里的包。
 *
 * 三种根目录都要试：dev 用 cwd；打包后主进程在 app.asar 里（Electron 的 fs
 * 能读 asar）；worker 子进程在 asar.unpacked 里跑，要能读到同一份。
 */
function packageInfo(name: string): { dir: string; version?: string } | null {
  // resourcesPath 是 Electron 注入的（@types/node 里没有），打包后才存在
  const resourcesPath = (process as any).resourcesPath as string | undefined
  const roots = [
    process.cwd(),
    resourcesPath,
    path.join(resourcesPath ?? '', 'app.asar.unpacked'),
  ].filter((v): v is string => typeof v === 'string' && v.length > 0)

  for (const root of roots) {
    const dir = path.join(root, 'node_modules', name)
    const pkgJson = path.join(dir, 'package.json')
    try {
      if (!fs.existsSync(pkgJson)) continue
      const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'))
      return { dir, version: typeof pkg.version === 'string' ? pkg.version : undefined }
    } catch {
      // 读到一半坏了就当没有，下一轮再报
    }
  }
  return null
}

function detectStoryboard(): DependencyStatus {
  const info = packageInfo('dsh-video-storyboard')
  if (info) {
    return {
      id: 'storyboard',
      label: '分镜引擎（dsh-video-storyboard）',
      ok: true,
      required: true,
      version: info.version,
      path: info.dir,
    }
  }
  return {
    id: 'storyboard',
    label: '分镜引擎（dsh-video-storyboard）',
    ok: false,
    required: true,
    hint: '在项目根目录执行 npm install（正式版会随安装包一起发布）',
    detail: '切镜、拼宫格图、ASR 调用都在这个包里',
  }
}

/**
 * 探测 Python 侧的 Music Evidence Engine。
 * 只 import 一下模块（不跑分析），几毫秒就能确认装没装。
 */
function detectMee(python: DependencyStatus): DependencyStatus {
  if (!python.ok || !python.path) {
    return {
      id: 'mee',
      label: '配乐分析（Music Evidence Engine）',
      ok: false,
      required: false,
      hint: '先装 Python 3.10+，再执行 python -m pip install music-evidence-engine',
      detail: '缺只会少「配乐证据」一块，其它分析照常',
    }
  }
  const r = run(python.path, ['-c', 'import music_evidence_engine as m; print(getattr(m, "__version__", "unknown"))'])
  if (r?.ok && r.out) {
    const version = r.out.split(/\r?\n/).pop()?.trim()
    return {
      id: 'mee',
      label: '配乐分析（Music Evidence Engine）',
      ok: true,
      required: false,
      version: version && version !== 'unknown' ? version : undefined,
      path: python.path,
    }
  }
  return {
    id: 'mee',
    label: '配乐分析（Music Evidence Engine）',
    ok: false,
    required: false,
    hint: `${python.path} -m pip install music-evidence-engine`,
    detail: '缺只会少「配乐证据」一块，其它分析照常',
  }
}

/**
 * 本地语音识别（MOSS-Transcribe-Diarize）。
 *
 * 为什么探测的是"专用 conda env"而不是 PATH 里的 python：MOSS 要 torch + transformers
 * + 1.7GB 权重，本机放在 `conda env moss` 里，系统 python 装不了也没必要装。
 *
 * 候选列表与 `adapters/transcript-moss.mjs` 的 `pythonCandidates` / `modelCandidates`
 * **必须保持一致**（那边是运行时用，这边是自检用）。改一处要同步另一处。
 */
function detectMoss(): DependencyStatus {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  const condaPrefix = process.env.CONDA_PREFIX
  const pythonCandidates = [
    process.env.ANIMEDIARY_MOSS_PYTHON,
    condaPrefix && /[\\/]envs[\\/]moss$/i.test(condaPrefix) ? path.join(condaPrefix, 'python.exe') : undefined,
    ...['miniconda3', 'anaconda3', '.conda'].flatMap((root) => (
      home
        ? [path.join(home, root, 'envs', 'moss', 'python.exe'), path.join(home, root, 'envs', 'moss', 'bin', 'python')]
        : []
    )),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)

  let pythonPath: string | undefined
  let packageVersion: string | undefined
  for (const exe of pythonCandidates) {
    if (!fs.existsSync(exe)) continue
    const r = run(exe, ['-c', 'import moss_transcribe_diarize as m; print(getattr(m, "__version__", "unknown"))'])
    if (!r?.ok) continue
    pythonPath = exe
    // `run()` 把 stdout + stderr 合并了，而 torch 会往 stderr 打 NOTE / 进度条，
    // 直接取最后一行会得到一长串警告（实测面板上真的显示成了那样）——
    // 所以只认「unknown 或 数字.数字」开头的那一行。
    const version = r.out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .reverse()
      .find((line) => /^(unknown|\d+\.\d+)/.test(line))
    packageVersion = version && version !== 'unknown' ? version : undefined
    break
  }

  const modelCandidates = [
    process.env.ANIMEDIARY_MOSS_MODEL,
    'D:\\models\\MOSS-Transcribe-Diarize',
    home ? path.join(home, 'models', 'MOSS-Transcribe-Diarize') : undefined,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)
  const modelDir = modelCandidates.find((candidate) => fs.existsSync(candidate))

  if (!pythonPath) {
    return {
      id: 'asr',
      label: '语音识别（MOSS 本地）',
      ok: false,
      required: false,
      hint: '设置 ANIMEDIARY_MOSS_PYTHON 指向装了 moss_transcribe_diarize 的 python（通常在 %USERPROFILE%\\miniconda3\\envs\\moss\\python.exe）',
      detail: '缺它只会少「没有字幕时的台词」；有字幕文件的番照常拿到台词',
    }
  }
  if (!modelDir) {
    return {
      id: 'asr',
      label: '语音识别（MOSS 本地）',
      ok: false,
      required: false,
      version: packageVersion,
      path: pythonPath,
      hint: '设置 ANIMEDIARY_MOSS_MODEL 指向权重目录（约 1.7GB，本机放在 D:\\models\\MOSS-Transcribe-Diarize）',
      detail: 'Python 环境已就绪，只差模型权重',
    }
  }
  return {
    id: 'asr',
    label: '语音识别（MOSS 本地）',
    ok: true,
    required: false,
    version: packageVersion,
    path: pythonPath,
    detail: modelDir,
  }
}

/** 一次性检查全部依赖。每次调用都重新探测 —— 用户装完东西不用重启。 */
export function checkDependencies(): DependencyStatus[] {
  const ffmpeg = detectFfmpeg()
  const python = detectPython()
  return [ffmpeg, python, detectStoryboard(), detectMoss(), detectMee(python)]
}
