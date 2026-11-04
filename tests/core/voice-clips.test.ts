/**
 * core/voice-clips 单元测试
 *
 * 重点覆盖「拼错就会把 BGM/音乐当成台词拼进结果」的地方 ——
 * 静音解析和片段挑选是这条链路里唯一由我们完全掌控的环节，
 * server 那边只是下载和调用 ffmpeg。
 */
import { describe, it, expect } from 'vitest';
import {
  parseSilenceDetect,
  pickSpeechSpans,
  sanitizeVoiceName,
  formatClipDuration,
  MIN_SPEECH_SPAN,
} from '../../core/voice-clips';

/** 真实 ffmpeg 输出的形状（节选） */
function ffmpegOut(duration: string, lines: string[]): string {
  return [
    "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'source.m4a':",
    `  Duration: ${duration}, start: 0.000000, bitrate: 50 kb/s`,
    ...lines,
  ].join('\n');
}

describe('parseSilenceDetect', () => {
  it('把静音之间的区间解析成人声段', () => {
    const output = ffmpegOut('00:04:24.34', [
      '[silencedetect @ 0x1] silence_start: 15.042',
      '[silencedetect @ 0x1] silence_end: 18.105 | silence_duration: 3.063',
      '[silencedetect @ 0x1] silence_start: 42.5',
      '[silencedetect @ 0x1] silence_end: 44.0 | silence_duration: 1.5',
    ]);
    const result = parseSilenceDetect(output);
    expect(result.duration).toBeCloseTo(264.34, 2);
    expect(result.spans).toHaveLength(3);
    expect(result.spans[0]).toMatchObject({ start: 0, end: 15.042 });
    expect(result.spans[1]).toMatchObject({ start: 18.105, end: 42.5 });
    expect(result.spans[2]).toMatchObject({ start: 44.0, end: 264.34 });
  });

  it('末尾的静音（只有 silence_start 没有 end）不会凭空多出一段', () => {
    const output = ffmpegOut('00:00:30.00', ['[silencedetect @ 0x1] silence_start: 12.0']);
    const result = parseSilenceDetect(output);
    // 12 秒之后一直是静音到结尾，所以人声只有开头那一段
    expect(result.spans).toEqual([{ start: 0, end: 12 }]);
  });

  it('一段静音都没有时整段当人声', () => {
    const output = ffmpegOut('00:00:30.00', []);
    const result = parseSilenceDetect(output);
    expect(result.spans).toEqual([{ start: 0, end: 30 }]);
  });

  it('丢掉短于阈值的碎段（气声/转场音）', () => {
    const output = ffmpegOut('00:00:20.00', [
      '[silencedetect @ 0x1] silence_start: 0.2', // 开头人声只有 0.2s，丢弃
      '[silencedetect @ 0x1] silence_end: 0.4',
      '[silencedetect @ 0x1] silence_start: 10.0',
      '[silencedetect @ 0x1] silence_end: 12.0',
    ]);
    const result = parseSilenceDetect(output);
    // [0, 0.2] 短于 0.7 被丢；[0.4, 10] 保留；[12, 20] 保留
    expect(result.spans.map((s) => [s.start, s.end])).toEqual([[0.4, 10], [12, 20]]);
  });

  it('没有 Duration 时退回最后一个已知时间点，不崩', () => {
    const output = ['[silencedetect @ 0x1] silence_start: 5.0', '[silencedetect @ 0x1] silence_end: 8.0'].join('\n');
    const result = parseSilenceDetect(output);
    expect(result.duration).toBeNull();
    expect(result.spans).toEqual([{ start: 0, end: 5 }]);
  });

  it('空输入返回空结果', () => {
    expect(parseSilenceDetect('').spans).toEqual([]);
    expect(parseSilenceDetect(undefined as unknown as string).spans).toEqual([]);
  });
});

describe('pickSpeechSpans', () => {
  it('凑够目标时长就停，最后一段被截断', () => {
    const spans = [
      { start: 0, end: 10 },
      { start: 12, end: 22 },
      { start: 24, end: 34 },
      { start: 36, end: 46 },
    ];
    const picked = pickSpeechSpans(spans, 35);
    expect(picked.sufficient).toBe(true);
    expect(picked.totalSeconds).toBeCloseTo(35, 1);
    expect(picked.spans).toHaveLength(4);
    // 最后一段只取到刚好补满的 5 秒
    expect(picked.spans[3]).toMatchObject({ start: 36, end: 41 });
  });

  it('跳过开场音乐，从人声密集处开始', () => {
    const spans = [
      { start: 0, end: 3 },    // 开场 OP 的尾音
      { start: 60, end: 90 },  // 正片台词
      { start: 95, end: 125 }, // 正片台词
    ];
    const picked = pickSpeechSpans(spans, 35);
    expect(picked.sufficient).toBe(true);
    // 开头那 3 秒不该出现在结果里
    expect(picked.spans[0].start).toBe(60);
    expect(picked.spans).toHaveLength(2);
    expect(picked.spans[1]).toMatchObject({ start: 95, end: 100 });
  });

  it('源里人声不够时全部返回，并标记不足', () => {
    const spans = [{ start: 0, end: 10 }, { start: 20, end: 30 }];
    const picked = pickSpeechSpans(spans, 35);
    expect(picked.sufficient).toBe(false);
    expect(picked.totalSeconds).toBeCloseTo(20, 1);
    expect(picked.spans).toHaveLength(2);
  });

  it('没有可用段时返回空，而不是抛错', () => {
    expect(pickSpeechSpans([], 35)).toEqual({ spans: [], totalSeconds: 0, sufficient: false });
    // 全是被 MIN_SPEECH_SPAN 过滤掉的碎段
    const tiny = pickSpeechSpans([{ start: 0, end: 0.2 }, { start: 1, end: 1.3 }], 35);
    expect(tiny.spans).toEqual([]);
    expect(tiny.sufficient).toBe(false);
  });

  it('保持时间先后，不因为挑长段而打乱顺序', () => {
    const spans = [{ start: 0, end: 8 }, { start: 10, end: 18 }, { start: 20, end: 28 }];
    const picked = pickSpeechSpans(spans, 20);
    const starts = picked.spans.map((s) => s.start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it('目标时长为 0/负数时按 1 秒兜底', () => {
    const picked = pickSpeechSpans([{ start: 5, end: 15 }], 0);
    expect(picked.totalSeconds).toBeGreaterThan(0);
    expect(picked.spans[0].start).toBe(5);
  });

  it('单段就够长时直接截断该段', () => {
    const picked = pickSpeechSpans([{ start: 100, end: 160 }], 35);
    expect(picked.spans).toHaveLength(1);
    expect(picked.spans[0]).toMatchObject({ start: 100, end: 135 });
    expect(picked.sufficient).toBe(true);
  });

  it('短于 MIN_SPEECH_SPAN 的段不参与拼接', () => {
    expect(MIN_SPEECH_SPAN).toBeGreaterThan(0);
    const picked = pickSpeechSpans([{ start: 0, end: MIN_SPEECH_SPAN / 2 }, { start: 5, end: 15 }], 8);
    expect(picked.spans).toHaveLength(1);
    expect(picked.spans[0].start).toBe(5);
  });
});

describe('sanitizeVoiceName', () => {
  it('普通中日文角色名原样保留', () => {
    expect(sanitizeVoiceName('芙莉莲')).toBe('芙莉莲');
    expect(sanitizeVoiceName('辛・诺赞')).toBe('辛・诺赞');
    expect(sanitizeVoiceName('種﨑敦美')).toBe('種﨑敦美');
  });

  it('路径分隔符与 Windows 非法字符替换成下划线', () => {
    const out = sanitizeVoiceName('a/b:c*?"<>|d');
    expect(out).not.toMatch(/[\\/:*?"<>|]/);
    expect(out).toContain('a_b_c');
  });

  it('Windows 保留名加前缀，避免创建目录失败', () => {
    expect(sanitizeVoiceName('CON')).toBe('_CON');
    expect(sanitizeVoiceName('com1')).toBe('_com1');
  });

  it('空名/纯空白回退成占位名', () => {
    expect(sanitizeVoiceName('')).toBe('未命名');
    expect(sanitizeVoiceName('   ')).toBe('未命名');
  });

  it('去掉结尾的点和空格（Windows 会自动吃掉，导致两次写入落到不同文件）', () => {
    expect(sanitizeVoiceName('芙莉莲. ')).toBe('芙莉莲');
    expect(sanitizeVoiceName('芙莉莲...')).toBe('芙莉莲');
  });

  it('超长名字截断到 80 字符', () => {
    expect(sanitizeVoiceName('长'.repeat(200)).length).toBe(80);
  });
});

describe('formatClipDuration', () => {
  it('按 m:ss 展示', () => {
    expect(formatClipDuration(0)).toBe('0:00');
    expect(formatClipDuration(35)).toBe('0:35');
    expect(formatClipDuration(75)).toBe('1:15');
    expect(formatClipDuration(3599)).toBe('59:59');
  });

  it('非法值按 0 处理', () => {
    expect(formatClipDuration(NaN)).toBe('0:00');
    expect(formatClipDuration(-5)).toBe('0:00');
  });
});
