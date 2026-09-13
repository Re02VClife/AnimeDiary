/**
 * 模板服务 — 评分模板的 CRUD 与持久化
 *   负责模板的增删改查、默认模板管理、旧版维度迁移
 *   使用 localStorage 持久化
 */
import type { ScoreTemplate, Dimension, AnimeEntry } from '../../src/types';
import { DEFAULT_TEMPLATE_ID, createDefaultTemplate, DEFAULT_DIMENSIONS, DEFAULT_FIELD_CONFIG, DEFAULT_DETAIL_LAYOUT, DEFAULT_CATEGORY_LABELS, CHARACTER_TEMPLATE_ID, createCharacterTemplate } from '../../src/types';

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

/**
 * 解析模板里的海报默认焦点（object-position 的两个百分数）→ { x, y }。
 *
 * 用于两处渲染：网格卡片和详情面板。角色立绘是全身竖图（实测宽高比 0.35），
 * 用默认的居中裁切会把最上方的脸裁掉，所以角色模板把焦点设成 '50% 0%' 锚定顶部。
 * 非法/缺失时回退居中（保持番剧海报原有行为不变）。
 */
export function parsePosterFocus(raw?: string): { x: number; y: number } {
  const matched = String(raw ?? '').match(/(-?\d+(?:\.\d+)?)\s*%\s+(-?\d+(?:\.\d+)?)\s*%/);
  if (!matched) return { x: 50, y: 50 };
  const clamp = (n: number) => Math.min(100, Math.max(0, n));
  return { x: clamp(Number(matched[1])), y: clamp(Number(matched[2])) };
}

/** 条目海报的裁剪位置：条目级拖拽位置 > 模板默认焦点 > 居中（由 CSS 决定） */
export function getPosterObjectPosition(
  templateId: string | undefined,
  entryPosition?: { x: number; y: number },
): string | undefined {
  if (entryPosition) return `${entryPosition.x}% ${entryPosition.y}%`;
  const focus = getTemplate(templateId).layoutConfig?.posterObjectPosition;
  return focus && focus.trim() ? focus : undefined;
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
    // 必须和 createDefaultTemplate() 保持同形：以前这里漏了 layoutConfig，
    // 于是「老用户迁移出来的默认模板」和「新用户的默认模板」字段不一致，
    // 读 layoutConfig 的地方全靠调用方自己兜底（海报焦点就是这么踩到的）。
    layoutConfig: { ...DEFAULT_DETAIL_LAYOUT },
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

const CHARACTER_SEED_FLAG = 'anime_diary_character_seeded';

/** 角色模板最新种子版本 */
const CHARACTER_SEED_VERSION = '5';

/**
 * 种子：补插内置角色评分模板（版本化，当前 v5）
 * - flag 记录已种子版本 → 用户删除后不会复活（尊重删除）
 * - 每次版本升级就地更新已有模板（v1→v2 宽高比，v2→v3 删除剧情作用维度，
 *   v3→v4 新增「详细人设」字段，v4→v5 海报焦点锚定顶部）
 * - 内部先跑 migrateLegacyDimensions（幂等），兼容全新用户与旧版维度用户
 * - 必须在 React 首次渲染前调用（App.tsx 的 loadTemplates useMemo 只求值一次）
 */
export function seedCharacterTemplate(): void {
  const seeded = localStorage.getItem(CHARACTER_SEED_FLAG);
  if (seeded === CHARACTER_SEED_VERSION) return;
  migrateLegacyDimensions();
  const templates = loadTemplates();
  const existing = templates.find((t) => t.id === CHARACTER_TEMPLATE_ID);
  if (!seeded && !existing) {
    // 首次种子：补插
    templates.push(createCharacterTemplate());
    saveTemplates(templates);
  } else if (existing) {
    // 更新已有模板：维度用最新工厂定义覆盖（删除 char_role、权重 1/6）
    const latest = createCharacterTemplate();
    const hasCharRole = existing.dimensions.some((d: Dimension) => d.key === 'char_role');
    if (hasCharRole || seeded !== CHARACTER_SEED_VERSION) {
      existing.dimensions = latest.dimensions;
      existing.categoryLabels = latest.categoryLabels;
      // 自定义字段：内置的以最新定义覆盖，**用户自己加的保留**。
      // 整体覆盖会在版本升级时把用户新增的字段悄悄删掉 —— v3→v4 新增
      // 「详细人设」时才发现这条路径会在现有安装上第一次真正执行。
      const builtinKeys = new Set(latest.fieldConfig.customFields.map((f) => f.key));
      const userAdded = (existing.fieldConfig?.customFields || [])
        .filter((f) => !builtinKeys.has(f.key));
      existing.fieldConfig = {
        ...latest.fieldConfig,
        customFields: [...latest.fieldConfig.customFields, ...userAdded],
      };
      // 布局配置：同样只补缺，不覆盖用户调过的值。
      // v4→v5 新增的 posterObjectPosition 必须补进来，否则老安装的角色卡
      // 仍会按居中裁切、把立绘的脸裁掉。
      const baseLayout = latest.layoutConfig ?? DEFAULT_DETAIL_LAYOUT;
      existing.layoutConfig = existing.layoutConfig
        ? { ...baseLayout, ...existing.layoutConfig }
        : { ...baseLayout };
      saveTemplates(templates);
    }
  }
  // seeded 过但模板不存在 = 用户已删除 → 不复活
  localStorage.setItem(CHARACTER_SEED_FLAG, CHARACTER_SEED_VERSION);
}

/** 分类标签迁移标记：只跑一次，之后尊重用户的自定义（包括故意清空） */
const CATEGORY_LABELS_MIGRATED_FLAG = 'anime_diary_category_labels_migrated';

/**
 * 迁移：早期版本创建的模板 categoryLabels 是空对象，
 * 而设计中「全部留空」表示"不显示分类 tab"，于是顶栏少了一整排分类。
 * 这里给默认模板补上默认分类标签 —— 只跑一次，之后你可以自行改或清空。
 */
export function migrateCategoryLabels(): void {
  try {
    if (localStorage.getItem(CATEGORY_LABELS_MIGRATED_FLAG) === '1') return;
    localStorage.setItem(CATEGORY_LABELS_MIGRATED_FLAG, '1');

    const templates = loadTemplates();
    const target =
      templates.find((t) => t.id === DEFAULT_TEMPLATE_ID) || templates.find((t) => t.isDefault);
    if (!target) return;

    // 只有"一个都没配"时才填，避免覆盖用户已有的自定义名称
    const labels = target.categoryLabels || {};
    const hasAny = Object.values(labels).some((v) => v && String(v).trim() !== '');
    if (hasAny) return;

    target.categoryLabels = { ...DEFAULT_CATEGORY_LABELS };
    saveTemplates(templates);
  } catch {
    /* 迁移失败不影响使用 */
  }
}
