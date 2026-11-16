/**
 * server/review-fanout — 分集子任务 + 汇总的 prompt 与解析
 *
 * 为什么需要它：整季影评把「所有集的图 + 所有集的报告」塞进**一次**调用。
 * 6 集 × 18 张 = 108 张图，请求体近 30MB、输入 9 万 token —— 上下文没爆，但
 * 上传/prefill 很慢，而且模型要在一口气里兼顾 6 集，容易写成流水账。
 *
 * 改成「每集一个子任务」后：
 *   1. 每集单独调用（只看这一集的 12–100 张图 + 这一集的报告），产出结构化小结；
 *   2. 最后只把 N 份**文字小结**（不带图）交给汇总调用，生成整季影评。
 * 好处：单请求上下文小、可复用缓存、某一集失败只丢那一集；
 * 代价：调用次数 = 集数 + 1，token 总量通常更高（每集都要重新描述一遍画面）。
 *
 * 这个文件只放**纯函数**（prompt 构建 + 解析），不碰 fs/网络 —— 便于单测。
 */

/** 单集小结（子任务的产物；只保留汇总需要的字段，避免上下文膨胀） */
export interface EpisodeBrief {
  episode: number
  /** 3–6 条，每条以 [mm:ss] 开头 */
  points: string[]
  /** 只评有把握的维度（听不到音频就不评音声） */
  scores: Array<{ dimension: string; value: number; reason?: string }>
  /** 0–3 条可引用的原话 */
  quotes: string[]
  /** 看不清/听不到的地方 */
  caveats: string[]
}

/** 秒 → mm:ss（和 review.ts 的 clock 同一口径，这里独立一份避免循环依赖） */
function clock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const mm = Math.floor(total / 60)
  const ss = total % 60
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

export interface BriefPromptInput {
  title: string
  episode: number
  duration: number
  shots: number
  cuts: number
  sheetCount: number
  /** 镜头时间码（已截断到前 40 个） */
  shotLines: string[]
  /** 台词行（已抽样，含 [mm:ss] 与 S01 编号） */
  dialogueLines: string[]
  /** 弹幕行（已抽样） */
  danmakuLines: string[]
  userScores: string
}

const BRIEF_SYSTEM = [
  '你是一位资深的动画评论者，正在为一部番剧的**单集**做分析。',
  '',
  '你只负责这一集，输出一份给「整季汇总」用的结构化小结。铁律：',
  '1. **points 每条都要带时间码**，写清"发生了什么/为什么重要"，不要空话。',
  '2. **只评你有把握的维度**：听不到音频就不要评音声/沉浸；看不清作画就不要评作画。',
  '   没把握的维度**直接不写**，比编一个分数好得多。',
  '3. **quotes 是可引用的原话**（台词/弹幕），标明来源；没有就空数组。',
  '4. **caveats 老实写**你看不清/听不到的东西。',
  '5. 不要写完整影评正文 —— 汇总那一步会写。你只提供素材。',
  '',
  '输出必须是 JSON，不要任何解释文字。',
].join('\n')

/**
 * 单集小结的 prompt。
 *
 * 刻意**不**给整季的镜头/台词/弹幕，只给这一集 —— 这就是"子代理只看一集"的边界。
 */
export function buildEpisodeBriefPrompt(input: BriefPromptInput): { system: string; prompt: string } {
  const prompt = [
    `【作品】${input.title}`,
    `【这一集】E${input.episode}（时长 ${clock(input.duration)}，${input.shots} 个镜头，${input.cuts} 个切点，分镜图 ${input.sheetCount} 张）`,
    '',
    '【用户自己的维度评分 —— 你的锚点】',
    input.userScores,
    '',
    '【镜头时间码（节选）】',
    ...(input.shotLines.length > 0 ? input.shotLines : ['  （没有镜头数据）']),
    '',
    ...(input.dialogueLines.length > 0
      ? [
          '【台词（字幕文件或本地 ASR，同音字可能有错）】',
          '`S01`/`S02` 是说话人编号，**编号本身不是角色名**，不要自己把编号和角色对上号。',
          ...input.dialogueLines,
          '',
        ]
      : []),
    ...(input.danmakuLines.length > 0
      ? [
          '【观众弹幕（按时间，已过滤广告/刷屏）】',
          '这是**真实观众**的反应，引用时要写清楚"弹幕在说"，不要当成你自己的判断。',
          ...input.danmakuLines,
          '',
        ]
      : []),
    '【输出 JSON 结构】',
    '{',
    '  "episode": ' + input.episode + ',',
    '  "points": ["[12:34] 这一段的落幅把前面的伏笔收掉了", "..."],',
    '  "scores": [{ "dimension": "剧情", "value": 8.6, "reason": "一句话理由" }],',
    '  "quotes": ["原话/弹幕原句"],',
    '  "caveats": ["听不到音频，音声未评"]',
    '}',
    '',
    'points 给 3–6 条；scores 只给你有把握的维度；quotes 0–3 条；caveats 0–3 条。',
    '维度名只能用用户已经打过分的那几个（见上），不要新增或改名。',
  ].join('\n')

  return { system: BRIEF_SYSTEM, prompt }
}

/** 解析单集小结。解析不出来返回 null（调用方记一条失败，不中断整季）。 */
export function parseEpisodeBrief(text: string, episode: number): EpisodeBrief | null {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return null
  let raw: unknown
  try {
    raw = JSON.parse(match[0])
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>

  const points = Array.isArray(record.points)
    ? record.points.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : []
  const quotes = Array.isArray(record.quotes)
    ? record.quotes.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : []
  const caveats = Array.isArray(record.caveats)
    ? record.caveats.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : []

  const scores: EpisodeBrief['scores'] = []
  if (Array.isArray(record.scores)) {
    for (const item of record.scores) {
      if (!item || typeof item !== 'object') continue
      const entry = item as Record<string, unknown>
      const dimension = typeof entry.dimension === 'string' ? entry.dimension.trim() : ''
      const value = Number(entry.value)
      if (!dimension || !Number.isFinite(value)) continue
      scores.push({
        dimension,
        value: Math.max(0, Math.min(10, value)),
        ...(typeof entry.reason === 'string' && entry.reason.trim() ? { reason: entry.reason.trim() } : {}),
      })
    }
  }

  // 一条素材都没有就当失败，避免把空小结喂给汇总
  if (points.length === 0 && scores.length === 0) return null

  return {
    episode,
    points: points.slice(0, 8),
    scores,
    quotes: quotes.slice(0, 4),
    caveats: caveats.slice(0, 4),
  }
}

export interface SeriesSummaryInput {
  title: string
  episodeRange: string
  briefs: EpisodeBrief[]
  /** 用户维度分（"剧情 8 / 作画 7.9"） */
  userScores: string
  /** 整季统计（镜头数、图数、集数） */
  stats: { episodes: number; shots: number; sheets: number }
  /** 用户写的评价（截断） */
  userReview?: string
  /** 集号列表，用于告诉模型时间轴只能引用这些集 */
  episodes: number[]
  /** 用户模板的维度（汇总时只许用这几个） */
  dimensions: string[]
}

const SUMMARY_SYSTEM = [
  '你是一位资深的动画评论者，正在为个人番剧记录应用写一篇**整季**影评。',
  '',
  '你手上没有分镜图，只有**每一集的分析小结**（points / 初评 / 引用）。所以：',
  '1. **不要假装看过画面**。能跨集归纳的是结构、节奏、人物弧线、制作水准的走向；',
  '   需要具体画面佐证时，引用小结里已有的时间码，不要自己编画面细节。',
  '2. **每个判断都要能指到具体集数和时间码**。说不出的不要写。',
  '3. **你的评分和用户评分是两回事**：明确说出你在哪些地方不同意他。',
  '4. **不要写成"第 1 集讲了…第 2 集讲了…"的流水账**。整季影评要回答：',
  '   这部剧的骨架是什么、哪几集是支点、它的毛病是不是结构性的。',
  '5. 正文不超过 1200 字；timeline 6–10 条；每个维度 reason 不超过 40 字。',
  '',
  '输出必须是 JSON，不要任何解释文字。',
].join('\n')

/** 汇总 prompt：输入只有文字小结，没有图 —— 这正是"避免上下文爆满"的关键。 */
export function buildSeriesSummaryPrompt(input: SeriesSummaryInput): { system: string; prompt: string } {
  const briefLines: string[] = []
  for (const brief of input.briefs) {
    const lines: string[] = [`E${brief.episode}：`]
    for (const point of brief.points.slice(0, 6)) lines.push(`  · ${point}`)
    if (brief.scores.length > 0) {
      lines.push(`  · 本集初评：${brief.scores.map((s) => `${s.dimension} ${s.value}`).join(' / ')}`)
    }
    if (brief.quotes.length > 0) lines.push(`  · 引用：${brief.quotes.slice(0, 3).join(' | ')}`)
    if (brief.caveats.length > 0) lines.push(`  · 注意：${brief.caveats.join('；')}`)
    briefLines.push(lines.join('\n'))
  }

  const prompt = [
    `【作品】${input.title}`,
    `【范围】${input.episodeRange}（共 ${input.stats.episodes} 集，${input.stats.shots} 个镜头，${input.stats.sheets} 张分镜）`,
    '',
    '【用户自己的判断 —— 你的锚点】',
    `维度评分：${input.userScores}`,
    input.userReview ? `用户写的评价：\n"""\n${input.userReview.slice(0, 1500)}\n"""` : '',
    '',
    '【各集分析小结（子任务产出）】',
    ...briefLines,
    '',
    '【引用格式】',
    '时间码写成 `[mm:ss]`；时间轴只能引用这些集：' + input.episodes.map((ep) => `E${ep}`).join('、'),
    '',
    '【输出 JSON 结构】',
    '{',
    '  "scores": [{ "dimension": "剧情", "value": 8.1, "reason": "一句话说清为什么",',
    '               "evidence": [{ "episode": 1, "t": 754, "note": "具体是什么" }] }],',
    '  "markdown": "整季影评正文（Markdown，1200 字以内，带 [mm:ss] 时间码）",',
    '  "timeline": [{ "episode": 1, "t": 754, "text": "这个时间点发生了什么/说明了什么" }],',
    '  "citations": [],',
    '  "spoiler": "涉及结局/反转的段落，没有就空字符串",',
    '  "caveats": ["总结过程中不确定的地方"]',
    '}',
    '',
    '评分维度**只能是这几个**（一个字都不要改）：' + (input.dimensions.length > 0
      ? input.dimensions.join(' / ')
      : Array.from(new Set(input.briefs.flatMap((brief) => brief.scores.map((s) => s.dimension)))).join(' / ')),
    '0–10 分，允许一位小数；每个分数都必须有 reason，能给出 evidence 就必须给。',
  ].filter((line) => line !== '').join('\n')

  return { system: SUMMARY_SYSTEM, prompt }
}
