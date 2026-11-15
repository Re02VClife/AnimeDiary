/**
 * adapters/transcript-subtitle — 同目录字幕文件 provider
 *
 * 来源优先级里排第 1（内嵌字幕轨 0 → **同目录字幕文件 1** → ASR 2）：
 * 比 ASR 准得多，又不花钱，所以只要能确定用哪个文件就优先用它。
 *
 * 匹配策略（对应 ports/transcript.ts 的约定）：
 *   ① 与视频同 basename：`ep01.mp4` → `ep01.ass`（大小写不敏感）
 *   ② 搜索目录里只有**一个**字幕文件时直接用它（名字对不上也不算猜）
 *   ③ 仍有多个候选时，只保留文件名里包含视频 basename 的；还定不下来就**返回空**，
 *      让 pipeline 换下一个 provider（ASR）—— 宁可不用，也不要把别人的字幕当成本集的
 *
 * 「返回空 segments 表示这个 provider 对这个文件无能为力，不算错误」：
 *   - 找不到文件 → 空 + 无 notes（要求的确切形状）
 *   - 读失败 / 编码失败 / 多个候选 → 空 + notes 说明原因，**不抛错**
 *
 * 编码：优先 UTF-8（严格解码，失败就说明不是 UTF-8）；带 BOM 的 UTF-16 直接按 BOM 走；
 * 其余情况在 UTF-8 / GB18030 / UTF-16LE / UTF-16BE 里挑「替换符 + NUL 最少」的那个
 * —— 中文外挂字幕有相当一部分是 GBK/GB18030 或 UTF-16，不处理就会满屏乱码。
 */
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseSubtitle } from './subtitle-parse.mjs'

const SOURCE = 'subtitle-file'
const SUPPORTED_EXTENSIONS = new Set(['.ass', '.ssa', '.srt', '.vtt'])

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 空结果是正常返回值，不是异常：pipeline 会换下一个 provider */
function emptyResult(notes) {
  return notes && notes.length > 0
    ? { segments: [], source: SOURCE, notes }
    : { segments: [], source: SOURCE }
}

/** 匹配用名字：统一小写 + NFC，避免大小写 / macOS 的 NFD 文件名对不上 */
function normalizeName(name) {
  return String(name).normalize('NFC').toLowerCase()
}

/** `ep01.ass` → `ep01`；没有扩展名就原样返回 */
function stripExtension(fileName) {
  const extension = path.extname(fileName)
  return extension ? fileName.slice(0, -extension.length) : fileName
}

/**
 * 要搜索的目录：视频所在目录 + opts.searchDirs。
 * 去重时 Windows 下按小写比较（同一目录两种写法不该算两个候选目录）。
 */
function collectSearchDirs(videoFile, searchDirs) {
  const directories = []
  const seen = new Set()
  const push = (directory) => {
    if (typeof directory !== 'string' || directory.trim() === '') return
    const resolved = path.resolve(directory)
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
    if (seen.has(key)) return
    seen.add(key)
    directories.push(resolved)
  }

  push(path.dirname(path.resolve(videoFile)))
  if (Array.isArray(searchDirs)) {
    for (const directory of searchDirs) push(directory)
  }
  return directories
}

/** 列出目录里的字幕文件（只认普通文件/符号链接，扩展名大小写不敏感） */
async function listSubtitleFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue
    const extension = path.extname(entry.name).toLowerCase()
    if (!SUPPORTED_EXTENSIONS.has(extension)) continue
    files.push({
      dir: directory,
      name: entry.name,
      fullPath: path.join(directory, entry.name),
      ext: extension,
      base: normalizeName(stripExtension(entry.name)),
    })
  }
  // 固定顺序，保证「多个候选」的 notes 在不同机器上可复现
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return files
}

/**
 * 从候选里挑一个。
 * 返回候选对象；定不下来返回 `{ ambiguous: [...] }`（调用方转成空结果 + notes）。
 */
function chooseCandidate(candidates, videoBase) {
  // ① 与视频同 basename
  const exact = candidates.filter((candidate) => candidate.base === videoBase)
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) return { ambiguous: exact }

  // ② 所在目录里唯一的字幕文件
  const countByDir = new Map()
  for (const candidate of candidates) {
    countByDir.set(candidate.dir, (countByDir.get(candidate.dir) ?? 0) + 1)
  }
  const soleInDir = candidates.filter((candidate) => countByDir.get(candidate.dir) === 1)
  if (soleInDir.length === 1) return soleInDir[0]

  // ③ 候选名字里包含视频 basename
  const containsVideoBase = (candidate) => videoBase.length > 0 && candidate.base.includes(videoBase)
  const pool = soleInDir.length > 1 ? soleInDir : candidates
  const narrowed = pool.filter(containsVideoBase)
  if (narrowed.length === 1) return narrowed[0]

  return { ambiguous: narrowed.length > 0 ? narrowed : pool }
}

// ─────────────────────────────────────────────────────────────
// 解码：中文外挂字幕的编码比想象中杂
// ─────────────────────────────────────────────────────────────

const REPLACEMENT_RE = /\uFFFD/g

function countOccurrences(text, pattern) {
  const matched = text.match(pattern)
  return matched ? matched.length : 0
}

function countNul(text) {
  let count = 0
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 0) count += 1
  }
  return count
}

function decodeWith(encoding, bytes) {
  try {
    return new TextDecoder(encoding).decode(bytes)
  } catch {
    return null
  }
}

function stripBom(text) {
  return text.replace(/^\uFEFF/, '')
}

/**
 * Buffer → { text, encoding }。
 *
 * 1. BOM 最可靠：`FE FF` = UTF-16BE，`FF FE` = UTF-16LE，`EF BB BF` = UTF-8；
 * 2. 没有 BOM 先用**严格** UTF-8 解：失败就说明肯定不是 UTF-8（GBK 的中文几乎必然失败），
 *    成功但 NUL 占比高说明其实是 UTF-16 被当单字节读了（ASCII 部分恰好合法）；
 * 3. 剩余情况在候选编码里按「U+FFFD 少、NUL 少」打分，取最优。
 *
 * 返回的 encoding 会进 notes：`utf-8` 以外的要让人知道「这份是转码来的」。
 */
function decodeSubtitleBuffer(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)

  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: stripBom(decodeWith('utf-16be', bytes) ?? ''), encoding: 'utf-16be' }
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: stripBom(decodeWith('utf-16le', bytes) ?? ''), encoding: 'utf-16le' }
  }

  let strictUtf8 = null
  try {
    strictUtf8 = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    strictUtf8 = null
  }
  if (strictUtf8 !== null && countNul(strictUtf8) / Math.max(1, strictUtf8.length) < 0.02) {
    return { text: stripBom(strictUtf8), encoding: 'utf-8' }
  }

  // 候选打分：U+FFFD 一个抵 16 个 NUL —— 乱码字符比「UTF-16 被拆开读出的 NUL」更致命
  const candidates = ['utf-8', 'gb18030', 'utf-16le', 'utf-16be']
  let best = null
  for (const encoding of candidates) {
    const text = decodeWith(encoding, bytes)
    if (text === null) continue
    const score = countOccurrences(text, REPLACEMENT_RE) * 16 + countNul(text)
    if (best === null || score < best.score) best = { text: stripBom(text), encoding, score }
  }
  if (best === null) {
    return { text: stripBom(new TextDecoder('utf-8').decode(bytes)), encoding: 'utf-8' }
  }
  return { text: best.text, encoding: best.encoding }
}

// ─────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────

export const transcriptSubtitleProvider = {
  id: SOURCE,
  label: '同目录字幕文件',
  priority: 1,

  async ready() {
    // 不需要外部依赖：有 fs 就能读字幕文件
    return { ok: true }
  },

  /**
   * @param {{ file: string }} video 只用到 file；其余字段（duration/fps…）由上层填
   * @param {{ signal?: AbortSignal, searchDirs?: string[] }} [opts]
   * @returns {Promise<{ segments: import('../core/types').Segment[], source: string, notes?: string[] }>}
   */
  async transcribe(video, opts = {}) {
    if (opts && opts.signal && opts.signal.aborted) return emptyResult()
    if (!video || typeof video.file !== 'string' || video.file.length === 0) {
      return emptyResult(['没有可用的视频文件路径，跳过同目录字幕'])
    }

    const directories = collectSearchDirs(video.file, opts && opts.searchDirs)
    const notes = []
    const candidates = []

    for (const directory of directories) {
      try {
        candidates.push(...(await listSubtitleFiles(directory)))
      } catch (error) {
        notes.push(`无法读取目录 ${directory}：${errorMessage(error)}`)
      }
    }

    if (candidates.length === 0) return emptyResult(notes)

    const videoBase = normalizeName(stripExtension(path.basename(video.file)))
    const picked = chooseCandidate(candidates, videoBase)
    if (picked.ambiguous) {
      const names = picked.ambiguous.map((candidate) => candidate.name).join('、')
      return emptyResult([...notes, `找到多个候选字幕，无法确定用哪个：${names}`])
    }

    let buffer
    try {
      buffer = await readFile(picked.fullPath)
    } catch (error) {
      return emptyResult([...notes, `读取字幕文件 ${picked.name} 失败：${errorMessage(error)}`])
    }

    const decoded = decodeSubtitleBuffer(buffer)
    const fileNotes = [picked.name]
    if (decoded.encoding !== 'utf-8') {
      fileNotes.push(`字幕文件按 ${decoded.encoding} 解码`)
    }

    let segments
    try {
      segments = parseSubtitle(decoded.text, picked.ext)
    } catch (error) {
      return emptyResult([...notes, ...fileNotes, `解析字幕文件失败：${errorMessage(error)}`])
    }

    if (segments.length === 0) {
      fileNotes.push('字幕文件里没有可用的台词条目')
    }
    return { segments, source: SOURCE, notes: [...notes, ...fileNotes] }
  },
}
