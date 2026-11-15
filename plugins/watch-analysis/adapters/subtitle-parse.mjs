/**
 * adapters/subtitle-parse — 字幕文件纯解析（零 IO、零依赖）
 *
 * 为什么单独拆一个文件：
 *   1. worker 里只做「读文件 → 解码 → parse → Segment[]」，解析逻辑可以被单测用字符串直接喂；
 *   2. 三种格式的坑全在文本细节上（BOM / CRLF / 乱序列 / 逗号），不该和 fs、路径匹配混在一起；
 *   3. 将来换解析库时，只换这一层，provider 和上层都不用动。
 *
 * 约定（与 core/types.ts 的 Segment 对齐）：
 *   - 时间一律**秒**（浮点 number），不是毫秒、不是帧；
 *   - `source` 填格式标识：SRT → 'srt'，ASS/SSA → 'ass'，VTT → 'vtt'；
 *   - `end < start` 的条目是坏数据，直接丢；空正文也丢；
 *   - 输出按 `start` 升序（同一 start 时按 end）。
 *
 * 这里**不做** fs 操作、不依赖任何第三方包，纯函数好测。
 */

/** 统一换行并去掉 BOM；非字符串输入按空文本处理（调用方传错不该炸） */
function normalizeNewlines(text) {
  const source = typeof text === 'string' ? text : ''
  return source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
}

/** 正文里连续空白（含全角空格）压成一个空格，并去掉首尾空白 */
function collapse(text) {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 时间字符串 → 秒。
 *
 * 兼容：
 *   - `HH:MM:SS.mmm` / `HH:MM:SS,mmm`（SRT/VTT）
 *   - `MM:SS.mmm`（VTT 允许省略小时）
 *   - `H:MM:SS.cc`（ASS 的厘秒；小数位按十进制读，`.5` = 0.5s、`.05` = 0.05s）
 *
 * 解析失败返回 null（由调用方当坏数据丢弃）。
 */
function parseClock(raw) {
  const match = /^(?:(\d{1,4}):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(String(raw).trim())
  if (!match) return null
  const hours = match[1] === undefined ? 0 : Number(match[1])
  const minutes = Number(match[2])
  const seconds = Number(match[3])
  const fraction = match[4] === undefined ? 0 : Number(`0.${match[4]}`)
  const value = hours * 3600 + minutes * 60 + seconds + fraction
  return Number.isFinite(value) ? value : null
}

/** SRT/VTT 的时间行：`00:00:01,000 --> 00:00:02,500`，尾部允许 cue 设置/坐标等附加内容 */
const CUE_TIME_LINE =
  /^\s*(\d{1,4}:\d{1,2}:\d{1,2}[.,]\d{1,3}|\d{1,2}:\d{1,2}[.,]\d{1,3})\s*-->\s*(\d{1,4}:\d{1,2}:\d{1,2}[.,]\d{1,3}|\d{1,2}:\d{1,2}[.,]\d{1,3})(?:\s+.*)?\s*$/

/** `<i>` / `<font ...>` / VTT 的 `<c.class>`、`<00:00:01.000>` 都是标签，直接去掉 */
const HTML_TAG_RE = /<[^<>]*>/g

/** 只解常见的 HTML 实体，避免把 `&` 开头的普通文本改坏 */
const ENTITY_RE = /&(amp|lt|gt|quot|apos|nbsp|#39);/gi
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }

function decodeEntities(text) {
  return text.replace(ENTITY_RE, (_, name) => ENTITIES[name.toLowerCase()] ?? '')
}

/** SRT/VTT 的单行正文清理：去标签 → 解实体（顺序不能反，否则 `&lt;i&gt;` 会被当标签吃掉） */
function cleanCueText(line) {
  return decodeEntities(line.replace(HTML_TAG_RE, ''))
}

/** 公共收尾：丢坏数据 + 按 start 排序 */
function finalize(segments) {
  return segments
    .filter(
      (segment) =>
        Number.isFinite(segment.start) &&
        Number.isFinite(segment.end) &&
        segment.end >= segment.start &&
        segment.text.length > 0,
    )
    .sort((a, b) => a.start - b.start || a.end - b.end)
}

/**
 * 解析 SRT。
 *
 * 处理过的变体：
 *   - 文件头 BOM（记事本/部分压制组会带）
 *   - `\r\n` / `\r` / `\n` 混用（先统一成 `\n`）
 *   - 序号行可有可无（不按「三段一组」切，而是扫描时间行）
 *   - 时间用 `.` 当小数分隔（非标准但很常见）
 *   - 正文多行 → 用空格合并成一行
 *   - 正文里的 `<i>` / `<font>` / `<b>` 等标签去掉
 *   - cue 之间缺空行时，靠「纯数字序号行 + 下一行是时间行」判断下一段开始
 */
export function parseSrt(text) {
  const lines = normalizeNewlines(text).split('\n')
  const segments = []

  for (let i = 0; i < lines.length; i += 1) {
    const match = CUE_TIME_LINE.exec(lines[i])
    if (!match) continue

    const start = parseClock(match[1])
    const end = parseClock(match[2])

    // 收集本段正文：遇到空行或下一条时间行就结束
    const body = []
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j]
      if (line.trim() === '') break
      if (CUE_TIME_LINE.test(line)) break
      // 非标准文件可能没有空行分隔：下一段的序号行紧跟着时间行
      if (/^\s*\d+\s*$/.test(line) && j + 1 < lines.length && CUE_TIME_LINE.test(lines[j + 1])) break
      body.push(cleanCueText(line))
    }

    if (start === null || end === null) continue
    const content = collapse(body.join(' '))
    if (!content) continue
    segments.push({ start, end, text: content, source: 'srt' })
  }

  return finalize(segments)
}

/**
 * 解析 ASS / SSA。
 *
 * 关键的坑是**不能假设列序固定**：不同字幕组、不同版本脚本的 `Format:` 行列序不一样，
 * 甚至可能把 `Text` 写在 `Start` 前面（虽然不标准）。所以：
 *   - 以 `[Events]` 段内最近一条 `Format:` 行为准，用列名定位 `Start` / `End` / `Text`；
 *   - 正文里的逗号不能按「固定 N 份」硬切：`Text` 前面的列从行首取、后面的列从行尾取，
 *     中间全部并回 `Text` —— 这样 `Text` 不在最后一列、正文又带逗号时也能还原；
 *   - `{...}` 覆盖标签（`\pos(...)` / `\an8` / `\fad(...)` / `\kf...`）整块去掉；
 *   - `\N` / `\n`（换行）与 `\h`（硬空格）都换成空格。
 *
 * 没有 `Format:` 行时退回 ASS/SSA 通用的 10 列默认序（两者的 Start/End/Text 下标恰好一致）。
 */
const ASS_DEFAULT_FORMAT = [
  'layer',
  'start',
  'end',
  'style',
  'name',
  'marginl',
  'marginr',
  'marginv',
  'effect',
  'text',
]
const ASS_SECTION_RE = /^\[([^\]]+)\]$/
const ASS_FORMAT_RE = /^Format\s*:\s*(.*)$/i
const ASS_DIALOGUE_RE = /^Dialogue\s*:\s*(.*)$/i

/** 按 Format 列名拆一条 Dialogue 行；解析不了返回 null */
function parseAssDialogue(payload, columns) {
  const startIndex = columns.indexOf('start')
  const endIndex = columns.indexOf('end')
  const textIndex = columns.indexOf('text')
  if (startIndex < 0 || endIndex < 0 || textIndex < 0) return null

  const parts = payload.split(',')
  let fields
  if (parts.length === columns.length) {
    fields = parts
  } else if (parts.length > columns.length) {
    // Text 里带逗号（或覆盖标签里带逗号）导致列数变多：
    // Text 之前的列从头部取，Text 之后的列从尾部取，中间并回 Text。
    const afterCount = columns.length - textIndex - 1
    const before = parts.slice(0, textIndex)
    const after = afterCount > 0 ? parts.slice(parts.length - afterCount) : []
    const textPart = parts.slice(textIndex, parts.length - afterCount).join(',')
    fields = [...before, textPart, ...after]
  } else {
    // 列数比 Format 还少，说明这行已经坏了，不猜
    return null
  }

  const start = parseClock(fields[startIndex])
  const end = parseClock(fields[endIndex])
  const content = collapse(cleanAssText(fields[textIndex]))
  if (start === null || end === null || !content) return null
  return { start, end, text: content, source: 'ass' }
}

/** 去掉 ASS 覆盖标签，并把转义换行/硬空格换成空格 */
function cleanAssText(text) {
  return text
    .replace(/\{[^}]*\}/g, '') // {\pos(320,50)} {\an8} {\fad(300,300)} {\k20}...
    .replace(/\\[Nnh]/g, ' ') // \N / \n 换行，\h 硬空格
}

export function parseAss(text) {
  const lines = normalizeNewlines(text).split('\n')
  const segments = []
  let inEvents = false
  let format = null

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    const section = ASS_SECTION_RE.exec(line)
    if (section) {
      inEvents = /^events$/i.test(section[1].trim())
      format = null
      continue
    }
    if (!inEvents) continue // Script Info / Styles 段里的 Format、Dialogue 一律不管

    const formatMatch = ASS_FORMAT_RE.exec(line)
    if (formatMatch) {
      const columns = formatMatch[1].split(',').map((column) => column.trim().toLowerCase())
      // 必须能找到三列才认；否则保留上一条/默认列序，别被半截 Format 行带偏
      if (columns.includes('start') && columns.includes('end') && columns.includes('text')) {
        format = columns
      }
      continue
    }

    const dialogueMatch = ASS_DIALOGUE_RE.exec(line)
    if (!dialogueMatch) continue // Comment / Picture / Sound 等事件不产出台词

    const segment = parseAssDialogue(dialogueMatch[1], format ?? ASS_DEFAULT_FORMAT)
    if (segment) segments.push(segment)
  }

  return finalize(segments)
}

/** VTT 头/注释/样式块，整块跳过（NOTE 里即使出现 `-->` 也不能当 cue） */
const VTT_SKIP_BLOCK_RE = /^(?:WEBVTT|NOTE|STYLE|REGION)\b/i

/**
 * 解析 WebVTT。
 *
 * 按「空行分块」处理，天然吃掉：
 *   - `WEBVTT` 头（可能带标题、`X-TIMESTAMP-MAP` 等元数据）
 *   - `NOTE` / `STYLE` / `REGION` 块
 *   - cue 标识行（时间行前一行）
 *   - 时间行尾部的 cue 设置（`align:start position:10%`）
 * 时间支持 `MM:SS.mmm` 与 `HH:MM:SS.mmm` 两种写法。
 * 正文里的 `<v 旁白>` / `<c.green>` / `<00:00:01.000>` 等标签按 HTML 标签去掉。
 */
export function parseVtt(text) {
  const lines = normalizeNewlines(text).split('\n')
  const segments = []
  let index = 0

  while (index < lines.length) {
    if (lines[index].trim() === '') {
      index += 1
      continue
    }

    const block = []
    while (index < lines.length && lines[index].trim() !== '') {
      block.push(lines[index])
      index += 1
    }

    if (VTT_SKIP_BLOCK_RE.test(block[0].trim())) continue

    // cue 标识行可以出现在时间行前面，找到第一条时间行即可
    let timeLineIndex = -1
    for (let i = 0; i < block.length; i += 1) {
      if (CUE_TIME_LINE.test(block[i])) {
        timeLineIndex = i
        break
      }
    }
    if (timeLineIndex < 0) continue // 不是 cue 的块（坏块）直接丢

    const match = CUE_TIME_LINE.exec(block[timeLineIndex])
    const start = parseClock(match[1])
    const end = parseClock(match[2])
    const content = collapse(block.slice(timeLineIndex + 1).map(cleanCueText).join(' '))

    if (start === null || end === null || !content) continue
    segments.push({ start, end, text: content, source: 'vtt' })
  }

  return finalize(segments)
}

/** 扩展名 → 解析器；`.ssa` 与 `.ass` 是同一套语法，source 仍标 'ass' */
const PARSERS = {
  srt: parseSrt,
  ass: parseAss,
  ssa: parseAss,
  vtt: parseVtt,
}

/**
 * 按扩展名分派。
 * `ext` 大小写、带不带点都行（`.SRT` / `srt`）；未知扩展名返回空数组
 * —— 与上层「空 segments = 无能为力，不算错误」的约定一致。
 */
export function parseSubtitle(text, ext) {
  const key = String(ext ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\./, '')
  const parser = PARSERS[key]
  return parser ? parser(text) : []
}
