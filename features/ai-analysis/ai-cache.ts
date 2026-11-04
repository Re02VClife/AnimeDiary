/**
 * features/ai-analysis/ai-cache — 分析结果缓存（指纹 + 12 小时过期）
 *
 * 之前只按 24 小时过期，数据早就改了还拿旧报告；这里给每份结果带一个
 * 「数据指纹」：番剧集合 / 分数 / 评语 / 模型 任一变化就自动失效。
 */

import type { AnimeEntry } from '../../src/types';
import type { PreferenceProfile, TasteReport } from './ai-types';
import { loadAIConfig } from './ai-config';

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  fingerprint: string;
  model: string;
}

const PROFILE_KEY = 'anime_diary_ai_profile_cache_v2';
const TASTE_KEY = 'anime_diary_ai_taste_cache_v2';
const TTL = 12 * 60 * 60 * 1000;

/** FNV-1a：够用的短哈希，不需要加密强度 */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** 一份数据指纹：条目 id + 各维度分数 + 评语长度 + 模板 */
export function buildListFingerprint(animeList: AnimeEntry[], extra = ''): string {
  const parts = [...animeList]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((a) => [
      a.id,
      a.title,
      a.templateId || '',
      a.bangumiScore ?? '',
      a.scores.map((s) => `${s.dimensionKey}:${s.score}`).join(','),
      a.tags.map((t) => t.name).join('|'),
      (a.review || '').length,
      a.releaseDate || '',
    ].join('/'));
  return fnv1a([
    loadAIConfig().model,
    loadAIConfig().provider,
    extra,
    parts.join(';'),
  ].join('#'));
}

function save<T>(key: string, data: T, fingerprint: string): void {
  const entry: CacheEntry<T> = {
    data,
    timestamp: Date.now(),
    fingerprint,
    model: loadAIConfig().model,
  };
  try { localStorage.setItem(key, JSON.stringify(entry)); } catch { /* 存储满 */ }
}

function load<T>(key: string, fingerprint?: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const entry: CacheEntry<T> = JSON.parse(raw);
    if (!entry?.data) return null;
    if (Date.now() - entry.timestamp > TTL) {
      localStorage.removeItem(key);
      return null;
    }
    if (fingerprint && entry.fingerprint && entry.fingerprint !== fingerprint) return null;
    if (fingerprint && !entry.fingerprint) return null;
    return entry.data;
  } catch {
    return null;
  }
}

// ── 偏好画像 ──

export function saveProfileCache(profile: PreferenceProfile, fingerprint?: string): void {
  save(PROFILE_KEY, profile, fingerprint || buildListFingerprint([]));
}

export function loadProfileCache(fingerprint?: string): PreferenceProfile | null {
  return load<PreferenceProfile>(PROFILE_KEY, fingerprint);
}

// ── 品味报告 ──

export function saveTasteCache(report: TasteReport, fingerprint?: string): void {
  save(TASTE_KEY, report, fingerprint || buildListFingerprint([]));
}

export function loadTasteCache(fingerprint?: string): TasteReport | null {
  return load<TasteReport>(TASTE_KEY, fingerprint);
}

// ── 清理 ──

export function clearAICache(): void {
  localStorage.removeItem(PROFILE_KEY);
  localStorage.removeItem(TASTE_KEY);
  // 老版本的键也一并清掉
  localStorage.removeItem('anime_diary_ai_profile_cache');
  localStorage.removeItem('anime_diary_ai_taste_cache');
}
