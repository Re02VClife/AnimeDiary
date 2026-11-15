// @vitest-environment node
/**
 * plugins/watch-analysis/adapters/subtitle-parse + transcript-subtitle 单测
 *
 * 解析器的坑全在边界上：BOM、CRLF、没有序号行、乱序 Format 列、Text 里带逗号、
 * VTT 的 NOTE 块 / cue 设置、GBK 编码……每个用例都对应一个真实字幕文件里见过的变体。
 *
 * 注意：vitest 默认环境是 jsdom，这里要读临时目录、用 Buffer / TextDecoder，
 * 所以文件顶部钉 `// @vitest-environment node`。
 */
import { describe, it, expect } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Segment, VideoRef } from '../../../plugins/watch-analysis/core/types'

// .mjs 适配器是给 worker 直接 import 的，项目没开 allowJs、也没有 d.ts，
// 所以 tsc 会报 TS7016；这里用 @ts-expect-error 压掉，再把导出 cast 成明确形状。
// @ts-expect-error —— .mjs 没有类型声明
import * as subtitleParseModule from '../../../plugins/watch-analysis/adapters/subtitle-parse.mjs'
// @ts-expect-error —— .mjs 没有类型声明
import { transcriptSubtitleProvider as subtitleProviderModule } from '../../../plugins/watch-analysis/adapters/transcript-subtitle.mjs'

const { parseSrt, parseAss, parseVtt, parseSubtitle } = subtitleParseModule as unknown as {
  parseSrt: (text: string) => Segment[]
  parseAss: (text: string) => Segment[]
  parseVtt: (text: string) => Segment[]
  parseSubtitle: (text: string, ext: string) => Segment[]
}

interface TranscriptResult {
  segments: Segment[]
  source: string
  notes?: string[]
}

const provider = subtitleProviderModule as unknown as {
  id: string
  label: string
  priority: number
  ready: () => Promise<{ ok: boolean }>
  transcribe: (
    video: VideoRef,
    opts?: { signal?: AbortSignal; searchDirs?: string[] },
  ) => Promise<TranscriptResult>
}

/** 只关心正文的断言辅助 */
function texts(segments: Segment[]): string[] {
  return segments.map((segment) => segment.text)
}

function makeVideo(file: string): VideoRef {
  return {
    animeKey: '模板::测试番剧',
    episode: 1,
    file,
    duration: 1440,
    fps: 23.976,
    width: 1920,
    height: 1080,
  }
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'watch-subtitle-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ─────────────────────────────────────────────────────────────
// SRT
// ─────────────────────────────────────────────────────────────

const SRT_BASIC = [
  '1',
  '00:00:01,000 --> 00:00:02,500',
  '你好，世界',
  '',
  '2',
  '00:00:03,000 --> 00:00:04,250',
  '第二句',
  '',
].join('\n')

describe('parseSrt', () => {
  it('基本解析：时间换成秒，source 标 srt', () => {
    expect(parseSrt(SRT_BASIC)).toEqual([
      { start: 1, end: 2.5, text: '你好，世界', source: 'srt' },
      { start: 3, end: 4.25, text: '第二句', source: 'srt' },
    ])
  })

  it('BOM + CRLF：Windows 记事本另存不会带出垃圾字符', () => {
    const text = `\uFEFF${SRT_BASIC.replace(/\n/g, '\r\n')}`
    const segments = parseSrt(text)
    expect(segments).toHaveLength(2)
    expect(texts(segments)).toEqual(['你好，世界', '第二句'])
    // BOM 不能混进第一段正文
    expect(segments[0].text).toBe('你好，世界')
  })

  it('序号行可以没有', () => {
    const text = '00:00:01,000 --> 00:00:02,500\n只有时间行\n'
    expect(parseSrt(text)).toEqual([{ start: 1, end: 2.5, text: '只有时间行', source: 'srt' }])
  })

  it('毫秒分隔符用点号（.srt 里也常见）', () => {
    const segments = parseSrt('00:00:01.250 --> 00:00:02.000\n点号\n')
    expect(segments[0]).toMatchObject({ start: 1.25, end: 2 })
  })

  it('多行正文合并成一行，换行替换成空格', () => {
    const text = '1\n00:00:01,000 --> 00:00:02,000\n第一行\n第二行\n第三行\n'
    const segments = parseSrt(text)
    expect(segments).toHaveLength(1)
    expect(segments[0].text).toBe('第一行 第二行 第三行')
  })

  it('去掉 <i>/<font> 标签，并解码常见 HTML 实体', () => {
    const text =
      '1\n00:00:01,000 --> 00:00:02,000\n<i>斜体</i>和<font color="#fff">变色</font>&amp;实体\n'
    expect(texts(parseSrt(text))).toEqual(['斜体和变色&实体'])
  })

  it('输出按 start 升序（文件里乱序也能排回来）', () => {
    const text = [
      '2',
      '00:00:05,000 --> 00:00:06,000',
      '后',
      '',
      '1',
      '00:00:01,000 --> 00:00:02,000',
      '前',
      '',
    ].join('\n')
    expect(texts(parseSrt(text))).toEqual(['前', '后'])
  })

  it('end < start 的坏数据丢弃（只留下正常那条）', () => {
    const text = [
      '1',
      '00:00:05,000 --> 00:00:01,000',
      '时间倒流',
      '',
      '2',
      '00:00:01,000 --> 00:00:02,000',
      '正常',
      '',
    ].join('\n')
    expect(texts(parseSrt(text))).toEqual(['正常'])
  })
})

// ─────────────────────────────────────────────────────────────
// ASS / SSA
// ─────────────────────────────────────────────────────────────

const ASS_MESSY = [
  '[Script Info]',
  'Title: 乱序 Format 测试',
  'ScriptType: v4.00+',
  // Script Info 段里的 Dialogue 必须被忽略（只认 [Events]）
  'Dialogue: 0,0:00:09.00,0:00:10.00,Default,,0,0,0,,这行在 Script Info 里',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize',
  'Style: Default,微软雅黑,48',
  '',
  '[Events]',
  // 故意把 Text 放在 Start 前面：解析器必须按 Format 列名定位，不能假设固定列序
  'Format: Layer, Text, Start, End, Style',
  'Dialogue: 0,你好, 世界,0:00:01.00,0:00:02.50,Default',
  'Dialogue: 0,{\\an8\\fad(300,300)\\pos(320,50)}顶部\\N第二行\\n第三行\\h结尾,0:00:03.00,0:00:04.00,Default',
].join('\n')

describe('parseAss', () => {
  it('乱序 Format：按列名定位，Text 里的逗号也能还原；Script Info/Styles 段被忽略', () => {
    expect(parseAss(ASS_MESSY)).toEqual([
      // "你好, 世界" 的逗号在 Text 列内部，不能被当成列分隔符
      { start: 1, end: 2.5, text: '你好, 世界', source: 'ass' },
      // {\an8} {\fad(...)} {\pos(...)} 去掉；\N \n \h 都换成空格
      { start: 3, end: 4, text: '顶部 第二行 第三行 结尾', source: 'ass' },
    ])
  })

  it('标准列序（Text 在最后一列）同样正确', () => {
    const text = [
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,标准列序',
    ].join('\n')
    expect(texts(parseAss(text))).toEqual(['标准列序'])
  })

  it('没有 Format 行时退回 ASS/SSA 的 10 列默认序', () => {
    const text = [
      '[Events]',
      'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,默认列序',
    ].join('\n')
    expect(parseAss(text)).toEqual([{ start: 1, end: 2, text: '默认列序', source: 'ass' }])
  })

  it('CRLF 与 BOM 不影响解析', () => {
    const text = `\uFEFF${ASS_MESSY.replace(/\n/g, '\r\n')}`
    expect(parseAss(text)).toHaveLength(2)
  })

  it('end < start 的坏数据丢弃', () => {
    const text = [
      '[Events]',
      'Format: Layer, Start, End, Style, Text',
      'Dialogue: 0,0:00:05.00,0:00:01.00,Default,倒流',
      'Dialogue: 0,0:00:01.00,0:00:02.00,Default,正常',
    ].join('\n')
    expect(texts(parseAss(text))).toEqual(['正常'])
  })
})

// ─────────────────────────────────────────────────────────────
// VTT
// ─────────────────────────────────────────────────────────────

const VTT_MIXED = [
  'WEBVTT - 示例',
  'X-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000',
  '',
  'NOTE 这是注释，不该出现在台词里',
  'NOTE 00:00:09.000 --> 00:00:10.000 注释里写假时间行也不能被当 cue',
  '',
  'STYLE',
  '::cue { color: yellow }',
  '',
  'cue-1',
  '00:00:01.000 --> 00:00:02.500 align:start position:10%',
  '第一句',
  '',
  '01:02:03.000 --> 01:02:04.000',
  '第二句',
  '第二行',
].join('\n')

describe('parseVtt', () => {
  it('吃掉 WEBVTT 头 / NOTE 块 / STYLE 块 / cue 设置，支持 HH: 时间与多行正文', () => {
    expect(parseVtt(VTT_MIXED)).toEqual([
      { start: 1, end: 2.5, text: '第一句', source: 'vtt' },
      // 01:02:03 = 3723 秒
      { start: 3723, end: 3724, text: '第二句 第二行', source: 'vtt' },
    ])
  })

  it('内联标签（<v> / <c> / 时间戳标签）被去掉', () => {
    const text = [
      'WEBVTT',
      '',
      '00:00:01.000 --> 00:00:02.000',
      '<v 旁白><c.green>标签文本</c></v>',
      '',
      '00:00:03.000 --> 00:00:04.000',
      '戳<00:00:03.500>记',
    ].join('\n')
    expect(texts(parseVtt(text))).toEqual(['标签文本', '戳记'])
  })

  it('输出按 start 升序', () => {
    const text = [
      'WEBVTT',
      '',
      '00:00:05.000 --> 00:00:06.000',
      '后',
      '',
      '00:00:01.000 --> 00:00:02.000',
      '前',
    ].join('\n')
    expect(texts(parseVtt(text))).toEqual(['前', '后'])
  })
})

// ─────────────────────────────────────────────────────────────
// 边界 + parseSubtitle 分派
// ─────────────────────────────────────────────────────────────

describe('边界', () => {
  it('空文本返回空数组（不是 null，也不抛错）', () => {
    expect(parseSrt('')).toEqual([])
    expect(parseAss('')).toEqual([])
    expect(parseVtt('')).toEqual([])
  })

  it('只有空正文的条目被丢弃', () => {
    expect(parseSrt('1\n00:00:01,000 --> 00:00:02,000\n\n')).toEqual([])
    expect(parseAss('[Events]\nFormat: Layer, Start, End, Style, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,\n')).toEqual([])
  })
})

describe('parseSubtitle', () => {
  it('按扩展名分派；大小写、带不带点都兼容', () => {
    const srt = '00:00:01,000 --> 00:00:02,000\nsrt\n'
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nvtt\n'
    const ass = '[Events]\nFormat: Layer, Start, End, Style, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,ass\n'

    expect(parseSubtitle(srt, '.srt')[0]?.source).toBe('srt')
    expect(parseSubtitle(vtt, '.VTT')[0]?.source).toBe('vtt')
    // .ssa 与 .ass 同语法，source 统一标 'ass'
    expect(parseSubtitle(ass, '.ssa')[0]?.source).toBe('ass')
    expect(parseSubtitle(srt, 'SRT')[0]?.source).toBe('srt')
  })

  it('未知扩展名返回空数组（约定：空 = 这个 provider 无能为力，不是错误）', () => {
    expect(parseSubtitle('随便什么内容', '.txt')).toEqual([])
    expect(parseSubtitle('随便什么内容', '')).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────
// transcriptSubtitleProvider（真读临时目录）
// ─────────────────────────────────────────────────────────────

const ASS_TRANSCRIPT = [
  '[Script Info]',
  'Title: provider 测试',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Text',
  'Dialogue: 0,0:00:01.00,0:00:02.00,Default,视频里的第一句',
].join('\n')

describe('transcriptSubtitleProvider', () => {
  it('形状：id / label / priority / ready', async () => {
    expect(provider.id).toBe('subtitle-file')
    expect(provider.label).toBe('同目录字幕文件')
    expect(provider.priority).toBe(1)
    await expect(provider.ready()).resolves.toEqual({ ok: true })
  })

  it('找到与视频同名的字幕文件（大小写不敏感）', async () => {
    await withTempDir(async (dir) => {
      const video = path.join(dir, 'ep01.mp4')
      await writeFile(video, '')
      await writeFile(path.join(dir, 'EP01.ASS'), ASS_TRANSCRIPT)

      const result = await provider.transcribe(makeVideo(video), {})
      expect(result.source).toBe('subtitle-file')
      expect(result.segments).toEqual([{ start: 1, end: 2, text: '视频里的第一句', source: 'ass' }])
      expect(result.notes?.[0]).toBe('EP01.ASS')
    })
  })

  it('目录里没有字幕文件时返回空 segments，不抛错', async () => {
    await withTempDir(async (dir) => {
      const video = path.join(dir, 'ep01.mp4')
      await writeFile(video, '')
      await writeFile(path.join(dir, 'ep01.txt'), '不是字幕')

      const result = await provider.transcribe(makeVideo(video), {})
      expect(result).toEqual({ segments: [], source: 'subtitle-file' })
    })
  })

  it('多个无关字幕都能匹配时必须返回空，而不是瞎选一个', async () => {
    await withTempDir(async (dir) => {
      const video = path.join(dir, 'ep01.mp4')
      await writeFile(video, '')
      await writeFile(path.join(dir, 'show-a.srt'), '1\n00:00:01,000 --> 00:00:02,000\nA\n')
      await writeFile(path.join(dir, 'show-b.ass'), ASS_TRANSCRIPT)

      const result = await provider.transcribe(makeVideo(video), {})
      expect(result.segments).toEqual([])
      expect(result.source).toBe('subtitle-file')
      // notes 里要把候选列出来，方便排查为什么没用
      expect(
        result.notes?.some((note) => note.includes('show-a.srt') && note.includes('show-b.ass')),
      ).toBe(true)
    })
  })

  it('目录里唯一的字幕文件（名字对不上）可以直接用', async () => {
    await withTempDir(async (dir) => {
      const video = path.join(dir, 'ep01.mp4')
      await writeFile(video, '')
      await writeFile(path.join(dir, '字幕组版.ass'), ASS_TRANSCRIPT)

      const result = await provider.transcribe(makeVideo(video), {})
      expect(texts(result.segments)).toEqual(['视频里的第一句'])
      expect(result.notes?.[0]).toBe('字幕组版.ass')
    })
  })

  it('多个候选时选名字里包含视频 basename 的那个', async () => {
    await withTempDir(async (dir) => {
      const video = path.join(dir, 'ep01.mp4')
      await writeFile(video, '')
      await writeFile(path.join(dir, '[字幕组] ep01 [1080p].ass'), ASS_TRANSCRIPT)
      await writeFile(path.join(dir, '另一个东西.srt'), '1\n00:00:01,000 --> 00:00:02,000\n无关\n')

      const result = await provider.transcribe(makeVideo(video), {})
      expect(texts(result.segments)).toEqual(['视频里的第一句'])
      expect(result.notes?.[0]).toBe('[字幕组] ep01 [1080p].ass')
    })
  })

  it('opts.searchDirs 里的字幕文件也会被找到', async () => {
    await withTempDir(async (root) => {
      const videoDir = path.join(root, 'video')
      const subtitleDir = path.join(root, 'subtitles')
      await mkdir(videoDir)
      await mkdir(subtitleDir)
      const video = path.join(videoDir, 'ep01.mp4')
      await writeFile(video, '')
      await writeFile(path.join(subtitleDir, 'ep01.ass'), ASS_TRANSCRIPT)

      const result = await provider.transcribe(makeVideo(video), { searchDirs: [subtitleDir] })
      expect(texts(result.segments)).toEqual(['视频里的第一句'])
    })
  })

  it('GB18030 编码的字幕能正确解码（UTF-8 严格解码失败后回退）', async () => {
    await withTempDir(async (dir) => {
      const video = path.join(dir, 'ep01.mp4')
      await writeFile(video, '')
      // “中文”的 GBK/GB18030 字节 D6 D0 CE C4；UTF-8 严格解码会失败
      const content = Buffer.concat([
        Buffer.from('1\n00:00:01,000 --> 00:00:02,000\n', 'utf8'),
        Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
        Buffer.from('\n', 'utf8'),
      ])
      await writeFile(path.join(dir, 'ep01.srt'), content)

      const result = await provider.transcribe(makeVideo(video), {})
      expect(result.segments).toEqual([{ start: 1, end: 2, text: '中文', source: 'srt' }])
      expect(result.notes?.some((note) => note.includes('gb18030'))).toBe(true)
    })
  })

  it('视频路径为空时返回空结果，不抛错', async () => {
    const result = await provider.transcribe(makeVideo(''), {})
    expect(result.segments).toEqual([])
    expect(result.source).toBe('subtitle-file')
  })
})
