/**
 * adapters/transcript-embedded — 内嵌字幕轨（来源优先级 0）
 *
 * 优先级：**内嵌字幕轨 0** → 同目录字幕文件 1 → MOSS ASR 2。
 *
 * 为什么补这一层：这个优先级在文档里写了很久，但**一直没有实现** ——
 * 用户分析带内嵌字幕的 mp4/mkv 时，明明有字幕却拿不到台词（2026-11-17 反馈）。
 * 内嵌字幕比外挂文件更常见（尤其 mkv 封装），而且用 ffmpeg 一次转 srt 只要零点几秒。
 *
 * 约定与其它 provider 一致：**返回空 segments 表示"这个文件没有可用字幕轨"，不算错误**，
 * pipeline 会继续找外挂文件 / ASR。只有 ffmpeg 真的挂了才写 notes 说明原因。
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { parseSubtitle } from './subtitle-parse.mjs'

const run = promisify(execFile)
const SOURCE = 'subtitle-embedded'

export const transcriptEmbeddedProvider = {
  id: 'subtitle-embedded',
  label: '内嵌字幕轨（ffmpeg）',

  async ready() {
    // ffmpeg 缺失由实际调用暴露；这里不做重复探测
    return { ok: true, detail: '把视频里的第一条字幕轨转成 srt 再解析' }
  },

  /**
   * @param {{ file: string }} video
   * @param {{ timeoutMs?: number }} [opts]
   * @returns {Promise<{ segments: Array<{ start: number, end: number, text: string }>, source: string, notes?: string[] }>}
   */
  async transcribe(video, opts = {}) {
    const dir = await mkdtemp(path.join(tmpdir(), 'watch-embedded-'))
    const out = path.join(dir, 'sub.srt')
    try {
      await run(
        'ffmpeg',
        [
          '-y', '-loglevel', 'error',
          '-i', video.file,
          // 只取第一条字幕轨；没有字幕轨时 ffmpeg 会报 "Stream map '0:s:0' matches no streams"
          '-map', '0:s:0',
          '-c:s', 'srt',
          out,
        ],
        { windowsHide: true, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 8 * 1024 * 1024 },
      )
      const text = await readFile(out, 'utf8')
      const segments = parseSubtitle(text, 'srt')
      return segments.length > 0
        ? { segments, source: SOURCE, notes: [`内嵌字幕轨：${segments.length} 句`] }
        : { segments: [], source: SOURCE, notes: ['内嵌字幕轨是空的'] }
    } catch (error) {
      return {
        segments: [],
        source: SOURCE,
        notes: [`没有可用的内嵌字幕轨：${error instanceof Error ? error.message : String(error)}`],
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  },
}

export default transcriptEmbeddedProvider
