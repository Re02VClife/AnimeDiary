/**
 * core/voice-clips — 角色语音片段的纯逻辑（无网络、无 ffmpeg、无 React）
 *
 * 「抓角色原声」这条链路里只有两件事是纯计算：
 *   1. 把 ffmpeg 的 silencedetect 输出解析成「人声区间」
 *   2. 从这些区间里挑出够目标时长的一段（默认 ≥30 秒）
 * 二者都放在这里，服务器只负责下载与调用 ffmpeg，界面只负责播放。
 */

export interface SpeechSpan {
  /** 起始秒 */
  start: number;
  /** 结束秒 */
  end: number;
}

export interface SilenceDetectResult {
  /** 音频总时长（秒）；ffmpeg 没报出来就是 null */
  duration: number | null;
  /**
   * 静音之间的「人声区间」，按时间升序。
   *
   * 没有静音标记时给出整段 [0, duration] —— 整段都是人声（或 ffmpeg 判定不出静音），
   * 这时仍然可用，不该当成「一个片段都没有」。
   */
  spans: SpeechSpan[];
}

/** 短于这个时长的段基本都是气声、转场音或半截呼吸声，拼进来只会让听感更碎 */
export const MIN_SPEECH_SPAN = 0.7;

/**
 * 解析 ffmpeg `-af silencedetect=...` 的 stderr。
 *
 * 之所以单独拆出来：这段输出是**非结构化文本**，而解析错一位就会把整段
 * BGM 当成台词拼进结果里，是这条链路里最需要单测兜住的地方。
 */
export function parseSilenceDetect(output: string): SilenceDetectResult {
  const text = String(output ?? '');

  // Duration 行可能有多条（多输入时），取第一条：我们只喂一个输入
  const durationMatch = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(text);
  const duration = durationMatch
    ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
    : null;

  const starts: number[] = [];
  for (const m of text.matchAll(/silence_start:\s*(-?[\d.]+)/g)) starts.push(Number(m[1]));

  const ends: number[] = [];
  for (const m of text.matchAll(/silence_end:\s*([\d.]+)/g)) ends.push(Number(m[1]));

  // 末尾那截没有 silence_end 时，用总时长兜底；总时长也没有就退到最后一个已知时间点
  const tail = duration ?? ends[ends.length - 1] ?? starts[starts.length - 1] ?? 0;
  const clamp = (v: number) => Math.max(0, Math.min(v, tail));

  const spans: SpeechSpan[] = [];
  let cursor = 0;
  for (let i = 0; i < starts.length; i++) {
    const start = clamp(starts[i]);
    if (start - cursor >= MIN_SPEECH_SPAN) spans.push({ start: cursor, end: start });
    cursor = clamp(ends[i] ?? tail);
  }
  if (tail - cursor >= MIN_SPEECH_SPAN) spans.push({ start: cursor, end: tail });

  // 一段静音都没检测到：整段当人声
  if (spans.length === 0 && starts.length === 0 && tail >= MIN_SPEECH_SPAN) {
    spans.push({ start: 0, end: tail });
  }

  return { duration, spans };
}

export interface PickedSpans {
  /** 实际要拼接的片段（已按目标时长截断，保持时间先后） */
  spans: SpeechSpan[];
  /** 拼接后总秒数 */
  totalSeconds: number;
  /** 是否凑够了目标时长；false 表示源码本身台词不够长 */
  sufficient: boolean;
}

/** 两个区间重叠部分的长度 */
function overlap(a: SpeechSpan, from: number, to: number): number {
  const left = Math.max(a.start, from);
  const right = Math.min(a.end, to);
  return Math.max(0, right - left);
}

/**
 * 从人声区间里挑出「≥ target 秒」的一段，保持时间先后、尽量连续。
 *
 * 为什么不是简单地从 0 开始顺序累加：很多「台词合集」视频开头是 OP 或标题
 * 旁白，前 30 秒可能是整段音乐。这里先用滑动窗口找出**人声密度最高**的位置，
 * 再从那里往后取 —— 这样既避开开场音乐，拼出来的片段在时间上也挨着，
 * 听感不会忽远忽近。
 */
export function pickSpeechSpans(spans: SpeechSpan[], targetSeconds: number): PickedSpans {
  const target = Math.max(1, Number(targetSeconds) || 0);
  const clean = spans
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end - s.start >= MIN_SPEECH_SPAN)
    .map((s) => ({ start: s.start, end: s.end }));

  if (clean.length === 0) return { spans: [], totalSeconds: 0, sufficient: false };

  // 1) 找最佳起点：以每个片段的起点开窗，取窗口内人声总长最大的那个
  let bestStart = clean[0].start;
  let bestScore = -1;
  for (const candidate of clean) {
    const from = candidate.start;
    const to = from + target;
    let score = 0;
    for (const span of clean) score += overlap(span, from, to);
    // 同分时取更早的起点，保证结果稳定可复现
    if (score > bestScore + 1e-6) {
      bestScore = score;
      bestStart = from;
    }
  }

  // 2) 从最佳起点顺序累加（窗口内不够时自然往后延伸）
  const picked: SpeechSpan[] = [];
  let total = 0;
  for (const span of clean) {
    if (total >= target) break;
    if (span.end <= bestStart) continue;

    const start = Math.max(span.start, bestStart);
    const remaining = target - total;
    const length = span.end - start;
    if (length <= 0) continue;

    if (length > remaining) {
      picked.push({ start, end: start + remaining });
      total = target;
      break;
    }
    picked.push({ start, end: span.end });
    total += length;
  }

  return {
    spans: picked,
    totalSeconds: Number(total.toFixed(2)),
    sufficient: total >= target - 0.05,
  };
}

/** Windows 保留名，用作目录名会创建失败 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * 角色名 → 安全的目录名（音频落在 audio/{角色名}/ 下）。
 *
 * 与 server 的 isSafePathSegment 不同：这里**不拒绝**含特殊字符的名字，
 * 而是替换掉 —— 角色名带「・」「：」「？」很常见，拒绝会让功能用不了。
 */
export function sanitizeVoiceName(name: string): string {
  const cleaned = String(name ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    // 结尾的点和空格在 Windows 上会被悄悄吃掉，导致两次写入落到不同文件
    .replace(/[. ]+$/, '');

  if (!cleaned) return '未命名';
  return WINDOWS_RESERVED.test(cleaned) ? `_${cleaned}` : cleaned;
}

/** 秒数 → `m:ss`（只用于界面展示） */
export function formatClipDuration(seconds: number): string {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}
