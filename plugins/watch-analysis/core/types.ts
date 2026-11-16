/**
 * plugins/watch-analysis/core/types — 拉片分析的数据模型
 *
 * 这一层是**纯类型**：没有 IO、没有第三方依赖、不 import 任何 server/src。
 * 所有 Port、adapter、runtime、UI 都只认这里的形状 —— 这是"换引擎不改上层"的前提。
 *
 * 命名约定（和 dsh-video-storyboard 保持一致，减少两边的翻译成本）：
 *   - 时间一律用**秒**（number），帧号只出现在需要精确对齐的地方
 *   - 一段 = 一个镜头，`Shot.i` 是它在整集里的序号（从 0 开始）
 *   - tier 是格子档位（边长 1/tier，1..8），由切点密度算出来，不是用户传的
 */

/** 一集视频的来源描述。file 是绝对路径，video 由本地番剧库给。 */
export interface VideoRef {
  /** 本地番剧库的 key：`模板::标题` */
  animeKey: string
  /** 第几集，从 1 开始（与 UI 显示一致） */
  episode: number
  /** 绝对路径 */
  file: string
  duration: number
  fps: number
  width: number
  height: number
}

/** 一次切点。t 是切点发生的秒数，score 是引擎自己的分数（不同引擎不可直接比大小）。 */
export interface Cut {
  t: number
  score: number
  /** 引擎标识，用于 A/B 对比时区分 */
  engine: string
}

/**
 * 一个镜头。
 *
 * `start`/`end` 是**半开区间** [start, end)，所以 `end - start` 就是时长，
 * 相邻镜头首尾相接、不重叠、不留缝 —— 这条不变量由 runtime 校验。
 */
export interface Shot {
  /** 整集内的序号，从 0 开始 */
  i: number
  start: number
  end: number
  /** 该镜头是否由"积分采样"补出来的（不是真切点） */
  sampled: boolean
  /** 格子档位 1..8；Phase 1 由 render adapter 回填，规划阶段为 1 */
  tier: number
  /** 这一格时间范围内的台词（storyboard 的 alignCells 结果），可能为空 */
  text?: string
}

/** 一条台词/字幕。时间同样用秒。 */
export interface Segment {
  start: number
  end: number
  text: string
  /** 来源标识，写进报告时要说清楚"这是 ASR 转的，可能有错字" */
  source: string
  /**
   * 说话人编号（`S01` / `S02`…），只有带**说话人分离**的 ASR 才有。
   * 外挂字幕文件没有这个字段 —— 不要为了填它去猜，空着比编错强。
   */
  speaker?: string
}

/** 单镜头的动感测量 */
export interface ShotMotion {
  shot: number
  /** 镜头内逐帧变化分的均值（0–255 口径，和 dsh-see-now 一致） */
  mean: number
  /** 峰值 */
  peak: number
  /** 是否达到"逐帧都有新画"的密度（粗估一拍一/二用） */
  dense: boolean
}

/** 配乐证据。measurements 与 inferred 必须分开 —— 后者是模型推的，不是测出来的。 */
export interface MusicEvidence {
  from: number
  to: number
  /** 测量值：可被第三方复核 */
  measurements: {
    tempo?: number
    beatCount?: number
    loudness?: number
    rms?: number
    onsetRate?: number
    /** 声学变化边界（秒），是测量，不是"这里是副歌" */
    boundaries?: number[]
  }
  /** 推断值：引擎自己标的候选，报告里必须标注"推测" */
  inferred?: {
    tags?: string[]
    instruments?: string[]
    vocal?: boolean
  }
}

/** 拼好的一张宫格图 */
export interface Sheet {
  /**
   * **相对本集图片目录**的文件名，例如 `ep01.png` / `ep01-2.png`。
   * 取图时传 `/api/watch/sheet?key=&episode=&file=`，服务端会拼到
   * `{DATA_DIR}/watch-reports/{key}/{episode 的图目录}/` 下面并挡掉目录穿越。
   */
  file: string
  width: number
  height: number
  /** 这张图里放了几帧 */
  cells: number
  /** 每格在整集里对应的镜头序号，顺序即格子顺序（DP 装箱可能重排，这里给回映射） */
  shots: number[]
}

/** token 账本 */
export interface BudgetLedger {
  limit: number
  spent: number
  byKind: Record<string, number>
  /** 预占但还没结算的量，用于并发调用时不超卖 */
  reserved: number
  /** 已经熔断（花超或显式中止） */
  exhausted: boolean
}

/** 一次任务的阶段。UI 的进度条读这个。 */
export type WatchPhase =
  | 'queued'
  | 'probe'
  | 'scan'
  | 'render'
  | 'danmaku'
  | 'transcript'
  | 'motion'
  | 'music'
  | 'analyze'
  | 'done'
  | 'cancelled'
  | 'failed'

export interface WatchJobStatus {
  jobId: string
  phase: WatchPhase
  /** 0–100；未知时为 -1 */
  percent: number
  message: string
  /** 已经花掉的 token，UI 实时显示 */
  spent: number
  error?: string
}

/** 弹幕聚合的一个时间桶（观众反应） */
export interface DanmakuBucket {
  /** 桶起始时间（秒） */
  t: number
  /** 这个桶里有多少条有效弹幕 */
  count: number
  /** 代表弹幕（已去重、已过滤广告与刷屏） */
  samples: string[]
}

/**
 * 一集的弹幕摘要。
 *
 * 为什么值得占报告空间：弹幕是**观众在那一刻的真实反应**，
 * 「这里崩了 / 这段封神 / 横谷昌宏又来 / 角色设计是别当欧尼酱的」这类信息，
 * 画面和字幕都给不了。Kazumi 下载缓存自带 `danmaku.json`，零成本可得。
 */
export interface DanmakuSummary {
  /** 过滤后的有效弹幕条数 */
  total: number
  /** 原始条数 */
  rawTotal?: number
  /** 来源文件名 */
  file: string
  buckets: DanmakuBucket[]
}

/** 落盘的完整报告 */
export interface WatchReport {
  /** schema 版本：将来改结构时用来判断要不要迁移 */
  schema: 1
  key: string
  episode: number
  video: Omit<VideoRef, 'animeKey' | 'episode'>
  /** 每个环节实际用的后端，写进报告让人知道这份结果是谁算的 */
  engine: {
    storyboard: string
    cut: string
    transcript: string
    motion: string
    music: string
  }
  shots: Array<Shot & { motion?: ShotMotion; cell?: { sheet: number; x: number; y: number } }>
  cuts: Cut[]
  /** 弹幕摘要（Kazumi 下载缓存自带 danmaku.json，没有就是 undefined） */
  danmaku?: DanmakuSummary
  transcript?: {
    source: string
    segments: Segment[]
    /** 引擎自报的不可信项，例如 `cuts unreliable here` */
    notes?: string[]
    /** 识别到的说话人数量。只有做了说话人分离的引擎会给（外挂字幕没有） */
    speakers?: number
  }
  motion?: {
    /** 整集折线：[秒, 变化分] */
    curve: Array<[number, number]>
    perShot: number[]
  }
  /**
   * 音轨响度（EBU R128），来自 storyboard 的 audio 条。
   *
   * 它和 `audio`（配乐证据）是**两件事**：
   *   - loudness 是"这一集有多大声"的原始测量，谁都能复核
   *   - audio 是"这段是不是音乐、什么调式"的推断，需要 MEE
   * Phase 1 只有前者；Phase 4 接 MEE 之后两者都有。
   */
  loudness?: {
    mean: number
    peak: number
    /** 每 step 秒一个采样，单位 LUFS */
    series: number[]
    step: number
    /** 静音区间（秒） */
    silences: Array<[number, number]>
  }
  /** 这次排版实际用的参数，写进报告便于"同样一集下次要多久/多少图"的复盘 */
  render?: {
    strategy: string
    sheets: number
    frames: number
    fill: number
    canvas: { width: number; height: number }
    tiers: Record<string, number>
  }
  audio?: {
    windows: MusicEvidence[]
  }
  sheets: Sheet[]
  report?: {
    markdown: string
    model: string
    tokens: number
    at: string
  }
  budget: BudgetLedger
  timing: {
    total: number
    probe?: number
    scan?: number
    render?: number
    danmaku?: number
    transcript?: number
    motion?: number
    music?: number
    analyze?: number
  }
  /** 生成这一份时的时间与软件版本，便于排查"旧报告为什么长这样" */
  created: string
  appVersion: string
  /** 引擎警告：不致命但要让人知道的分析局限（例如「连续运镜导致切点数不可信」） */
  notes?: string[]
}

/** 引擎就绪状态。所有 Provider 都返回它，缺依赖时**不抛错**，让 pipeline 降级。 */
export interface ReadyState {
  ok: boolean
  /** ok=false 时必填：缺什么、怎么补 */
  reason?: string
  /** 给 UI 的补充说明（版本号、路径等） */
  detail?: string
}
