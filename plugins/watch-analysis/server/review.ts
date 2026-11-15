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

/** 提示词版本：改了提示词就 +1（影评记录里存它，便于"换尺子后为什么结果变了"复盘） */
export const REVIEW_PROMPT_VERSION = '1.0.0'

/** 单图大小上限：超过就跳过（4MB 的 PNG 转 base64 会撑爆请求体） */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024

/** 一次生成最多看几张图。图按像素计费不贵，但太多会挤占上下文。 */
const DEFAULT_MAX_SHEETS = 8

/** 默认预算：200 万 token（和单集拉片的上限一致，影评通常只花几千） */
const DEFAULT_BUDGET = 2_000_000

export interface DescribeResult {
  text: string
  usage: { promptTokens: number; completionTokens: number; totalTokens: number }
  model: string
}

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
    signal?: AbortSignal
  }) => Promise<DescribeResult>
  appVersion: string
  budgetLimit?: number
}

export interface ReviewGenerator {
  generate(req: ReviewRequest, signal?: AbortSignal): Promise<{ review: AiReview; cached: boolean }>
  read(req: ReviewRequest): AiReview | null
}

/** 把本地 PNG 读成 data URL。读不到（不存在/太大/不是图）返回 null，跳过而不是让整单失败。 */
function readImageAsDataUrl(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_IMAGE_BYTES) return null
    const buffer = fs.readFileSync(filePath)
    return `data:image/png;base64,${buffer.toString('base64')}`
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
    '【引用分镜的格式】',
    '正文里要插图时，写成 `{{sheet:文件名}}` 或 `{{sheet:文件名:第几格}}`，例如 `{{sheet:ep01.png}}`、`{{sheet:ep01.png:3}}`。',
    '**不要写 URL**，会由程序替换。只能引用上面列出来的那些文件名。',
    '时间码写成 `[mm:ss]`，例如 `[12:34]`。',
    '',
    '【输出 JSON 结构】',
    '{',
    '  "scores": [',
    '    { "dimension": "剧情", "value": 8.1, "reason": "一句话说清为什么",',
    '      "evidence": [{ "episode": 1, "t": 754, "note": "具体是什么" }] }',
    '  ],',
    '  "markdown": "影评正文（Markdown，可以插图和 [mm:ss] 时间码）",',
    '  "timeline": [{ "episode": 1, "t": 754, "text": "这个时间点发生了什么/说明了什么", "shot": 42 }],',
    '  "citations": [{ "episode": 1, "sheet": "ep01.png", "cell": 3 }],',
    '  "spoiler": "涉及结局/反转的段落，没有就空字符串",',
    '  "caveats": ["信息不足/不确定的地方"]',
    '}',
    '',
    '评分维度必须沿用用户已经用过的那些维度名（如果用户没打分，就用：剧情 / 作画 / 声音 / 制作 / 沉浸 / 人设 / 深度 / 电波）。',
    '0–10 分，允许一位小数。**每个分数都必须有 reason，能给出 evidence 就必须给。**',
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
 */
function replaceSheetPlaceholders(markdown: string, key: string, available: Map<number, Set<string>>): string {
  return markdown.replace(/\{\{\s*sheet\s*:\s*([^}:]+?)\s*(?::\s*(\d+)\s*)?\}\}/gi, (whole, file: string, cell?: string) => {
    const episode = episodeFromSheetName(file)
    if (episode === null || !available.get(episode)?.has(file)) {
      return `[分镜 ${file}]`
    }
    const query = new URLSearchParams({ key, episode: String(episode), file })
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

  return {
    read(req) {
      return opts.reviewStore.read(req.key, req.scope)
    },

    async generate(req, signal) {
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
      if (!req.options?.force && existing) return { review: existing, cached: true }

      // ── 收集图片 ──
      const available = new Map<number, Set<string>>()
      const sheetsByEpisode = new Map<number, Array<{ file: string; cells: number }>>()
      const images: string[] = []
      const maxSheets = Math.max(1, Math.min(16, req.options?.maxSheets ?? DEFAULT_MAX_SHEETS))
      let usedSheets = 0

      for (const report of selected) {
        const files = new Set<string>()
        const meta: Array<{ file: string; cells: number }> = []
        for (const sheet of report.sheets) {
          files.add(sheet.file)
          if (usedSheets >= maxSheets) continue
          const filePath = opts.store.sheetFile(report.key, report.episode, sheet.file)
          if (!filePath) continue
          const dataUrl = readImageAsDataUrl(filePath)
          if (!dataUrl) continue
          images.push(dataUrl)
          meta.push({ file: sheet.file, cells: sheet.cells })
          usedSheets += 1
        }
        available.set(report.episode, files)
        sheetsByEpisode.set(report.episode, meta)
      }

      if (images.length === 0) {
        throw new Error('找不到任何分镜图：报告存在但图片丢失，请重新做一次拉片分析')
      }

      // ── 调模型 ──
      const userContext = req.userContext ?? { title: req.key }
      const { system, prompt } = buildPrompt(userContext.title || req.key, scope, selected, sheetsByEpisode, userContext)

      const result = await opts.describe({
        system,
        prompt,
        images,
        jsonMode: true,
        // 影评正文 + JSON 结构，给足输出预算
        maxTokens: 6000,
        signal,
      })

      // 预算：请求里带就用请求的（配置页那个 InputNumber），否则用默认 200 万
      const budgetLimit = Math.max(0, Math.floor(req.options?.budget ?? defaultBudgetLimit))
      if (budgetLimit > 0 && result.usage.totalTokens > budgetLimit) {
        // 花超了不算失败，但要如实记录 —— 让用户知道这篇影评"很贵"
        console.warn(`[watch-review] 本次 ${result.usage.totalTokens} token 超出预算 ${budgetLimit}`)
      }

      // ── 解析 ──
      const parsed = extractJson(result.text)
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('模型没有返回合法 JSON，影评生成失败（可以重试一次）')
      }
      const record = parsed as Record<string, unknown>

      const scores = normalizeScores(record.scores, selected)
      const timeline = normalizeTimeline(record.timeline, selected)
      const citations = normalizeCitations(record.citations, available)
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
        elapsedMs: Date.now() - startedAt,
        created: new Date().toISOString(),
        appVersion: opts.appVersion,
        scores,
        markdown: replaceSheetPlaceholders(rawMarkdown, req.key, available),
        timeline,
        citations,
        inputs: {
          episodes: selected.map((r) => r.episode),
          shots: selected.reduce((n, r) => n + r.shots.length, 0),
          sheets: images.length,
          dialogueLines: selected.reduce((n, r) => n + (r.transcript?.segments.length ?? 0), 0),
        },
        ...(str(record.spoiler) ? { spoiler: replaceSheetPlaceholders(str(record.spoiler), req.key, available) } : {}),
        ...(caveats.length > 0 ? { caveats } : {}),
      }

      opts.reviewStore.write(review)
      return { review, cached: false }
    },
  }
}
