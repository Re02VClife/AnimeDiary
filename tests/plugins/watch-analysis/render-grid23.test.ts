/**
 * adapters/render-grid23 的规划函数单测
 *
 * 只测 `planGrid23`（纯函数）。这个渲染器最容易错的地方不是 ffmpeg 调用，
 * 而是**时间轴算歪**：算歪了不会报错，只会让影评引用的时间码对不上画面、
 * 或者最后一格覆盖不到片尾。所以首尾相接/覆盖全片必须钉死。
 *
 * ffmpeg 那一半靠真实视频的集成测试（见 review.test.ts 之外的手工验证），
 * 这里不做（CI 上没有那台机器上的素材）。
 */
// @vitest-environment node
import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const adapterUrl = pathToFileURL(
  path.resolve(__dirname, '../../../plugins/watch-analysis/adapters/render-grid23.mjs'),
).href

/** 动态 import：tsconfig 没开 allowJs，静态 import .mjs 会 TS2307 */
async function loadPlanner() {
  const mod = await import(/* @vite-ignore */ adapterUrl)
  return mod.planGrid23 as (duration: number, opts?: Record<string, unknown>) => Array<{
    index: number
    start: number
    end: number
    cells: Array<{ start: number; end: number; at: number }>
  }>
}

describe('planGrid23', () => {
  it('24 分钟切成 18 张，每张 6 格', async () => {
    const planGrid23 = await loadPlanner()
    const sheets = planGrid23(1420)
    // ceil(1420 / 80) = 18
    expect(sheets).toHaveLength(18)
    for (const sheet of sheets) {
      expect(sheet.cells).toHaveLength(6)
    }
  })

  it('时间段首尾相接、不重叠、完整覆盖全片', async () => {
    const planGrid23 = await loadPlanner()
    const sheets = planGrid23(1420)
    const cells = sheets.flatMap((sheet) => sheet.cells)

    expect(cells[0].start).toBeCloseTo(0, 6)
    expect(cells[cells.length - 1].end).toBeCloseTo(1420, 3)
    for (let i = 0; i < cells.length - 1; i += 1) {
      expect(cells[i].end).toBeCloseTo(cells[i + 1].start, 6)
    }
  })

  it('抽帧点落在各自的格子区间内（不能抽到隔壁格）', async () => {
    const planGrid23 = await loadPlanner()
    const cells = planGrid23(1420).flatMap((sheet) => sheet.cells)
    for (const cell of cells) {
      expect(cell.at).toBeGreaterThanOrEqual(cell.start)
      expect(cell.at).toBeLessThanOrEqual(cell.end)
    }
  })

  it('极短视频也能出 1 张（不能因为除零返回空）', async () => {
    const planGrid23 = await loadPlanner()
    expect(planGrid23(1)).toHaveLength(1)
    expect(planGrid23(0.5)[0].cells).toHaveLength(6)
  })

  it('超长视频被 maxSheets 兜住（不生成几十张把请求体撑爆）', async () => {
    const planGrid23 = await loadPlanner()
    const sheets = planGrid23(3 * 60 * 60) // 3 小时
    expect(sheets.length).toBeLessThanOrEqual(40)
  })

  it('无效时长返回空数组（调用方据此报错，而不是拿空计划去抽帧）', async () => {
    const planGrid23 = await loadPlanner()
    expect(planGrid23(0)).toEqual([])
    expect(planGrid23(-5)).toEqual([])
    expect(planGrid23(Number.NaN)).toEqual([])
  })

  it('自定义 sheetSeconds 生效（80 秒一张 vs 40 秒一张）', async () => {
    const planGrid23 = await loadPlanner()
    expect(planGrid23(400, { sheetSeconds: 80 })).toHaveLength(5)
    expect(planGrid23(400, { sheetSeconds: 40 })).toHaveLength(10)
  })
})

/**
 * 2026-11-16 新增：张数上下限（面板上的「100–1000」就是这两个值）。
 *
 * 用户要的是「切片数量可控」：设置 100–1000 时，24 分钟的片应该出 100 张而不是自动的 18 张。
 * 这里把四个边界钉死：拉高、压低、落在区间内、写反。
 */
describe('planGrid23 的张数上下限', () => {
  it('minSheets 拉高张数：24 分钟的片配 100–1000 就出 100 张', async () => {
    const planGrid23 = await loadPlanner()
    expect(planGrid23(1420, { minSheets: 100, maxSheets: 1000 })).toHaveLength(100)
  })

  it('maxSheets 压低张数：自动 18 张被压到 10 张', async () => {
    const planGrid23 = await loadPlanner()
    expect(planGrid23(1420, { maxSheets: 10 })).toHaveLength(10)
  })

  it('自动值落在区间内时按自动走（18 在 10–40 之间）', async () => {
    const planGrid23 = await loadPlanner()
    expect(planGrid23(1420, { minSheets: 10, maxSheets: 40 })).toHaveLength(18)
  })

  it('上下限写反时下限优先，不返回空计划', async () => {
    const planGrid23 = await loadPlanner()
    expect(planGrid23(1420, { minSheets: 120, maxSheets: 20 })).toHaveLength(120)
  })

  it('超过 10000 的配置被夹到 10000（不会真去抽十万张）', async () => {
    const planGrid23 = await loadPlanner()
    expect(planGrid23(3600, { minSheets: 20_000, maxSheets: 30_000 })).toHaveLength(10_000)
  })

  it('1000 张时时间轴仍然首尾相接、覆盖全片（张数变多不能把时间轴算歪）', async () => {
    const planGrid23 = await loadPlanner()
    const sheets = planGrid23(1420, { minSheets: 1000, maxSheets: 1000 })
    expect(sheets).toHaveLength(1000)
    const cells = sheets.flatMap((sheet) => sheet.cells)
    expect(cells).toHaveLength(6000)
    expect(cells[0].start).toBeCloseTo(0, 6)
    expect(cells[cells.length - 1].end).toBeCloseTo(1420, 3)
    for (let i = 0; i < cells.length - 1; i += 1) {
      expect(cells[i].end).toBeCloseTo(cells[i + 1].start, 6)
    }
  })
})
