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
  /** 维度名，沿用模板里的叫法（剧情 / 作画 / 声音 / 制作 / 沉浸 / 人设 / 深度 / 电波 …） */
  dimension: string
  /** 0–10，允许一位小数 */
  value: number
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
  /** 本次消耗的 token（含图片） */
  tokens: number
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
  /** 最大图数（一张图 ≈ 233 token，但更吃上下文）；默认按集数自适应 */
  maxSheets?: number
}

/** 生成结果 */
export interface ReviewResponse {
  ok: boolean
  review?: AiReview
  error?: string
  /** 已存在且未 force 时为 true，前端据此提示"这是缓存的结果" */
  cached?: boolean
}
