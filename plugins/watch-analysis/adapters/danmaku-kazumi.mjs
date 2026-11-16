/**
 * adapters/danmaku-kazumi.mjs — 读 Kazumi 下载的弹幕，聚合成"观众反应"时间轴
 *
 * Kazumi 把一集存成 `<番剧>/<集号>/` 下有 `playlist.m3u8` + `seg_*.ts` + `danmaku.json`，
 * 而合并后的 mp4 通常在番剧根目录（`01.mp4`）——所以**不能只按视频同目录找**，
 * 要顺着集号去子目录里找。
 *
 * 弹幕长这样（B 站格式）：
 *   {"danDanBangumiID":19308,"danmakus":[{"m":"可怕的压迫感","p":"1271.15,1,16777215,e10f7409"}]}
 *   p = "秒,类型,颜色,用户hash" —— 第一个字段就是时间戳。
 *
 * 为什么值得花 token 读：弹幕是**观众在那一刻的真实反应**，
 * "这里崩了/这段封神/笑死"这种信息，画面和台词都给不了。实测 4450 条弹幕里
 * 高信息量的几乎都集中在剧情转折和演出爆发点上，正好可以当影评的"观众视角"证据。
 *
 * 但 4450 条全给模型太贵（约 30 万字符）。所以按时间桶聚合：
 * 每 15 秒一桶，每桶只留最多 5 条"有信息量"的，桶里只有 1-2 条的直接丢掉。
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'

/** 时间桶宽度（秒）：15 秒一桶，24 分钟约 96 桶 */
const BUCKET_SECONDS = 15
/** 每桶最多保留几条 */
const SAMPLES_PER_BUCKET = 5
/** 少于这么多条的桶视为"没人看"，不产生信息 */
const MIN_BUCKET_COUNT = 3
/** 单条弹幕的长度上限（超过基本是刷屏或复制粘贴） */
const MAX_TEXT_LENGTH = 40

/**
 * 在视频附近找弹幕文件。
 *
 * 三种可能的位置，按优先级：
 *   1. 视频同目录 `danmaku.json`
 *   2. 视频名里的数字 = 集号 → `<dir>/<集号>/danmaku.json`（合并后 mp4 在根目录的情况）
 *   3. `<dir>/<去零集号>/danmaku.json`（01.mp4 → 1/danmaku.json）
 */
export async function findDanmakuFile(videoFile) {
  const dir = path.dirname(videoFile)
  const baseName = path.basename(videoFile, path.extname(videoFile))
  const digits = baseName.match(/\d+/)?.[0]
  const candidates = [path.join(dir, 'danmaku.json')]
  if (digits) {
    candidates.push(path.join(dir, digits, 'danmaku.json'))
    const unpadded = String(Number(digits))
    if (unpadded !== digits) candidates.push(path.join(dir, unpadded, 'danmaku.json'))
  }
  for (const candidate of candidates) {
    try {
      const raw = await readFile(candidate, 'utf8')
      if (raw.trim().startsWith('{')) return { file: candidate, raw }
    } catch {
      // 不存在就试下一个
    }
  }
  return null
}

/** `96.0,1,16777215,abc` → 96.0；解析不出来返回 NaN */
function parseTime(p) {
  const first = String(p ?? '').split(',')[0]
  const t = Number(first)
  return Number.isFinite(t) ? t : Number.NaN
}

/**
 * 一条弹幕值不值得给模型看。
 *
 * 过滤掉：纯标点/单字（"？"、"哈"）、刷屏（超长、重复字符）、以及纯表情符号。
 * 这类占了弹幕总量的很大一部分，但信息量接近零。
 * 另外还有一类必须清零：**新番群广告**（"交流群1047615969 欢迎加入（打扰致歉）"），
 * 实测每集开头都会刷几十条，占了前 15 秒那个桶的绝大多数。
 */
function scoreText(text) {
  const trimmed = String(text ?? '').trim()
  if (trimmed.length < 2 || trimmed.length > MAX_TEXT_LENGTH) return 0
  // 纯符号/纯标点
  if (!/[\u4e00-\u9fa5a-zA-Z0-9]/.test(trimmed)) return 0
  // 群广告：含「群/交流/欢迎加入/打扰致歉」且有 5 位以上数字（群号）
  if (/(群|交流|同好|欢迎加入|打扰|致歉)/.test(trimmed) && /\d{5,}/.test(trimmed)) return 0
  if (/^[\d\s,，。.!！]+$/.test(trimmed)) return 0
  // 单字符重复（"哈哈哈哈"、"？？？？"）保留短一点的，太长的丢掉
  const unique = new Set(trimmed).size
  if (unique <= 2 && trimmed.length > 6) return 0
  // 有数字/标点的更可能是具体评论（"21:11 这段" / "第4集神ED"）
  let score = Math.min(trimmed.length, 20)
  if (/[0-9]/.test(trimmed)) score += 6
  if (/[，。！？、；：]/.test(trimmed)) score += 3
  if (unique >= 5) score += 4
  return score
}

/**
 * 把弹幕聚合成时间桶。
 *
 * @param {Array<{ m: string, p: string }>} list
 * @param {{ bucketSeconds?: number, duration?: number }} opts
 * @returns {{ total: number, buckets: Array<{ t: number, count: number, samples: string[] }> }}
 */
export function aggregateDanmaku(list, { bucketSeconds = BUCKET_SECONDS, duration = 0 } = {}) {
  const items = []
  for (const entry of Array.isArray(list) ? list : []) {
    const t = parseTime(entry?.p)
    const text = String(entry?.m ?? '').trim()
    if (!Number.isFinite(t) || t < 0) continue
    if (duration > 0 && t > duration + 5) continue // 弹幕时间超出片长（有些集的时间轴对不上）就丢
    const score = scoreText(text)
    if (score <= 0) continue
    items.push({ t, text, score })
  }

  const buckets = new Map()
  for (const item of items) {
    const key = Math.floor(item.t / bucketSeconds)
    if (!buckets.has(key)) buckets.set(key, { t: key * bucketSeconds, items: [] })
    buckets.get(key).items.push(item)
  }

  const out = []
  for (const bucket of [...buckets.values()].sort((a, b) => a.t - b.t)) {
    if (bucket.items.length < MIN_BUCKET_COUNT) continue
    // 按信息量取前 N，去掉重复文案（同一句话被不同人刷 20 遍只需要一条）
    const seen = new Set()
    const samples = []
    for (const item of bucket.items.sort((a, b) => b.score - a.score)) {
      const key = item.text.slice(0, 8)
      if (seen.has(key)) continue
      seen.add(key)
      samples.push(item.text)
      if (samples.length >= SAMPLES_PER_BUCKET) break
    }
    out.push({ t: bucket.t, count: bucket.items.length, samples })
  }

  return { total: items.length, buckets: out }
}

/**
 * 读一集的弹幕并聚合。找不到文件时返回 null（不是错误：很多番没有弹幕）。
 *
 * @param {string} videoFile 视频绝对路径
 * @param {{ duration?: number }} opts
 * @returns {Promise<{ total: number, file: string, buckets: Array<{ t: number, count: number, samples: string[] }> } | null>}
 */
export async function readDanmaku(videoFile, { duration = 0 } = {}) {
  if (!videoFile) return null
  const found = await findDanmakuFile(videoFile)
  if (!found) return null
  let parsed
  try {
    parsed = JSON.parse(found.raw)
  } catch {
    return null
  }
  const list = Array.isArray(parsed?.danmakus) ? parsed.danmakus : []
  if (list.length === 0) return null
  const aggregated = aggregateDanmaku(list, { duration })
  return {
    total: aggregated.total,
    rawTotal: list.length,
    file: path.basename(found.file),
    buckets: aggregated.buckets,
  }
}

export default { findDanmakuFile, aggregateDanmaku, readDanmaku }
