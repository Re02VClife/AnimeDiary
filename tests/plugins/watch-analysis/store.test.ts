/**
 * plugins/watch-analysis/server/store 单测
 *
 * 这层出错的后果都是"静默的"：写歪了报告读不回来、目录穿越没挡住、
 * 原子写半途失败留下半截 JSON。所以每条都要钉死。
 */
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createWatchStore, keyToDirName } from '../../../plugins/watch-analysis/server/store'
import type { WatchReport } from '../../../plugins/watch-analysis/core/types'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-store-test-'))
})

afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

/** 造一份最小的合法报告（只填测试关心的字段） */
function makeReport(overrides: Partial<WatchReport> = {}): WatchReport {
  return {
    schema: 1,
    key: '我的模板::葬送的芙莉莲',
    episode: 1,
    video: { file: 'D:/anime/ep01.mkv', duration: 1440, fps: 23.976, width: 1920, height: 1080 },
    engine: { storyboard: 'dsh-video-storyboard', cut: 'hsv', transcript: 'none', motion: 'none', music: 'none' },
    shots: [{ i: 0, start: 0, end: 5.2, sampled: false, tier: 2 }],
    cuts: [{ t: 5.2, score: 120, engine: 'hsv' }],
    sheets: [{ file: 'ep01.png', width: 800, height: 450, cells: 1, shots: [0] }],
    budget: { limit: 2_000_000, spent: 0, byKind: {}, reserved: 0, exhausted: false },
    timing: { total: 12.3 },
    created: new Date().toISOString(),
    appVersion: '1.3.26',
    ...overrides,
  }
}

describe('keyToDirName', () => {
  it('把 `::` 和路径分隔符换成安全字符', () => {
    const name = keyToDirName('我的模板::葬送的芙莉莲')
    expect(name).not.toContain(':')
    expect(name).not.toContain('/')
    expect(name).not.toContain('\\')
    expect(name.startsWith('我的模板__葬送的芙莉莲')).toBe(true)
  })

  it('清洗后前缀相同的两个 key，靠 hash 后缀区分', () => {
    // `/` 和 `\` 都会被清洗成同一个字符，所以这两个 key 的 slug 完全一样
    const a = keyToDirName('模板/标题')
    const b = keyToDirName('模板\\标题')
    expect(a).not.toBe(b)
    expect(a.split('-')[0]).toBe(b.split('-')[0])
  })

  it('相同 key 得到相同目录（幂等）', () => {
    expect(keyToDirName('模板::标题')).toBe(keyToDirName('模板::标题'))
  })

  it('空 key 也能得到合法目录名', () => {
    expect(keyToDirName('')).toMatch(/^untitled-[0-9a-f]{8}$/)
  })

  it('超长标题被截断但 hash 仍然区分', () => {
    const long = '模板::' + '很长的标题'.repeat(50)
    const name = keyToDirName(long)
    expect(name.length).toBeLessThan(120)
    expect(name).toMatch(/-[0-9a-f]{8}$/)
  })
})

describe('read / write', () => {
  it('写进去能原样读回来', () => {
    const store = createWatchStore(dir)
    const report = makeReport()
    store.write(report)
    const back = store.read(report.key, report.episode)
    expect(back).not.toBeNull()
    expect(back!.key).toBe(report.key)
    expect(back!.shots).toHaveLength(1)
    expect(back!.sheets[0].file).toBe('ep01.png')
  })

  it('没分析过的集返回 null（而不是抛错）', () => {
    const store = createWatchStore(dir)
    expect(store.read('任意::标题', 3)).toBeNull()
  })

  it('坏 JSON 返回 null，不让上层拿到半截数据', () => {
    const store = createWatchStore(dir)
    const target = store.reportPath('坏数据::测试', 1)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, '{ 这不是 JSON', 'utf8')
    expect(store.read('坏数据::测试', 1)).toBeNull()
  })

  it('schema 版本不对也返回 null（未来迁移的钩子）', () => {
    const store = createWatchStore(dir)
    store.write(makeReport({ schema: 2 as unknown as 1 }))
    expect(store.read('我的模板::葬送的芙莉莲', 1)).toBeNull()
  })

  it('吐出来的是纯 JSON（Buffer / undefined 不会混进去）', () => {
    const store = createWatchStore(dir)
    store.write(makeReport())
    const target = store.reportPath('我的模板::葬送的芙莉莲', 1)
    const raw = fs.readFileSync(target, 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
    expect(raw).not.toContain('undefined')
  })

  it('重复写不会留下临时文件', () => {
    const store = createWatchStore(dir)
    store.write(makeReport())
    store.write(makeReport({ episode: 2 }))
    const files = fs.readdirSync(path.dirname(store.reportPath('我的模板::葬送的芙莉莲', 1)))
    expect(files.filter((f) => f.endsWith('.tmp'))).toHaveLength(0)
  })
})

describe('sheetFile 目录穿越防护', () => {
  it('正常文件名能解析成绝对路径', () => {
    const store = createWatchStore(dir)
    const resolved = store.sheetFile('模板::标题', 1, 'ep01.png')
    expect(resolved).not.toBeNull()
    expect(resolved!.endsWith('ep01.png')).toBe(true)
  })

  it('`../` 穿越被挡', () => {
    const store = createWatchStore(dir)
    expect(store.sheetFile('模板::标题', 1, '../../1.json')).toBeNull()
    expect(store.sheetFile('模板::标题', 1, '..\\..\\1.json')).toBeNull()
  })

  it('绝对路径被挡', () => {
    const store = createWatchStore(dir)
    const outside = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd'
    expect(store.sheetFile('模板::标题', 1, outside)).toBeNull()
  })

  it('子目录里的文件是允许的（storyboard 会写 evidence.json）', () => {
    const store = createWatchStore(dir)
    expect(store.sheetFile('模板::标题', 1, 'ep01.evidence.json')).not.toBeNull()
  })

  // 2026-11-17：空名/`.` 会解析成 sheetDir 目录本身，路由层 stat 成功后被
  // createReadStream 当文件读 → EISDIR 未捕获异常 → 整个 API 进程退出。
  it('空文件名返回 null（不是目录本身）', () => {
    const store = createWatchStore(dir)
    expect(store.sheetFile('模板::标题', 1, '')).toBeNull()
    expect(store.sheetFile('模板::标题', 1, '   ')).toBeNull()
  })

  it('`.` 和 `./` 返回 null（那是目录，不是文件）', () => {
    const store = createWatchStore(dir)
    expect(store.sheetFile('模板::标题', 1, '.')).toBeNull()
    expect(store.sheetFile('模板::标题', 1, './')).toBeNull()
    expect(store.sheetFile('模板::标题', 1, 'sub/..')).toBeNull()
  })
})

describe('listEpisodes / remove', () => {
  it('按集号升序返回', () => {
    const store = createWatchStore(dir)
    const base = { key: '列表::测试' }
    store.write(makeReport({ ...base, episode: 3 }))
    store.write(makeReport({ ...base, episode: 1 }))
    store.write(makeReport({ ...base, episode: 12 }))
    expect(store.listEpisodes('列表::测试')).toEqual([1, 3, 12])
  })

  it('没分析过的番返回空数组', () => {
    const store = createWatchStore(dir)
    expect(store.listEpisodes('不存在::番')).toEqual([])
  })

  it('remove 同时清掉报告和图片目录', () => {
    const store = createWatchStore(dir)
    store.write(makeReport({ episode: 5 }))
    const sheetDir = store.sheetDir('我的模板::葬送的芙莉莲', 5)
    fs.mkdirSync(sheetDir, { recursive: true })
    fs.writeFileSync(path.join(sheetDir, 'ep05.png'), 'fake')

    store.remove('我的模板::葬送的芙莉莲', 5)

    expect(store.read('我的模板::葬送的芙莉莲', 5)).toBeNull()
    expect(fs.existsSync(sheetDir)).toBe(false)
  })

  it('remove 不存在的集不抛错', () => {
    const store = createWatchStore(dir)
    expect(() => store.remove('没有::这个', 9)).not.toThrow()
  })
})
