/**
 * AI 分析结果缓存 — localStorage 持久化 + 24 小时过期策略
 */

import type { PreferenceProfile, TasteReport } from './ai-types';

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const PROFILE_KEY = 'anime_diary_ai_profile_cache';
const TASTE_KEY = 'anime_diary_ai_taste_cache';
const TTL = 24 * 60 * 60 * 1000; // 24 小时

function isExpired(timestamp: number): boolean {
  return Date.now() - timestamp > TTL;
}

function save<T>(key: string, data: T): void {
  const entry: CacheEntry<T> = { data, timestamp: Date.now() };
  try { localStorage.setItem(key, JSON.stringify(entry)); } catch { /* 存储满 */ }
}

function load<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const entry: CacheEntry<T> = JSON.parse(raw);
    if (isExpired(entry.timestamp)) {
      localStorage.removeItem(key);
      return null;
    }
    return entry.data;
  } catch { return null; }
}

// ── 偏好画像缓存 ──

export function saveProfileCache(profile: PreferenceProfile): void {
  save(PROFILE_KEY, profile);
}

export function loadProfileCache(): PreferenceProfile | null {
  return load<PreferenceProfile>(PROFILE_KEY);
}

// ── 品味报告缓存 ──

export function saveTasteCache(report: TasteReport): void {
  save(TASTE_KEY, report);
}

export function loadTasteCache(): TasteReport | null {
  return load<TasteReport>(TASTE_KEY);
}

// ── 清理 ──

export function clearAICache(): void {
  localStorage.removeItem(PROFILE_KEY);
  localStorage.removeItem(TASTE_KEY);
}
