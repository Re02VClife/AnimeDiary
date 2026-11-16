/**
 * server/review — AI 影评生成
 *
 * 流程：读已落盘的拉片报告 → 组装「用户锚点 + 分镜图 + 时间码清单」→ 调多模态模型
 * → 解析 JSON → 替换图片占位符 → 校验证据 → 落盘。
 *
 * 四条产品级约束（写在提示词里，也在这里校验）：
 *
 * 1. **不许无证据**。`scores[].evidence` 空数组是允许的（前端标"无证据"），
 *    但模型必须自己知道那是一个缺陷，不能假装有。
 * 2. **不许编时间码**。`timeline` 里的 `episode` 必须是本次实际分析过的集；
 *    `t` 必须落在该集时长内 —— 越界就丢掉并记 caveat，而不是原样交给用户。
 * 3. **图片只许引用给过它的那些**。模型用 `{{sheet:ep01.png}}` 占位，
 *    我们替换成真实 URL；引用不存在的 sheet 一律降级成纯文本。
 * 4. **分数与用户分开**。提示词明确要求"说出你在哪里不同意用户"，
 *    输出里也从不写回 Excel。
 */
import fs from 'node:fs'
import type { AiDimensionScore, AiReview, ReviewCitation, ReviewRequest, ReviewScope, ReviewTimelineItem } from '../core/review-types'
import type { WatchReport } from '../core/types'
import type { ReviewStore } from './review-store'
import type { WatchStore } from './store'
import {
  buildEpisodeBriefPrompt,
  buildSeriesSummaryPrompt,
  parseEpisodeBrief,
} from './review-fanout'
import type { EpisodeBrief } from './review-fanout'

/** 提示词版本：改了提示词就 +1（影评记录里存它，便于"换尺子后为什么结果变了"复盘） */
export const REVIEW_PROMPT_VERSION = '1.0.0'

/** 单图大小上限：超过就跳过（4MB 的 PNG 转 base64 会撑爆请求体） */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024

/**
 * 一次生成最多看几张图（默认值）。
 *
 * 2026-11-17 用户要求：上限提到 1000、推荐 100–500。
 * 上下文确实不是瓶颈（模型 1M），但**单次请求**的图片不能真拉满 ——
 * 1000 张 ≈ 250MB 请求体，网关会直接拒收。所以这里只管"默认给多少"，
 * 真要看几百张得靠 `mode: 'fanout'`（每集一个子任务 + 最后汇总）。
 */
const DEFAULT_MAX_SHEETS = 100

/** 单次影评最多看几张图（用户可配上限，推荐 100–500） */
const MAX_SHEETS_LIMIT = 1000

/**
 * 单次请求的图片预算：超过它就该走 fanout。
 *
 * 60 张 ≈ 15MB 请求体（每张 1280×1080 约 250KB，base64 后 330KB），
 * 再大时上传和 prefill 会成为主要耗时（实测 48 张已要 145 秒）。
 */
const SINGLE_REQUEST_SHEET_BUDGET = 60

/** 默认预算：200 万 token（和单集拉片的上限一致，影评通常只花几千） */
const DEFAULT_BUDGET = 2_000_000

/**
 * 影评请求的超时（毫秒）。
 *
 * 实测一集 24 分钟的影评要 110–180 秒：输出 12000 token 是主要耗时，
 * 而网关默认 timeoutMs 是 120000 —— 正好卡在边缘，稍微慢一点就"请求超时"。
 * 这里显式压过默认值，不依赖用户在 AI 设置里调过。
 */
export const REVIEW_TIMEOUT_MS = 300_000

export interface DescribeResult {
  text: string
  usage: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
    /** 推理模型的思维链 token（有的 provider 没有） */
    reasoningTokens?: number
  }
  model: string
}

/**
 * 生成过程中的进度事件。
 *
 * 为什么需要它：这条链路以前是**一次同步请求**，中途什么都拿不到，
 * 用户只能对着"已用 87 秒"猜模型在干嘛（实测一集要 110–180 秒）。
 * 这三段是服务端真实知道的节点：整理输入 → 调模型 → 解析落盘。
 * 模型内部吐字的进度由 routes 那一层从流式响应转成 `delta` 事件，不经过这里。
 */
export type ReviewProgressEvent =
  | {
      type: 'phase'
      phase: 'collect' | 'call' | 'parse'
      message: string
      /** 交给模型的输入规模（`call` 阶段才有），UI 拿来做"正在看 6 张图"这种文案 */
      sheets?: number
      episodes?: number[]
      shots?: number
    }
  | { type: 'done'; review: AiReview; cached: boolean }

export interface ReviewGeneratorOptions {
  store: WatchStore
  reviewStore: ReviewStore
  /** 多模态调用（由 routes 注入，内部走 ai-gateway） */
  describe: (req: {
    system: string
    prompt: string
    images: string[]
    jsonMode: boolean
    maxTokens: number
    timeoutMs: number
    signal?: AbortSignal
  }) => Promise<DescribeResult>
  appVersion: string
  budgetLimit?: number
}

export interface ReviewGenerator {
  generate(
    req: ReviewRequest,
    signal?: AbortSignal,
    onEvent?: (event: ReviewProgressEvent) => void,
  ): Promise<{ review: AiReview; cached: boolean }>
  read(req: ReviewRequest): AiReview | null
}

/** 把本地图读成 data URL。读不到（不存在/太大/不是图）返回 null，跳过而不是让整单失败。 */
function readImageAsDataUrl(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_IMAGE_BYTES) return null
    const buffer = fs.readFileSync(filePath)
    // 2×3 渲染器出 JPEG，storyboard 出 PNG —— MIME 必须跟着扩展名走，
    // 否则模型侧可能按 PNG 解 JPEG 字节，直接报"无法解码图片"
    const mime = /\.jpe?g$/i.test(filePath) ? 'image/jpeg' : 'image/png'
    return `data:${mime};base64,${buffer.toString('base64')}`
  } catch {
    return null
  }
}

/** `ep01.png` → 1（pipeline 生成文件名时用 `ep${padStart(2)}` 前缀，这条约定在这里复用） */
function episodeFromSheetName(file: string): number | null {
  const match = /^ep(\d+)/.exec(file)
  if (!match) return null
  const n = Number(match[1])
  return Number.isInteger(n) && n > 0 ? n : null
}

/** 秒 → `mm:ss`（超过 1 小时用 `h:mm:ss`） */
function clock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/** 从模型输出里抠 JSON：有的模型会包 ```json 代码块，有的会前后加解释 */
function extractJson(text: string): unknown {
  const raw = text.trim()
  const candidates: string[] = [raw]
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)
  if (fenced?.[1]) candidates.push(fenced[1].trim())
  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1))
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch { /* 下一个 */ }
  }
  return null
}

function num(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => str(v)).filter(Boolean) : []
}

/**
 * 组装提示词。
 *
 * 提示词里**不写 token 数、不写实现细节** —— 那些是给开发者看的，
 * 给模型看只会浪费上下文还干扰判断。
 */
function buildPrompt(
  title: string,
  scope: ReviewScope,
  reports: WatchReport[],
  sheetsByEpisode: Map<number, Array<{ file: string; cells: number }>>,
  userContext: NonNullable<ReviewRequest['userContext']>,
): { system: string; prompt: string } {
  const system = [
    '你是一位资深的动画评论者，正在为个人番剧记录应用写一篇影评。',
    '',
    '铁律（违反任何一条，这篇影评就作废）：',
    '1. **每个判断都要能指到具体时间码**。说不出时间码的判断不要写。',
    '2. **不写空话**。"画面精美""剧情引人入胜""作画优秀"这类没有信息量的句子一律不要。',
    '3. **你的评分和用户评分是两回事**。用户已经打了分（见下），你要明确说出你在哪些地方不同意他，而不是复述他的结论。',
    '4. **只根据给你的分镜图和台词判断**。没看到的内容不要编造；信息不足就写进 caveats。',
    '5. 分镜图是压缩过的（格子上有编号），你能看到的细节有限；不要假装看清了表情或台词之外的小字。',
    '6. **分镜图底部可能有一条彩色带子，那是音轨/响度可视化，不是画面内容**。不要把它当成场景里的东西来评论。',
    '7. 图格子上的数字是格子编号，不是年份或字幕。',
    '8. **正文里不要写「格N」「第N格」**——那是给程序看的内部编号，读者不知道那是什么。要引用画面就直接描述画面里有什么。',
    '9. **只写你确实看清的东西**。分镜图是压缩过的，表情、小字、细节都可能看不清；看不清就明说"这一段看不清细节"，**不要根据时间码去猜画面内容**——猜错比不写更糟，用户会当场发现。',
    '10. **评分维度只能用下面列出的那几个**，不要新增、不要改名、不要合并。',
    '11. **控制篇幅**（这条关系到成败，不是风格问题）：正文不超过 1000 字；timeline 最多 6 条；',
    '    每个维度的 reason 不超过 40 字；caveats 最多 3 条。写不完就只写重点，不要堆砌。',
    '    实测输出太长会被上游截断在半截，整篇影评直接作废 —— 短而完整远胜长而报废。',
    '',
    '输出必须是 JSON，不要任何解释文字。',
  ].join('\n')

  const scopeText = scope.kind === 'series'
    ? `整部番（已分析 ${reports.map((r) => `E${r.episode}`).join(' / ')}）`
    : `第 ${scope.episode} 集`

  const userScores = userContext.scores && Object.keys(userContext.scores).length > 0
    ? Object.entries(userContext.scores).map(([k, v]) => `${k} ${v}`).join(' / ')
    : '（用户还没打分）'

  const sheetLines: string[] = []
  for (const report of reports) {
    const sheets = sheetsByEpisode.get(report.episode) ?? []
    sheetLines.push(
      `- E${report.episode}：时长 ${clock(report.video.duration)}，${report.shots.length} 个镜头，` +
      `${report.cuts.length} 个切点，分镜图 ${sheets.map((s) => `${s.file}(${s.cells} 格)`).join(' / ') || '无'}`,
    )
  }

  const shotLines: string[] = []
  for (const report of reports.slice(0, 12)) {
    // 每集最多列 40 个镜头的时间，足够模型定位，又不至于淹没重点
    const lines = report.shots.slice(0, 40).map((shot) =>
      `  #${shot.i} ${clock(shot.start)}–${clock(shot.end)}${shot.text ? ` 「${shot.text.slice(0, 40)}」` : ''}`,
    )
    shotLines.push(`E${report.episode}：\n${lines.join('\n')}`)
  }

  /*
   * 台词：**影评里最硬的一手证据**，但以前根本没进提示词。
   *
   * 之前只统计了 `inputs.dialogueLines` 的条数，模型却一句话都看不到 —— 报告里明明
   * 存着 ASR/字幕的完整台词，prompt 只给了镜头时间码。画面能看出"谁在说话"，
   * 但说不清"说了什么"，这恰好是影评最需要引用的东西。
   *
   * 不能全塞：一集 24 分钟几百句会占掉半个上下文。均匀抽样（每集最多 60 句），
   * 说话人编号原样带上（`S01`），并明确告诉模型"编号不是名字，别自己安"。
   */
  const dialogueLines: string[] = []
  for (const report of reports.slice(0, 12)) {
    const segments = report.transcript?.segments ?? []
    if (segments.length === 0) continue
    const maxLines = 60
    const step = Math.max(1, Math.ceil(segments.length / maxLines))
    const picked = segments.filter((_, index) => index % step === 0).slice(0, maxLines)
    const lines = picked.map((segment) => (
      `  [${clock(segment.start)}]${segment.speaker ? ` ${segment.speaker}:` : ''} ${segment.text.slice(0, 60)}`
    ))
    dialogueLines.push(`E${report.episode}（共 ${segments.length} 句）：\n${lines.join('\n')}`)
  }

  /*
   * 弹幕：**观众在那一刻的真实反应**。
   *
   * 这是本插件里最"便宜"的一手证据：Kazumi 缓存自带 danmaku.json，不用装 ASR、
   * 不用调模型，一次读盘 0.01 秒。里面经常有「横谷昌宏又来」「角色设计是别当欧尼酱的」
   * 这种连画面和字幕都给不了的制作背景，以及「这里崩了/这段封神」的观众共识。
   *
   * 但不能全塞：95 个时间桶 × 5 条会占掉上下文的三分之一。
   * 折中：均匀抽 30 桶（覆盖全片）+ 密度最高的 10 桶（高能段不遗漏）。
   */
  const danmakuLines: string[] = []
  for (const report of reports) {
    const summary = report.danmaku
    if (!summary || summary.buckets.length === 0) continue
    const all = summary.buckets
    const dense = [...all].sort((a, b) => b.count - a.count).slice(0, 10)
    const evenStep = Math.max(1, Math.floor(all.length / 20))
    const even = all.filter((_, index) => index % evenStep === 0).slice(0, 20)
    const picked = [...new Set([...even, ...dense])].sort((a, b) => a.t - b.t)
    const lines = picked.map((bucket) =>
      `  [${clock(bucket.t)}] ${bucket.count}条: ${bucket.samples.slice(0, 3).join(' / ')}`,
    )
    danmakuLines.push(`E${report.episode}（共 ${summary.rawTotal ?? summary.total} 条弹幕）：\n${lines.join('\n')}`)
  }

  // 维度只能用用户模板里那些（中文标签由前端翻译好传进来）。
  // 用户没打过分的维度不要去评 —— 那会让多出来的分数显得凭空出现。
  const userDimensions = Object.keys(userContext.scores ?? {})
  const dimensionList = userDimensions.length > 0
    ? userDimensions.join(' / ')
    : '剧情 / 作画 / 音声 / 制作 / 沉浸 / 人设 / 深度 / 电波'

  const prompt = [
    `【作品】${title}`,
    `【范围】${scopeText}`,
    '',
    '【用户自己的判断 —— 你的锚点】',
    `维度评分：${userScores}`,
    userContext.bangumiScore ? `Bangumi 社区分：${userContext.bangumiScore}` : '',
    userContext.tags?.length ? `用户标签：${userContext.tags.join(' / ')}` : '',
    userContext.review ? `用户写的评价：\n"""\n${userContext.review.slice(0, 1500)}\n"""` : '',
    '',
    '【这次给了你什么】',
    ...sheetLines,
    '',
    '【镜头与台词时间码（节选）】',
    ...shotLines,
    '',
    ...(dialogueLines.length > 0
      ? [
          '【台词（字幕文件或本地 ASR，同音字可能有错）】',
          '标了 `S01`/`S02` 的是说话人编号：**同一编号是同一个人，但编号本身不是角色名**，',
          '不要自己把编号和角色对上号；引用时保留原句即可。',
          ...dialogueLines,
          '',
        ]
      : []),
    ...(danmakuLines.length > 0
      ? [
          '【观众弹幕（按时间，已过滤广告/刷屏）】',
          '这是**真实观众在那些时刻的反应**，可以用来说明"哪段高能/哪段被吐槽"，',
          '但它是**别人的观点**，引用时要写清楚"弹幕在说"而不是当成你自己的判断。',
          ...danmakuLines,
          '',
        ]
      : []),
    '【引用分镜的格式】',
    '正文里要插图时，写成 `{{sheet:文件名}}` 或 `{{sheet:文件名:第几格}}`，例如 `{{sheet:ep01-1.jpg}}`、`{{sheet:ep01-1.jpg:3}}`。',
    '**文件名必须和上面列出的完全一致（包括 .jpg / .png 后缀）**，写错就插不进图。',
    '**不要写 URL**，会由程序替换。只能引用上面列出来的那些文件名。',
    '时间码写成 `[mm:ss]`，例如 `[12:34]`。',
    '',
    '【输出 JSON 结构】',
    '{',
    '  "scores": [',
    '    { "dimension": "剧情", "value": 8.1, "reason": "一句话说清为什么",',
    '      "evidence": [{ "episode": 1, "t": 754, "note": "具体是什么" }] }',
    '  ],',
    '  "markdown": "影评正文（Markdown，1000 字以内，可以插图和 [mm:ss] 时间码）",',
    '  "timeline": [{ "episode": 1, "t": 754, "text": "这个时间点发生了什么/说明了什么", "shot": 42 }],',
    '  "citations": [{ "episode": 1, "sheet": "ep01.png", "cell": 3 }],',
    '  "spoiler": "涉及结局/反转的段落，没有就空字符串",',
    '  "caveats": ["信息不足/不确定的地方"]',
    '}',
    '',
    '评分维度**只能是这几个**（一个字都不要改）：' + dimensionList,
    '0–10 分，允许一位小数。**每个分数都必须有 reason，能给出 evidence 就必须给。**',
    '用户没打过分的维度不要评 —— 多出来的分数会让雷达图看起来凭空多了一堆点。',
  ].filter((line) => line !== '').join('\n')

  return { system, prompt }
}

/** 校验并收窄模型输出。坏掉的条目丢掉而不是让整篇失败 —— 影评正文通常还是可用的。 */
function normalizeScores(raw: unknown, reports: WatchReport[]): AiDimensionScore[] {
  if (!Array.isArray(raw)) return []
  const episodeDurations = new Map(reports.map((r) => [r.episode, r.video.duration]))
  const out: AiDimensionScore[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const dimension = str(record.dimension)
    if (!dimension) continue
    const value = Math.max(0, Math.min(10, num(record.value, 0)))
    const reason = str(record.reason)
    const evidence: AiDimensionScore['evidence'] = []
    if (Array.isArray(record.evidence)) {
      for (const ev of record.evidence) {
        if (!ev || typeof ev !== 'object') continue
        const evRecord = ev as Record<string, unknown>
        const episode = Math.round(num(evRecord.episode, 0))
        const duration = episodeDurations.get(episode)
        const t = num(evRecord.t, -1)
        // 只接受「确实分析过的集」+「时间落在片长内」的证据，防止模型编时间码
        if (duration === undefined || t < 0 || t > duration) continue
        evidence.push({ episode, t: Math.round(t * 10) / 10, ...(str(evRecord.note) ? { note: str(evRecord.note) } : {}) })
      }
    }
    out.push({ dimension, value: Math.round(value * 10) / 10, reason, evidence })
  }
  return out
}

function normalizeTimeline(raw: unknown, reports: WatchReport[]): ReviewTimelineItem[] {
  if (!Array.isArray(raw)) return []
  const episodeDurations = new Map(reports.map((r) => [r.episode, r.video.duration]))
  const shotCounts = new Map(reports.map((r) => [r.episode, r.shots.length]))
  const out: ReviewTimelineItem[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const episode = Math.round(num(record.episode, 0))
    const duration = episodeDurations.get(episode)
    const t = num(record.t, -1)
    if (duration === undefined || t < 0 || t > duration) continue
    const text = str(record.text)
    if (!text) continue
    const shotRaw = record.shot
    const shot = shotRaw === undefined || shotRaw === null ? undefined : Math.round(num(shotRaw, -1))
    const shotCount = shotCounts.get(episode) ?? 0
    out.push({
      episode,
      t: Math.round(t * 10) / 10,
      text,
      ...(shot !== undefined && shot >= 0 && shot < shotCount ? { shot } : {}),
    })
  }
  return out.sort((a, b) => (a.episode - b.episode) || (a.t - b.t))
}

function normalizeCitations(raw: unknown, available: Map<number, Set<string>>): ReviewCitation[] {
  if (!Array.isArray(raw)) return []
  const out: ReviewCitation[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const episode = Math.round(num(record.episode, 0))
    const sheet = str(record.sheet)
    if (!sheet || !available.get(episode)?.has(sheet)) continue
    const key = `${episode}:${sheet}`
    if (seen.has(key)) continue
    seen.add(key)
    const cellRaw = record.cell
    const cell = cellRaw === undefined || cellRaw === null ? undefined : Math.round(num(cellRaw, 0))
    out.push({ episode, sheet, ...(cell !== undefined && cell > 0 ? { cell } : {}) })
  }
  return out
}

/**
 * 把模型写的 `{{sheet:ep01.png}}` 换成真实 Markdown 图片。
 * 引用不存在的 sheet 就降级成纯文本（保留文件名），不让用户看到破图。
 *
 * **同一张图在正文里只插一次**：模型经常连着引用"格167、格170"和"格169、格171"，
 * 它们落在同一张 9 格图里，替换后就是三四张一模一样的图，观感很差（用户实测反馈）。
 * 重复引用降级成「（见上图）」，既保留语义又不重复渲染。
 */
function replaceSheetPlaceholders(markdown: string, key: string, available: Map<number, Set<string>>): string {
  const inserted = new Set<string>()
  return markdown.replace(/\{\{\s*sheet\s*:\s*([^}:]+?)\s*(?::\s*(\d+)\s*)?\}\}/gi, (whole, rawFile: string, cell?: string) => {
    const episode = episodeFromSheetName(rawFile)
    if (episode === null) return `[分镜 ${rawFile}]`
    const files = available.get(episode)
    if (!files) return `[分镜 ${rawFile}]`

    // 模型经常**漏写扩展名**（写 {{sheet:ep01-1}} 而不是 ep01-1.jpg）——
    // 实测 2×3 渲染器换成 .jpg 后缀后整篇一个图都没插进去。
    // 这里按「原样 → 补 .jpg → 补 .png」依次找，找不到才降级成文字。
    const resolved = files.has(rawFile)
      ? rawFile
      : files.has(`${rawFile}.jpg`)
        ? `${rawFile}.jpg`
        : files.has(`${rawFile}.png`)
          ? `${rawFile}.png`
          : null
    if (!resolved) return `[分镜 ${rawFile}]`

    if (inserted.has(resolved)) return '（见上图）'
    inserted.add(resolved)
    const query = new URLSearchParams({ key, episode: String(episode), file: resolved })
    const url = `/api/watch/sheet?${query.toString()}`
    return `![E${episode} 分镜${cell ? ` 第${cell}格` : ''}](${url})`
  })
}

export function createReviewGenerator(opts: ReviewGeneratorOptions): ReviewGenerator {
  const defaultBudgetLimit = opts.budgetLimit ?? DEFAULT_BUDGET

  /**
   * 按 scope + 用户勾选收窄要参与生成的集。
   *
   * `options.episodes` 是配置页"分析集数"多选的结果 —— 不接的话用户取消勾选等于没反应，
   * 还会照常为没选的集花 token。
   */
  function episodesForScope(scope: ReviewScope, reports: WatchReport[], wanted?: number[]): WatchReport[] {
    let picked = scope.kind === 'episode'
      ? reports.filter((r) => r.episode === scope.episode)
      : reports
    if (Array.isArray(wanted) && wanted.length > 0) {
      const allow = new Set(wanted.filter((n) => Number.isInteger(n) && n > 0))
      picked = picked.filter((r) => allow.has(r.episode))
    }
    return picked
  }

  /** 每集配额 + 集内均匀采样：单次模式与 fanout 共用同一份收集逻辑 */
  function collectImages(selected: WatchReport[], perEpisode: number) {
    const available = new Map<number, Set<string>>()
    const sheetsByEpisode = new Map<number, Array<{ file: string; cells: number }>>()
    const imagesByEpisode = new Map<number, string[]>()
    const images: string[] = []

    for (const report of selected) {
      // 所有 sheet 都登记为"可引用"，即使这次没取到图 —— 引用会降级成文字，不会破图
      available.set(report.episode, new Set(report.sheets.map((sheet) => sheet.file)))

      const meta: Array<{ file: string; cells: number }> = []
      const dataUrls: string[] = []
      const total = report.sheets.length
      if (total > 0) {
        const take = Math.min(perEpisode, total)
        // 18 张里取 6 张 → 索引 0/3/6/9/12/15，覆盖开头到结尾
        const step = total / take
        for (let index = 0; index < take; index += 1) {
          const sheet = report.sheets[Math.min(total - 1, Math.floor(index * step))]
          if (!sheet || meta.some((picked) => picked.file === sheet.file)) continue
          const filePath = opts.store.sheetFile(report.key, report.episode, sheet.file)
          if (!filePath) continue
          const dataUrl = readImageAsDataUrl(filePath)
          if (!dataUrl) continue
          images.push(dataUrl)
          dataUrls.push(dataUrl)
          meta.push({ file: sheet.file, cells: sheet.cells })
        }
      }
      sheetsByEpisode.set(report.episode, meta)
      imagesByEpisode.set(report.episode, dataUrls)
    }

    return { available, sheetsByEpisode, imagesByEpisode, images }
  }

  function addUsage(
    total: { promptTokens: number; completionTokens: number; reasoningTokens: number; totalTokens: number },
    usage: DescribeResult['usage'],
  ): void {
    total.promptTokens += usage.promptTokens
    total.completionTokens += usage.completionTokens
    total.reasoningTokens += usage.reasoningTokens ?? 0
    total.totalTokens += usage.totalTokens
  }

  function userScoreText(userContext: NonNullable<ReviewRequest['userContext']>): string {
    const entries = Object.entries(userContext.scores ?? {})
    return entries.length > 0 ? entries.map(([name, value]) => `${name} ${value}`).join(' / ') : '（用户还没打分）'
  }

  /** 单集素材：镜头 40 条 / 台词 60 句 / 弹幕 30 桶（和整季 prompt 同一口径） */
  function episodeMaterial(report: WatchReport): {
    shotLines: string[]
    dialogueLines: string[]
    danmakuLines: string[]
  } {
    const shotLines = report.shots.slice(0, 40).map((shot) =>
      `  #${shot.i} ${clock(shot.start)}–${clock(shot.end)}${shot.text ? ` 「${shot.text.slice(0, 40)}」` : ''}`,
    )

    const segments = report.transcript?.segments ?? []
    const dialogueLines: string[] = []
    if (segments.length > 0) {
      const step = Math.max(1, Math.ceil(segments.length / 60))
      dialogueLines.push(...segments
        .filter((_, index) => index % step === 0)
        .slice(0, 60)
        .map((segment) => `  [${clock(segment.start)}]${segment.speaker ? ` ${segment.speaker}:` : ''} ${segment.text.slice(0, 60)}`))
    }

    const danmakuLines: string[] = []
    const summary = report.danmaku
    if (summary && summary.buckets.length > 0) {
      const dense = [...summary.buckets].sort((a, b) => b.count - a.count).slice(0, 10)
      const evenStep = Math.max(1, Math.floor(summary.buckets.length / 20))
      const even = summary.buckets.filter((_, index) => index % evenStep === 0).slice(0, 20)
      const picked = [...new Set([...even, ...dense])].sort((a, b) => a.t - b.t)
      danmakuLines.push(...picked.map((bucket) => `  [${clock(bucket.t)}] ${bucket.count}条: ${bucket.samples.slice(0, 3).join(' / ')}`))
    }

    return { shotLines, dialogueLines, danmakuLines }
  }

  /**
   * 分集子任务 + 汇总：每集单独看一次（只看这一集的图），最后只发文字小结合成整季影评。
   *
   * 这是"单次上限 1000 张"能落地的前提 —— 1000 张塞进一个请求是 250MB，必然被拒；
   * 拆成每集一个请求后，单请求只承担一集的图（12–100 张）。代价是 N+1 次调用、token 总量更高。
   */
  async function generateFanout(
    input: {
      req: ReviewRequest
      selected: WatchReport[]
      collected: ReturnType<typeof collectImages>
      userContext: NonNullable<ReviewRequest['userContext']>
    },
    signal: AbortSignal | undefined,
    onEvent: ((event: ReviewProgressEvent) => void) | undefined,
    startedAt: number,
  ): Promise<{ review: AiReview; cached: boolean }> {
    const { req, selected, collected, userContext } = input
    const title = userContext.title || req.key
    const briefs: EpisodeBrief[] = []
    const totalUsage = { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0 }
    const failures: string[] = []

    for (let index = 0; index < selected.length; index += 1) {
      const report = selected[index]
      const images = collected.imagesByEpisode.get(report.episode) ?? []
      onEvent?.({
        type: 'phase',
        phase: 'call',
        message: `子任务 ${index + 1}/${selected.length}：第 ${report.episode} 集（${images.length} 张图）`,
        sheets: images.length,
        episodes: [report.episode],
      })

      const { system, prompt } = buildEpisodeBriefPrompt({
        title,
        episode: report.episode,
        duration: report.video.duration,
        shots: report.shots.length,
        cuts: report.cuts.length,
        sheetCount: images.length,
        ...episodeMaterial(report),
        userScores: userScoreText(userContext),
      })

      try {
        const result = await opts.describe({
          system,
          prompt,
          images,
          jsonMode: true,
          maxTokens: 4000,
          timeoutMs: REVIEW_TIMEOUT_MS,
          signal,
        })
        addUsage(totalUsage, result.usage)
        const brief = parseEpisodeBrief(result.text, report.episode)
        if (brief) briefs.push(brief)
        else failures.push(`E${report.episode} 的小结无法解析`)
      } catch (error) {
        // 用户取消要立刻停，不能继续烧后面的集
        if (signal?.aborted) throw error
        failures.push(`E${report.episode}：${error instanceof Error ? error.message : String(error)}`)
      }
    }

    if (briefs.length === 0) {
      throw new Error(`分集收集全部失败：${failures.join('；') || '没有可用的分集小结'}`)
    }

    onEvent?.({
      type: 'phase',
      phase: 'call',
      message: `汇总 ${briefs.length} 集的小结（不再发图）`,
      sheets: 0,
      episodes: briefs.map((brief) => brief.episode),
    })

    const { system, prompt } = buildSeriesSummaryPrompt({
      title,
      episodeRange: `E${selected[0].episode}–E${selected[selected.length - 1].episode}（${selected.length} 集）`,
      briefs,
      userScores: userScoreText(userContext),
      stats: {
        episodes: selected.length,
        shots: selected.reduce((sum, report) => sum + report.shots.length, 0),
        sheets: collected.images.length,
      },
      userReview: userContext.review,
      episodes: selected.map((report) => report.episode),
      dimensions: Object.keys(userContext.scores ?? {}),
    })

    const result = await opts.describe({
      system,
      prompt,
      images: [],
      jsonMode: true,
      maxTokens: 12000,
      timeoutMs: REVIEW_TIMEOUT_MS,
      signal,
    })
    addUsage(totalUsage, result.usage)

    onEvent?.({ type: 'phase', phase: 'parse', message: '解析汇总结果、校验时间码与引用' })
    const parsed = extractJson(result.text)
    if (!parsed || typeof parsed !== 'object') {
      const tail = result.text.slice(-240).replace(/\s+/g, ' ')
      throw new Error(`汇总没有返回合法 JSON（输出 ${result.text.length} 字符，结尾：「${tail}」）`)
    }
    const record = parsed as Record<string, unknown>

    const scores = normalizeScores(record.scores, selected)
    const timeline = normalizeTimeline(record.timeline, selected)
    const citations = normalizeCitations(record.citations, collected.available)
    const rawMarkdown = str(record.markdown)
    if (!rawMarkdown) throw new Error('汇总返回了 JSON 但没有影评正文')

    const caveats = strArray(record.caveats)
    if (failures.length > 0) {
      caveats.push(`分集收集有 ${failures.length} 集失败：${failures.join('；')}`)
    }
    caveats.push(`本篇由 ${briefs.length} 集分集小结汇总生成（共 ${selected.length + 1} 次模型调用）`)

    const review: AiReview = {
      schema: 1,
      key: req.key,
      scope: req.scope,
      model: result.model,
      promptVersion: REVIEW_PROMPT_VERSION,
      tokens: totalUsage.totalTokens,
      usage: {
        promptTokens: totalUsage.promptTokens,
        completionTokens: totalUsage.completionTokens,
        ...(totalUsage.reasoningTokens > 0 ? { reasoningTokens: totalUsage.reasoningTokens } : {}),
        totalTokens: totalUsage.totalTokens,
      },
      elapsedMs: Date.now() - startedAt,
      created: new Date().toISOString(),
      appVersion: opts.appVersion,
      scores,
      markdown: replaceSheetPlaceholders(rawMarkdown, req.key, collected.available),
      timeline,
      citations,
      inputs: {
        episodes: selected.map((report) => report.episode),
        shots: selected.reduce((sum, report) => sum + report.shots.length, 0),
        sheets: collected.images.length,
        dialogueLines: selected.reduce((sum, report) => sum + (report.transcript?.segments.length ?? 0), 0),
      },
      ...(str(record.spoiler) ? { spoiler: replaceSheetPlaceholders(str(record.spoiler), req.key, collected.available) } : {}),
      ...(caveats.length > 0 ? { caveats } : {}),
    }

    opts.reviewStore.write(review)
    onEvent?.({ type: 'done', review, cached: false })
    return { review, cached: false }
  }

  return {
    read(req) {
      return opts.reviewStore.read(req.key, req.scope)
    },

    async generate(req, signal, onEvent) {
      const startedAt = Date.now()
      const scope = req.scope
      const allReports = opts.store.listEpisodes(req.key)
        .map((episode) => opts.store.read(req.key, episode))
        .filter((r): r is WatchReport => Boolean(r))

      if (allReports.length === 0) {
        throw new Error('这部番还没有任何一集的拉片分析：先做一集分析再生成影评')
      }

      const selected = episodesForScope(scope, allReports, req.options?.episodes)
      if (selected.length === 0) {
        throw new Error(scope.kind === 'episode'
          ? `第 ${scope.episode} 集还没有做过拉片分析`
          : '勾选的集都还没有做过拉片分析')
      }

      // 缓存：同一份报告 + 同一个模型 + 同一版提示词，不重复花钱
      const existing = opts.reviewStore.read(req.key, scope)
      if (!req.options?.force && existing) {
        onEvent?.({ type: 'done', review: existing, cached: true })
        return { review: existing, cached: true }
      }

      // 命中缓存就没有"整理输入"这一步，collect 事件放在缓存判断之后
      onEvent?.({ type: 'phase', phase: 'collect', message: '正在整理拉片报告与分镜图' })

      // ── 收集图片（每集配额 + 集内均匀采样）──
      // 旧实现是"顺序取前 N 张"：多集时前面的集吃满配额、后面的集一张都看不到；
      // 单集时只看得到前半集（一集 18 张图只给前 8 张）。这里改成每集按比例分，
      // 且集内跳着取，保证覆盖全片。
      const maxSheets = Math.max(1, Math.min(MAX_SHEETS_LIMIT, req.options?.maxSheets ?? DEFAULT_MAX_SHEETS))
      const perEpisode = Math.max(1, Math.floor(maxSheets / selected.length))
      const collected = collectImages(selected, perEpisode)

      if (collected.images.length === 0) {
        throw new Error('找不到任何分镜图：报告存在但图片丢失，请重新做一次拉片分析')
      }

      const userContext = req.userContext ?? { title: req.key }

      /*
       * 生成方式：
       *   - 'single'：一次调用，所有图 + 报告一起发；
       *   - 'fanout'：每集一个子任务（只看这一集的图），最后只发文字小结合成；
       *   - 'auto'（默认）：多集且总图数超过单请求预算时才拆 —— 单集拆了没意义，
       *     2 集 20 张也不值得多花一次调用。
       */
      const requestedMode = req.options?.mode
      const mode: 'single' | 'fanout' =
        requestedMode === 'single' || requestedMode === 'fanout'
          ? requestedMode
          : selected.length > 1 && collected.images.length > SINGLE_REQUEST_SHEET_BUDGET
            ? 'fanout'
            : 'single'

      if (mode === 'fanout') {
        return await generateFanout({ req, selected, collected, userContext }, signal, onEvent, startedAt)
      }

      onEvent?.({
        type: 'phase',
        phase: 'call',
        message: `把 ${collected.images.length} 张分镜图和 ${selected.length} 集报告交给模型`,
        sheets: collected.images.length,
        episodes: selected.map((r) => r.episode),
        shots: selected.reduce((n, r) => n + r.shots.length, 0),
      })

      // ── 调模型 ──
      const { system, prompt } = buildPrompt(userContext.title || req.key, scope, selected, collected.sheetsByEpisode, userContext)

      const result = await opts.describe({
        system,
        prompt,
        images: collected.images,
        jsonMode: true,
        // 影评正文 + JSON 结构。实测 6000 会被截断（JSON 不完整 → 解析失败），
        // 一篇 24 分钟单集的影评正文 + 8 个维度 + 时间轴经常超 6000 token。
        maxTokens: 12000,
        timeoutMs: REVIEW_TIMEOUT_MS,
        signal,
      })

      // 预算：请求里带就用请求的（配置页那个 InputNumber），否则用默认 200 万
      const budgetLimit = Math.max(0, Math.floor(req.options?.budget ?? defaultBudgetLimit))
      if (budgetLimit > 0 && result.usage.totalTokens > budgetLimit) {
        // 花超了不算失败，但要如实记录 —— 让用户知道这篇影评"很贵"
        console.warn(`[watch-review] 本次 ${result.usage.totalTokens} token 超出预算 ${budgetLimit}`)
      }

      // ── 解析 ──
      onEvent?.({ type: 'phase', phase: 'parse', message: '解析模型输出、校验时间码与引用' })
      const parsed = extractJson(result.text)
      if (!parsed || typeof parsed !== 'object') {
        // 只报"没返回 JSON"等于什么都没说 —— 把输出结尾带进错误里，
        // 才能判断是"被截断"（结尾是半截 JSON）还是"根本没按格式写"（结尾是正文）
        const tail = result.text.slice(-240).replace(/\s+/g, ' ')
        throw new Error(`模型没有返回合法 JSON（输出 ${result.text.length} 字符，结尾：「${tail}」）`)
      }
      const record = parsed as Record<string, unknown>

      const scores = normalizeScores(record.scores, selected)
      const timeline = normalizeTimeline(record.timeline, selected)
      const citations = normalizeCitations(record.citations, collected.available)
      const rawMarkdown = str(record.markdown)
      if (!rawMarkdown) throw new Error('模型返回了 JSON 但没有影评正文')

      const caveats = strArray(record.caveats)
      // 自己没有证据的分数：不拒绝，但要如实提示——这是产品要求
      const noEvidence = scores.filter((s) => s.evidence.length === 0)
      if (noEvidence.length > 0) {
        caveats.push(`有 ${noEvidence.length} 个维度没有给出证据（${noEvidence.map((s) => s.dimension).join('、')}）`)
      }
      // 时间码被丢掉的数量：说明模型编了不存在的定位
      const rawTimelineCount = Array.isArray(record.timeline) ? record.timeline.length : 0
      if (rawTimelineCount > timeline.length) {
        caveats.push(`模型给了 ${rawTimelineCount} 条时间轴，其中 ${rawTimelineCount - timeline.length} 条时间码越界已丢弃`)
      }

      const review: AiReview = {
        schema: 1,
        key: req.key,
        scope,
        model: result.model,
        promptVersion: REVIEW_PROMPT_VERSION,
        tokens: result.usage.totalTokens,
        usage: {
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          ...(result.usage.reasoningTokens ? { reasoningTokens: result.usage.reasoningTokens } : {}),
          totalTokens: result.usage.totalTokens,
        },
        elapsedMs: Date.now() - startedAt,
        created: new Date().toISOString(),
        appVersion: opts.appVersion,
        scores,
        markdown: replaceSheetPlaceholders(rawMarkdown, req.key, collected.available),
        timeline,
        citations,
        inputs: {
          episodes: selected.map((r) => r.episode),
          shots: selected.reduce((n, r) => n + r.shots.length, 0),
          sheets: collected.images.length,
          dialogueLines: selected.reduce((n, r) => n + (r.transcript?.segments.length ?? 0), 0),
        },
        ...(str(record.spoiler) ? { spoiler: replaceSheetPlaceholders(str(record.spoiler), req.key, collected.available) } : {}),
        ...(caveats.length > 0 ? { caveats } : {}),
      }

      opts.reviewStore.write(review)
      onEvent?.({ type: 'done', review, cached: false })
      return { review, cached: false }
    },
  }
}
