/**
 * server/settings — 拉片分析的性能设置（落盘 `{DATA_DIR}/watch-settings.json`）
 *
 * 为什么单独一个文件而不是塞进 ai-config.json：
 *   - 这是**分析**的偏好（CPU/进程优先级），和 AI 模型配置是两件事，混在一起会让
 *     "我只想分析得慢一点"变成"改 AI 配置"；
 *   - 侧车数据，不进 Excel（和 music-links / local-library 同一个约定）。
 *
 * 读取要**永不抛错**：配置文件被手改成坏 JSON 时回落到默认值，不能让拉片面板打不开。
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_PERFORMANCE,
  normalizeAsrChunkSeconds,
  normalizeCpuPercent,
  normalizePriority,
} from '../core/performance'
import type { PerformanceSettings, WatchPriority } from '../core/performance'

export interface WatchSettings extends PerformanceSettings {
  /** MOSS 低显存模式（预留字段，当前版本不生效；转写本来就是单段串行） */
  asrLowMemory: boolean
}

export const DEFAULT_WATCH_SETTINGS: WatchSettings = {
  ...DEFAULT_PERFORMANCE,
  asrLowMemory: false,
}

export interface WatchSettingsStore {
  /** 配置文件绝对路径（设置页显示"存在哪"用） */
  readonly file: string
  read(): WatchSettings
  /** 只覆盖传入的字段，其余保持原值；返回合并后的完整设置 */
  write(patch: Partial<WatchSettings>): WatchSettings
}

function sanitize(raw: unknown): WatchSettings {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    cpuPercent: normalizeCpuPercent(record.cpuPercent),
    priority: normalizePriority(record.priority as WatchPriority),
    asrChunkSeconds: normalizeAsrChunkSeconds(record.asrChunkSeconds),
    asrLowMemory: record.asrLowMemory === true,
  }
}

export function createWatchSettings(DATA_DIR: string): WatchSettingsStore {
  const file = path.join(DATA_DIR, 'watch-settings.json')

  function read(): WatchSettings {
    try {
      if (!fs.existsSync(file)) return { ...DEFAULT_WATCH_SETTINGS }
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
      return sanitize(parsed)
    } catch {
      // 坏文件/读盘失败都回落默认值 —— 设置坏了不该让分析功能不可用
      return { ...DEFAULT_WATCH_SETTINGS }
    }
  }

  function write(patch: Partial<WatchSettings>): WatchSettings {
    const next = sanitize({ ...read(), ...patch })
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true })
      fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8')
    } catch {
      // 落盘失败时仍把内存里的结果返回给前端，下次读取会回到旧值 —— 不假装成功
    }
    return next
  }

  return { file, read, write }
}
