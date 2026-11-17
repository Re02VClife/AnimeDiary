/**
 * core/review-types — AI 影评的数据模型
 *
 * 和 `core/types.ts` 的 WatchReport 是两层东西：
 *   - WatchReport 是**客观测量**（镜头在哪、有几刀、台词是什么），可复核、可重算
 *   - AiReview 是**主观评论**（AI 怎么看这部片），不可复核、有立场、会变
 * 所以两者分开存：报告进 `watch-reports/`，影评进 `ai-reviews/`，
 * 而且**报告可以重新生成，影评不应该被静默覆盖**（要能对比过去说过什么）。
 *
 * 三条设计约束（都来自产品判断，不是技术偏好）：
 *
 * 1) **AI 的分数和用户的分数是两个东西**。`AiDimensionScore` 只活在影评里，
 *    永远不写入 Excel —— Excel 是用户的评分表，AI 分混进去会污染排名与偏好画像。
 * 2) **评分必须有理由和证据**。`reason` 必填，`evidence` 给时间码；
 *    拿不出证据的分数宁可不给（前端会标「无证据」）。
 * 3) **论点必须可定位**。`timeline` 里每条都带 `episode + t`，
 *    点击能跳回那一集的分镜图 —— 这是"影评"和"水文"的分界线。
 */

/** 影评覆盖的范围 */
export type ReviewScope =
  | { kind: 'series' }
  | { kind: 'episode'; episode: number }

/** AI 给某个维度的评分 */
export interface AiDimensionScore {
  /** 维度名，沿用模板里的叫法（剧情 / 作画 / 音声 / 制作 / 沉浸 / 人设 / 深度 / 电波 …） */
  dimension: string
  /**
   * 0–10，允许一位小数；`null` = 模型明确表示"这个维度无从判断"。
   *
   * 为什么允许 null：八维里有些维度（尤其音声/沉浸）可能连间接证据都没有。
   * 以前只能"不给这一项"，UI 看起来像漏了；现在让模型如实给 null + 理由，
   * 前端显示「未评」而不是一个编出来的分。
   */
  value: number | null
  /**
   * 这个分的证据强度：
   *   - `direct`：有直接证据（画面/台词/配乐测量值支持）
   *   - `inferred`：从其它维度间接推的（例如没有音频，按镜头节奏推"沉浸"）
   *   - `none`：拿不出证据，只给了 null
   *
   * 面板要区分显示 —— 用户得知道哪几个点是 AI 真看了、哪几个是推的。
   */
  confidence?: 'direct' | 'inferred' | 'none'
  /** 为什么给这个分（一句话，必须具体，不许"整体不错"） */
  reason: string
  /**
   * 支撑证据：第几集第几秒。
   * 空数组 = 这个维度 AI 没找到证据 —— 前端要如实标出来，不要假装有。
   */
  evidence: Array<{ episode: number; t: number; note?: string }>
}

/** 时间轴上的一个论点 */
export interface ReviewTimelineItem {
  /** 第几集，从 1 开始 */
  episode: number
  /** 秒 */
  t: number
  /** 这条时间点说了什么（一句话） */
  text: string
  /** 关联的镜头序号（对应那一集报告的 shots[i]），有就能跳转 */
  shot?: number
}

/** 影评引用的一张分镜图 */
export interface ReviewCitation {
  episode: number
  /** 那一集报告里的 sheet 文件名，例如 `ep01.png` */
  sheet: string
  /** 第几格；不填表示整张图 */
  cell?: number
}

/** 生成这次影评时用到的输入摘要（复盘用：为什么这次说得比上次多） */
export interface ReviewInputs {
  /** 分析了哪几集 */
  episodes: number[]
  /** 一共看了多少个镜头 */
  shots: number
  /** 一共看了多少张宫格图 */
  sheets: number
  /** 台词条数（有字幕才有） */
  dialogueLines: number
}

/** 本次调用的 token 分项。老记录只有 `tokens` 总数，读出来时按总数兜底。 */
export interface AiReviewUsage {
  /** 输入（含分镜图，图片 token 算在这里） */
  promptTokens: number
  /** 输出（正文 + JSON 结构） */
  completionTokens: number
  /** 推理模型的思维链 token（有的 provider 才算得出来） */
  reasoningTokens?: number
  totalTokens: number
}

export interface AiReview {
  /** 结构版本；改了字段就 +1，旧记录读出来要能判断"要不要重跑" */
  schema: 1
  /** `模板::标题` */
  key: string
  scope: ReviewScope
  /** 生成用的模型名（换模型后分数会变，必须记下来） */
  model: string
  /** 提示词版本（改了提示词就等于换了把尺子，同样要记） */
  promptVersion: string
  /** 本次消耗的 token（含图片）。2026-11-16 起同时有 `usage` 分项，这个字段保留兼容 */
  tokens: number
  /** token 分项（输入/输出/思维链）。老记录没有，前端要能只看 tokens */
  usage?: AiReviewUsage
  /** 本次生成耗时（毫秒）；历史记录里读出来可以显示"这篇花了多久" */
  elapsedMs?: number
  created: string
  appVersion: string
  /** AI 的维度评分；和用户评分**并排展示**，但不合并 */
  scores: AiDimensionScore[]
  /** 影评正文（Markdown）：可以插图 `![](/api/watch/sheet?...)`、带 `[mm:ss]` */
  markdown: string
  /** 时间轴论点 */
  timeline: ReviewTimelineItem[]
  /** 正文/时间轴引用到的分镜 */
  citations: ReviewCitation[]
  inputs: ReviewInputs
  /** 剧透段落（涉及结局/反转的内容），前端默认折叠 */
  spoiler?: string
  /** 生成时模型自报的不确定性，例如「只看过 3 集，样本不足」 */
  caveats?: string[]
}

/** 生成请求 */
export interface ReviewRequest {
  key: string
  scope: ReviewScope
  /**
   * 用户自己的上下文，由前端从 AnimeContext 取好传进来。
   *
   * 为什么不让后端自己去读 Excel：读 Excel 是渲染进程的既有链路
   * （`excel-service` → `AnimeContext`），服务端没有那份数据；
   * 而且"用户评了多少分"本来就是我们想喂给模型的**锚点**，
   * 让前端显式传，比后端猜更清楚。
   */
  userContext?: ReviewUserContext
  options?: ReviewOptions
}

/** 用户的既有判断 —— 给 AI 当锚点，让它输出"差异"而不是绝对分 */
export interface ReviewUserContext {
  /** 番名（模板里的标题） */
  title: string
  /** 用户自己的维度评分：维度名 → 0–10 */
  scores?: Record<string, number>
  /**
   * 维度定义（模板里每个维度的 `description`），维度名 → 一句话说明。
   *
   * 为什么必须传：光给「电波 / 沉浸 / 制作」这几个词，模型只能猜它们指什么
   * （实测「电波」被理解成"对不上频道"，而用户的实际定义是"看完的第一印象总分"）。
   * 有了定义，模型才知道「沉浸」= 音乐、画面、分镜、剧情协同度。
   */
  dimensionHints?: Record<string, string>
  /** 用户写的评价正文 */
  review?: string
  /** 用户打的标签 */
  tags?: string[]
  /** Bangumi 社区分（可选，优先级低于用户自己的分） */
  bangumiScore?: number
  /** 已看集数 / 总集数 */
  watchedEpisodes?: number
  totalEpisodes?: number
}

export interface ReviewOptions {
  /** 只分析这些集；不传 = 用已经分析过的全部集 */
  episodes?: number[]
  /**
   * 是否重新生成。默认 false：已有同 promptVersion + model 的结果直接返回，
   * 避免"点两次扣两次钱"。
   */
  force?: boolean
  /** 预算上限（token），默认 200 万 */
  budget?: number
  /** 最大图数：默认 100，上限 1000（推荐 100–500）。整部番时按集数平分 */
  maxSheets?: number
  /**
   * 生成方式（2026-11-17 新增）：
   * - `auto`（默认）：多集且总图数 > 60 时自动分集（fanout）
   * - `single`：一次调用把整季图 + 报告全发过去（快，但图多会撑请求体）
   * - `fanout`：每集一个子任务（只看这一集的图），最后只把文字小结合成整季影评
   */
  mode?: 'auto' | 'single' | 'fanout'
  /**
   * 盲评（默认 `true`）：不把用户评分 / 点评发给 AI。
   *
   * 2026-11-17 用户要求：带着用户分生成时，AI 曲线几乎贴着用户曲线 ——
   * 那不是判断，是复述。想看"AI vs 你"的对比仍然可以（对比在前端做），
   * 但**生成时**不给它看。
   */
  blind?: boolean
}

/** 生成结果 */
export interface ReviewResponse {
  ok: boolean
  review?: AiReview
  error?: string
  /** 已存在且未 force 时为 true，前端据此提示"这是缓存的结果" */
  cached?: boolean
}
