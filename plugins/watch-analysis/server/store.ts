/**
 * server/store — 拉片报告的落盘
 *
 * 存储位置：`{DATA_DIR}/watch-reports/{safeKey}/{episode}.json` + `{safeKey}/sheets/*.png`
 *
 * 三条约定（和仓库里 music-links / local-library 的侧车数据保持一致）：
 *   1. **不进 Excel** —— Excel 是用户的评分表，拉片是派生数据，丢了可以重算
 *   2. **原子写** —— 先写 .tmp 再 rename，断电不会留下半截 JSON
 *   3. **key 不是路径** —— `模板::标题` 里有 `:` 和中文，必须转成安全目录名，
 *      同时用短 hash 后缀防碰撞（两部番标题清洗后可能一样）
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { WatchReport } from '../core/types'

export interface WatchStore {
  /** 报告 JSON 的绝对路径 */
  reportPath(key: string, episode: number): string
  /** 某一集的宫格图目录（绝对路径） */
  sheetDir(key: string, episode: number): string
  /** 相对 sheetDir 的文件名 → 绝对路径；防目录穿越 */
  sheetFile(key: string, episode: number, file: string): string | null
  /** 读报告；没有或坏了返回 null（不抛错，调用方据此显示"还没分析"） */
  read(key: string, episode: number): WatchReport | null
  /** 原子写报告 */
  write(report: WatchReport): void
  /** 列出某一部番已经分析过的集号 */
  listEpisodes(key: string): number[]
  /** 删掉某一集的全部分析产物 */
  remove(key: string, episode: number): void
}

/** 把 `模板::标题` 转成安全目录名：保留中英文数字，其余换成 `_`，末尾附 8 位 hash 防碰撞 */
export function keyToDirName(key: string): string {
  const slug = key
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 8)
  return `${slug || 'untitled'}-${hash}`
}

/** 原子写：同目录写 .tmp → fsync → rename。失败时清掉临时文件，不留垃圾。 */
function atomicWriteJson(file: string, data: unknown): void {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const temporary = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`)
  try {
    const handle = fs.openSync(temporary, 'w')
    try {
      fs.writeSync(handle, JSON.stringify(data, null, 2))
      fs.fsyncSync(handle)
    } finally {
      fs.closeSync(handle)
    }
    fs.renameSync(temporary, file)
  } finally {
    try { fs.unlinkSync(temporary) } catch { /* 已经 rename 掉了 */ }
  }
}

export function createWatchStore(DATA_DIR: string): WatchStore {
  const root = path.join(DATA_DIR, 'watch-reports')

  function reportPath(key: string, episode: number): string {
    return path.join(root, keyToDirName(key), `${episode}.json`)
  }

  function sheetDir(key: string, episode: number): string {
    return path.join(root, keyToDirName(key), 'sheets', `ep${episode}`)
  }

  function sheetFile(key: string, episode: number, file: string): string | null {
    // file 来自报告 JSON，可能被手工改过 —— 必须挡掉 `../` 穿越
    const base = sheetDir(key, episode)
    const resolved = path.resolve(base, file)
    const relative = path.relative(base, resolved)
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null
    return resolved
  }

  function read(key: string, episode: number): WatchReport | null {
    const file = reportPath(key, episode)
    try {
      const text = fs.readFileSync(file, 'utf8')
      const parsed = JSON.parse(text) as WatchReport
      // 只做最低限度的形状校验：版本不对就当没有，让上层重跑，而不是拿到半截数据渲染崩
      if (!parsed || parsed.schema !== 1 || !Array.isArray(parsed.shots)) return null
      return parsed
    } catch {
      return null
    }
  }

  function write(report: WatchReport): void {
    atomicWriteJson(reportPath(report.key, report.episode), report)
  }

  function listEpisodes(key: string): number[] {
    const dir = path.join(root, keyToDirName(key))
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => /^\d+\.json$/.test(f))
        .map((f) => Number(f.replace(/\.json$/, '')))
        .sort((a, b) => a - b)
    } catch {
      return []
    }
  }

  function remove(key: string, episode: number): void {
    try { fs.unlinkSync(reportPath(key, episode)) } catch { /* 本来就没有 */ }
    try { fs.rmSync(sheetDir(key, episode), { recursive: true, force: true }) } catch { /* ignore */ }
  }

  return { reportPath, sheetDir, sheetFile, read, write, listEpisodes, remove }
}
