// @vitest-environment node
/**
 * adapters/shot-builder 单测：切点 → 真实镜头
 *
 * 这条函数修的是 2026-11-17 的第二次反馈：「这分的会不会太密了」——
 * hsv-diff 把闪白/运动误检成切点，一集出现 212 个 <0.2 秒的"镜头"。
 * 所以这里钉两件事：**过近的切点必须合并**、**合并后时间轴仍然首尾相接覆盖全片**。
 */
import { describe, expect, it } from 'vitest'
// @ts-expect-error .mjs 没有类型声明（和 render-grid23 的测试同一套约定）
import { buildShotsFromCuts as rawBuild, MIN_SHOT_SECONDS as rawMinShot } from '../../../plugins/watch-analysis/adapters/shot-builder.mjs'

interface Shot {
  i: number
  start: number
  end: number
  duration: number
  tier: number
  merged: number
}

const buildShotsFromCuts = rawBuild as (
  cuts: Array<{ t: number }>,
  duration: number,
  opts?: { minShotSeconds?: number },
) => Shot[]
const MIN_SHOT_SECONDS = rawMinShot as number

/** 便捷：把秒数组转成切点对象 */
const cutsOf = (...times: number[]) => times.map((t) => ({ t }))

describe('buildShotsFromCuts', () => {
  it('正常切点：一个间隔一个镜头', () => {
    const shots = buildShotsFromCuts(cutsOf(3, 8, 12), 20)
    expect(shots.map((s) => [s.start, s.end])).toEqual([
      [0, 3],
      [3, 8],
      [8, 12],
      [12, 20],
    ])
    expect(shots[0].duration).toBe(3)
  })

  it('0.1 秒连切的误检被合并（不再出现 0.1 秒镜头）', () => {
    const shots = buildShotsFromCuts(cutsOf(5, 5.1, 5.2, 5.3, 12), 20)
    // 5 附近 4 个切点只留第一个（5），所以镜头是 0-5 / 5-12 / 12-20
    expect(shots).toHaveLength(3)
    expect(shots.map((s) => s.duration)).toEqual([5, 7, 8])
    for (const shot of shots) {
      expect(shot.duration).toBeGreaterThanOrEqual(MIN_SHOT_SECONDS)
    }
  })

  it('真实短镜头（>= 0.3 秒）不被合并', () => {
    const shots = buildShotsFromCuts(cutsOf(1, 1.4, 1.8), 5)
    expect(shots).toHaveLength(4)
    expect(shots[1].duration).toBeCloseTo(0.4, 2)
  })

  it('合并后时间轴首尾相接、完整覆盖全片', () => {
    const shots = buildShotsFromCuts(cutsOf(2, 2.05, 2.1, 6, 6.1, 9, 9.05, 9.1, 9.2), 15)
    expect(shots[0].start).toBe(0)
    expect(shots[shots.length - 1].end).toBe(15)
    for (let i = 0; i < shots.length - 1; i += 1) {
      expect(shots[i].end).toBeCloseTo(shots[i + 1].start, 6)
    }
    // 2 / 6 / 9 三处真切点各留一个 → 0-2 / 2-6 / 6-9 / 9-15
    expect(shots).toHaveLength(4)
  })

  it('无效时长返回空数组', () => {
    expect(buildShotsFromCuts(cutsOf(1), 0)).toEqual([])
    expect(buildShotsFromCuts(cutsOf(1), -5)).toEqual([])
    expect(buildShotsFromCuts(cutsOf(1), Number.NaN)).toEqual([])
  })

  it('越界的切点被丢掉（t<=0 或 t>=时长）', () => {
    const shots = buildShotsFromCuts(cutsOf(-1, 0, 5, 99), 10)
    expect(shots.map((s) => [s.start, s.end])).toEqual([
      [0, 5],
      [5, 10],
    ])
  })

  it('minShotSeconds 可覆盖（测试/调试用）', () => {
    // 0.5 的间隔 >= 0.4，所以不合并 → 0-1 / 1-1.5 / 1.5-2 / 2-5
    const shots = buildShotsFromCuts(cutsOf(1, 1.5, 2), 5, { minShotSeconds: 0.4 })
    expect(shots).toHaveLength(4)
  })
})
