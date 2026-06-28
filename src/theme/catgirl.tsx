/**
 * 猫娘模式 — 文本猫娘化工具 + AI 提示词包装 + message 包装
 * 将用户可见的描述文本、交互文本用猫娘口吻表述（可加颜文字）
 */

import { message } from 'antd';
import { useTheme } from './ThemeContext';
import { THEME_STORAGE_KEY } from './types';

// ── 猫娘化规则 ──

/** 句尾添加的颜文字 */
const KAOMOJI_TAIL = ['喵~', '(｡･ω･｡)', '(=^･ω･^=)', '喵呜~', '(ฅ´ω`ฅ)'];

/** 随机取一个颜文字 */
const randKaomoji = (): string =>
  KAOMOJI_TAIL[Math.floor(Math.random() * KAOMOJI_TAIL.length)];

/** 替换规则表（按优先级排列） */
const REPLACE_RULES: Array<[RegExp, string]> = [
  // "失败" → "失败喵…"
  [/失败/g, '失败喵…'],
  // "错误" → "出错了喵"
  [/错误/g, '出错了喵'],
  // "吗？" → "喵？"
  [/吗？/g, '喵？'],
  // "吗" + 标点 → "喵" + 标点
  [/吗([。，！？、])/g, '喵$1'],
  // "请先" → "请主人先"
  [/请先/g, '请主人先'],
  // "请至少" → "请主人至少"
  [/请至少/g, '请主人至少'],
  // "保存" → "保存喵"
  [/保存/g, '保存喵'],
  // "删除" → "删除喵~"
  [/删除/g, '删除喵~'],
  // "导入" → "导入喵"  (但在"导入失败"中已被"失败"规则覆盖)
  // "导出" → "导出喵"
  [/导出([^失])/g, '导出喵$1'],
  [/导出$/g, '导出喵'],
  // "已" + 完成类动词 → 追加猫娘语气
  [/^已将/g, '已经帮主人将'],
  [/^已导入/g, '已经帮主人导入喵'],
  [/^已导出/g, '已经帮主人导出喵'],
  [/^已保存/g, '已经帮主人保存喵'],
  [/^已添加/g, '已经帮主人添加喵'],
  [/^已删除/g, '已经帮主人删除喵~'],
  [/^已持久化/g, '已经帮主人持久化喵'],
  [/^已全局删除/g, '已经帮主人全局删除喵~'],
  [/^检索名修正完成/g, '检索名修正完成喵~'],
  // "没有"类否定 → 添加猫娘无奈语气
  [/^没有需要/g, '还没有需要'],
  [/^没有可修正/g, '还没有可修正'],
];

/**
 * 将普通中文文本猫娘化
 */
export const catgirlfy = (text: string): string => {
  let result = text;

  // 应用替换规则
  for (const [pattern, replacement] of REPLACE_RULES) {
    result = result.replace(pattern, replacement);
  }

  // 句尾追加颜文字（如果还没有喵相关结尾）
  if (/[。！!]$/.test(result) && !/[喵~）)…]$/.test(result)) {
    result = result.replace(/[。！!]$/, (m) => m + ' ' + randKaomoji());
  } else if (!/[喵~）)…]$/.test(result) && result.length > 2) {
    result = result + ' ' + randKaomoji();
  }

  return result;
};

/**
 * 包装 AI system prompt，追加猫娘角色设定
 */
export const catgirlSystemPrompt = (original: string): string => {
  return `[角色设定]
你是一只番剧分析猫娘！必须严格遵守以下设定：
- 用"喵~"作为句尾语气词，自称"本喵"，称呼用户为"主人"
- 保持专业分析能力，但用活泼可爱的猫娘口吻表达
- 适当使用颜文字：喵~ (｡･ω･｡) (=^･ω･^=) (ฅ´ω\`ฅ)
- 主人问什么就回答什么，不要偏离主题
- 输出格式要求和数据结构与原始任务完全一致，只是语气变成猫娘

[原始任务]
${original}`;
};

// ── 读取猫娘模式（纯函数，用于非 React 上下文） ──
export const isCatgirlMode = (): boolean => {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return !!parsed.catgirlMode;
    }
  } catch { /* ignore */ }
  return false;
};

// ── 包装后的 message API ──
/**
 * 猫娘化 message 工具 — 替代 antd message 直接使用
 * 猫娘模式下自动转换文本
 */
export const catgirlMessage = {
  success: (text: string) =>
    message.success(isCatgirlMode() ? catgirlfy(text) : text),
  error: (text: string) =>
    message.error(isCatgirlMode() ? catgirlfy(text) : text),
  warning: (text: string) =>
    message.warning(isCatgirlMode() ? catgirlfy(text) : text),
  info: (text: string) =>
    message.info(isCatgirlMode() ? catgirlfy(text) : text),
  loading: (text: string, duration?: number) =>
    message.loading(isCatgirlMode() ? catgirlfy(text) : text, duration),
};

// ── React Hook ──

/**
 * 猫娘模式文本 hook
 * 在组件中使用：const { t } = useCatgirlText(); 然后 t('AI 配置已保存')
 */
export const useCatgirlText = () => {
  const { state } = useTheme();

  const t = (text: string): string => {
    if (!state.catgirlMode) return text;
    return catgirlfy(text);
  };

  return { t };
};
