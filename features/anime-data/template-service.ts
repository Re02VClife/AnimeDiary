/**
 * 模板服务 — 评分模板的 CRUD 与持久化
 *   负责模板的增删改查、默认模板管理、旧版维度迁移
 *   使用 localStorage 持久化
 */
import type { ScoreTemplate, Dimension, AnimeEntry } from '../../src/types';
import { DEFAULT_TEMPLATE_ID, createDefaultTemplate, DEFAULT_DIMENSIONS, DEFAULT_FIELD_CONFIG } from '../../src/types';

const TEMPLATES_KEY = 'anime_diary_templates';
const LEGACY_DIMENSIONS_KEY = 'anime_diary_dimensions';

// ── 模板读写 ──

/** 从 localStorage 加载全部模板，若无则创建默认模板 */
export function loadTemplates(): ScoreTemplate[] {
  try {
    const raw = localStorage.getItem(TEMPLATES_KEY);
    if (raw) {
      const templates: ScoreTemplate[] = JSON.parse(raw);
      if (templates.length > 0) return templates;
    }
  } catch { /* 数据损坏，回退到默认 */ }
  return [createDefaultTemplate()];
}

/** 保存全部模板到 localStorage */
export function saveTemplates(templates: ScoreTemplate[]): void {
  localStorage.setItem(TEMPLATES_KEY, JSON.stringify(templates));
}

/** 按 ID 查找模板，未找到返回默认模板 */
export function getTemplate(id: string | undefined): ScoreTemplate {
  const templates = loadTemplates();
  if (id) {
    const found = templates.find((t) => t.id === id);
    if (found) return found;
  }
  // 回退到默认模板
  return templates.find((t) => t.isDefault) || templates[0] || createDefaultTemplate();
}

/** 获取默认模板 */
export function getDefaultTemplate(): ScoreTemplate {
  const templates = loadTemplates();
  return templates.find((t) => t.isDefault) || templates[0] || createDefaultTemplate();
}

/** 根据条目获取其活跃的评分维度 */
export function getActiveDimensions(entry: AnimeEntry): Dimension[] {
  return getTemplate(entry.templateId).dimensions;
}

// ── 模板 CRUD ──

/** 新增模板 */
export function addTemplate(template: ScoreTemplate): void {
  const templates = loadTemplates();
  // 若设为默认，取消其他模板的默认标记
  if (template.isDefault) {
    templates.forEach((t) => { t.isDefault = false; });
  }
  templates.push(template);
  saveTemplates(templates);
}

/** 更新模板（部分合并） */
export function updateTemplate(id: string, partial: Partial<ScoreTemplate>): void {
  const templates = loadTemplates();
  const idx = templates.findIndex((t) => t.id === id);
  if (idx === -1) return;
  // 若设为默认，取消其他模板的默认标记
  if (partial.isDefault) {
    templates.forEach((t) => { t.isDefault = false; });
  }
  templates[idx] = { ...templates[idx], ...partial, updatedAt: new Date().toISOString().split('T')[0] };
  saveTemplates(templates);
}

/** 删除模板 */
export function deleteTemplate(id: string): boolean {
  // 禁止删除默认模板（如果它是唯一的模板）
  const templates = loadTemplates();
  if (templates.length <= 1) return false;
  const target = templates.find((t) => t.id === id);
  if (!target) return false;
  // 若删除的是默认模板，将第一个剩余模板设为默认
  const remaining = templates.filter((t) => t.id !== id);
  if (target.isDefault && remaining.length > 0) {
    remaining[0].isDefault = true;
  }
  saveTemplates(remaining);
  return true;
}

// ── 旧版迁移 ──

/**
 * 一次性迁移：将旧版 localStorage 维度数据转为默认模板
 * - 若有 `anime_diary_templates` → 跳过（已迁移）
 * - 若有 `anime_diary_dimensions` → 用旧维度作为默认模板的维度
 * - 否则 → 使用 DEFAULT_DIMENSIONS 创建默认模板
 * 迁移完成后删除旧 key
 */
export function migrateLegacyDimensions(): void {
  // 已迁移过，跳过
  if (localStorage.getItem(TEMPLATES_KEY)) return;

  let defaultDims: Dimension[] = DEFAULT_DIMENSIONS.map((d) => ({ ...d }));

  // 尝试读取旧版自定义维度
  try {
    const raw = localStorage.getItem(LEGACY_DIMENSIONS_KEY);
    if (raw) {
      const legacyDims: Dimension[] = JSON.parse(raw);
      if (Array.isArray(legacyDims) && legacyDims.length > 0) {
        defaultDims = legacyDims;
      }
    }
  } catch { /* 忽略解析错误 */ }

  const defaultTemplate: ScoreTemplate = {
    id: DEFAULT_TEMPLATE_ID,
    name: '番剧评分',
    applicableGenre: 'anime',
    dimensions: defaultDims,
    isDefault: true,
    fieldConfig: { ...DEFAULT_FIELD_CONFIG, customFields: [] },
    categoryLabels: {},
    createdAt: new Date().toISOString().split('T')[0],
    updatedAt: new Date().toISOString().split('T')[0],
  };

  saveTemplates([defaultTemplate]);

  // 删除旧 key
  try {
    localStorage.removeItem(LEGACY_DIMENSIONS_KEY);
  } catch { /* ignore */ }
}
