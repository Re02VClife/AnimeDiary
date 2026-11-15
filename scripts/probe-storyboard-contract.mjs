#!/usr/bin/env node
/**
 * probe-storyboard-contract — 探通 dsh-video-storyboard 的调用契约
 *
 * 为什么需要这个脚本：我们的 `adapters/render-storyboard.ts` 要接它的 `runStoryboard()`，
 * 但它返回的是一个几百字段的巨型对象（含 Buffer、PNG、逐格元数据），靠读源码猜字段
 * 一定会错。这个脚本跑一次真实视频，把**实际返回结构**打出来，作为适配层的唯一依据。
 *
 * 两个用途：
 *   1. Phase 1 写 adapter 时的字段字典
 *   2. **升级 dsh-video-storyboard 后重跑，diff 输出** —— 它的 0.6/0.7 都做过破坏性改版
 *      （cells/sheets/need 被删掉换成 maxFrames/strategy/maxSheets），
 *      契约变了必须第一时间知道，否则 adapter 会在运行期炸。
 *
 * 用法：
 *   node scripts/probe-storyboard-contract.mjs [视频路径]
 *   node scripts/probe-storyboard-contract.mjs --json out.json   # 落盘便于 diff
 */
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const jsonFlag = args.indexOf('--json')
const jsonOut = jsonFlag >= 0 ? args[jsonFlag + 1] : null
const input = args.find((a) => !a.startsWith('--') && a !== jsonOut)
  || 'tests/fixtures/watch-sample.mp4'

const { runStoryboard } = await import('dsh-video-storyboard/pipeline')
const { saveStoryboards } = await import('dsh-video-storyboard/pipeline')

/** 把对象压成「字段名: 类型(形状)」，递归但限制深度，Buffer 只报长度 */
function shapeOf(value, depth = 0, maxDepth = 3) {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Buffer.isBuffer(value)) return `Buffer(${value.length})`
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const head = shapeOf(value[0], depth + 1, maxDepth)
    return `Array(${value.length})<${head}>`
  }
  if (typeof value === 'object') {
    if (depth >= maxDepth) return `{…${Object.keys(value).length} keys}`
    const entries = Object.entries(value).map(([k, v]) => `  ${k}: ${shapeOf(v, depth + 1, maxDepth)}`)
    return `{\n${entries.join('\n')}\n}`
  }
  if (typeof value === 'string') return `string("${value.length > 60 ? `${value.slice(0, 60)}…` : value}")`
  return `${typeof value}(${String(value)})`
}

const started = Date.now()
const result = await runStoryboard({
  input,
  // 契约探针不跑 ASR：它依赖外部服务，会混淆「管道结构」和「ASR 有没有配」
  transcript: 'off',
  budget: 360_000,
  maxCanvasSide: 800,
  // 显式给策略，避免 auto 的决策逻辑让两次运行结果不可比
  strategy: 'compact',
})

console.log(`\n===== INPUT =====\n${input}`)
console.log(`耗时 ${((Date.now() - started) / 1000).toFixed(2)}s`)

// ── 顶层字段 ──
console.log('\n===== TOP-LEVEL KEYS =====')
console.log(Object.keys(result).sort().join('\n'))

// ── 关键子结构 ──
console.log('\n===== info =====')
console.log(JSON.stringify(result.info, null, 2))

console.log('\n===== window =====')
console.log(JSON.stringify(result.window, null, 2))

console.log('\n===== summary / threshold =====')
console.log(JSON.stringify({ summary: result.summary, threshold: result.threshold, cached: result.cached }, null, 2))

console.log(`\n===== cuts (${result.cuts.length}) =====`)
console.log(JSON.stringify(result.cuts.slice(0, 5), null, 2))

console.log('\n===== plan =====')
console.log(JSON.stringify(result.plan, null, 2))

console.log('\n===== transcript =====')
console.log(JSON.stringify(result.transcript, null, 2))

console.log('\n===== audio =====')
console.log(shapeOf(result.audio, 0, 2))

// ── sheets：这是适配层最关心的 ──
console.log(`\n===== sheets (${result.sheets.length}) =====`)
for (const [i, sheet] of result.sheets.entries()) {
  console.log(`--- sheet[${i}] ---`)
  console.log(JSON.stringify({
    sheet: sheet.sheet,
    cols: sheet.cols,
    rows: sheet.rows,
    cellW: sheet.cellW,
    cellH: sheet.cellH,
    width: sheet.width,
    height: sheet.height,
    croppedFrom: sheet.croppedFrom,
    headerH: sheet.headerH,
    stripH: sheet.stripH,
    cellsCount: sheet.cells.length,
    hasBuffer: Buffer.isBuffer(sheet.buffer),
    hasPng: Buffer.isBuffer(sheet.png),
    pngBytes: sheet.png?.length,
  }, null, 2))
  if (i === 0 && sheet.cells.length > 0) {
    console.log('  第一格完整结构：')
    console.log(JSON.stringify(sheet.cells[0], null, 2))
    console.log(`  其余 ${sheet.cells.length - 1} 格的键：${Object.keys(sheet.cells[1] ?? {}).join(', ')}`)
  }
}

// ── 落盘图片：适配层最终要的是文件 ──
const outDir = await mkdtemp(path.join(tmpdir(), 'storyboard-contract-'))
const target = path.join(outDir, 'sheet.png')
const written = await saveStoryboards(result, target, { quality: 4 })
console.log('\n===== saveStoryboards 产物 =====')
console.log(JSON.stringify(written, null, 2))
const { statSync } = await import('node:fs')
for (const file of written) {
  try {
    console.log(`  ${file}  ${statSync(file).size} bytes`)
  } catch {
    console.log(`  ${file}  (读取失败)`)
  }
}

// ── 可选：落 JSON 供 diff ──
if (jsonOut) {
  const slim = {
    input,
    topKeys: Object.keys(result).sort(),
    info: result.info,
    window: result.window,
    summary: result.summary,
    threshold: result.threshold,
    cutsCount: result.cuts.length,
    cutsHead: result.cuts.slice(0, 5),
    plan: result.plan,
    transcript: result.transcript,
    audioShape: shapeOf(result.audio, 0, 2),
    sheets: result.sheets.map((s) => ({
      sheet: s.sheet,
      width: s.width,
      height: s.height,
      cellW: s.cellW,
      cellH: s.cellH,
      cellsCount: s.cells.length,
      cellKeys: Object.keys(s.cells[0] ?? {}).sort(),
      firstCell: s.cells[0] ?? null,
    })),
    savedFiles: written,
  }
  await mkdir(path.dirname(jsonOut), { recursive: true }).catch(() => {})
  await writeFile(jsonOut, `${JSON.stringify(slim, null, 2)}\n`, 'utf8')
  console.log(`\n契约 JSON 已写入 ${jsonOut}`)
}
