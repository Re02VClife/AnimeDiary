// @vitest-environment node
/**
 * adapters/cut-hsv 的切点过滤单测（2026-11-17 新增）
 *
 * 误检有两个来源，处理方式不同：
 *   - **近邻连切**（0.1 秒切三刀）→ 在 scanShots 的 `minGap` 阶段并掉；
 *   - **闪白/闪光**（单帧亮度尖峰）→ 用 `means` 做二次过滤，就是这里测的。
 *
 * 边界要分清：真剪前后是"换了一个稳定亮度水平"（黑场转白场），不是闪一下。
 */
import { describe, expect, it } from 'vitest'
// @ts-expect-error .mjs 没有类型声明（和 render-grid23 / shot-builder 同一套约定）
import { filterFlashCuts as rawFilter, isFlashFrame as rawIsFlash } from '../../../plugins/watch-analysis/adapters/cut-hsv.mjs'

const isFlashFrame = rawIsFlash as (means: number[], index: number) => boolean
const filterFlashCuts = rawFilter as (
  raw: { cuts?: Array<{ t: number; score: number }>; means?: number[] },
  fps: number,
) => Array<{ t: number; score: number }>

describe('isFlashFrame', () => {
  it('单帧亮度尖峰、前后接近 → 闪白', () => {
    expect(isFlashFrame([100, 100, 100, 100, 180, 100, 100, 100], 4)).toBe(true)
  })

  it('真剪（换到另一个稳定水平）不算闪白', () => {
    expect(isFlashFrame([60, 60, 60, 60, 60, 150, 150, 150], 5)).toBe(false)
  })

  it('缓慢变化（渐变转场）不算闪白', () => {
    expect(isFlashFrame([80, 90, 100, 110, 120, 130, 140, 150], 4)).toBe(false)
  })

  it('越界 / 空数据返回 false（不猜）', () => {
    expect(isFlashFrame([], 0)).toBe(false)
    expect(isFlashFrame([100], 5)).toBe(false)
    expect(isFlashFrame([100, 100], 0)).toBe(false)
  })
})

describe('filterFlashCuts', () => {
  it('丢掉闪白帧的切点，保留真剪', () => {
    const fps = 24
    // 帧 96（t=4.0）是闪白；帧 192（t=8.0）起亮度稳定在 160，是真剪
    const means = new Array(300).fill(100)
    means[96] = 185
    means[192] = 160
    means[193] = 160
    means[194] = 160

    const cuts = [
      { t: 96 / fps, score: 80 },
      { t: 192 / fps, score: 90 },
    ]
    const kept = filterFlashCuts({ cuts, means }, fps)
    expect(kept).toHaveLength(1)
    expect(kept[0].t).toBeCloseTo(192 / fps, 6)
  })

  it('没有 means（降级/老版本）时原样返回', () => {
    const cuts = [{ t: 1, score: 1 }]
    expect(filterFlashCuts({ cuts }, 24)).toBe(cuts)
  })

  it('fps 无效时原样返回', () => {
    const cuts = [{ t: 1, score: 1 }]
    expect(filterFlashCuts({ cuts, means: [100, 200, 100] }, 0)).toBe(cuts)
  })
})
