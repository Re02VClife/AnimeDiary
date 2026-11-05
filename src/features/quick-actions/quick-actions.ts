/**
 * 顶栏快捷栏：可配置的功能入口
 *
 * 顶栏右侧原先只有「模板 / 批量工具 / 新增」三个控件，分类栏折叠后空出一段宽度。
 * 这里把低频但想一步直达的功能做成可选按钮：默认只放「录制 GIF」和「AI 对话」，
 * 其余由用户在设置里勾选。
 *
 * 配置存 localStorage，并用一个 window 事件在「顶栏」与「设置面板」之间同步 ——
 * 两边各自持有 hook，不经过 App 的 state，避免为了一个 UI 偏好在整棵树上提状态。
 */
import { useCallback, useEffect, useState } from 'react';

export type QuickActionId =
  | 'gif'
  | 'ai-chat'
  | 'complete-data'
  | 'complete-characters'
  | 'cutout'
  | 'knowledge-graph'
  | 'taste-report'
  | 'excel'
  | 'backup'
  | 'template-manager'
  | 'ai-settings';

export interface QuickActionDef {
  id: QuickActionId;
  /** 按钮 tooltip 与设置项标题 */
  label: string;
  /** 设置项里的说明 */
  hint: string;
  /** 与项目其它图标一致的 emoji 风格 */
  icon: string;
}

/** 可放进快捷栏的动作。顺序即设置面板里的展示顺序。 */
export const QUICK_ACTIONS: QuickActionDef[] = [
  { id: 'gif', label: '录制 GIF', hint: '打开屏幕录制 / 截图面板，录完直接转 GIF', icon: '🎞️' },
  { id: 'ai-chat', label: 'AI 对话', hint: '右侧抽屉，问评分、找番、让它改数据', icon: '💬' },
  { id: 'taste-report', label: '品味分析', hint: '用 AI 生成偏好画像与品味报告', icon: '📊' },
  { id: 'complete-data', label: '数据补全', hint: '从 Bangumi / Bilibili 批量补元数据与封面', icon: '☁️' },
  { id: 'complete-characters', label: '角色补全', hint: '搜立绘 / 声优 / 生日，生成角色卡', icon: '🧑‍🎤' },
  { id: 'cutout', label: '去白底', hint: '把角色立绘的白底变透明（可撤销）', icon: '🪄' },
  { id: 'knowledge-graph', label: '知识图谱', hint: '全屏查看番剧关系网络', icon: '🕸️' },
  { id: 'excel', label: '表格视图', hint: '在应用内直接改列表原始数据', icon: '📋' },
  { id: 'backup', label: '存档回退', hint: '快照列表 + 操作记录', icon: '🗄️' },
  { id: 'template-manager', label: '维度管理', hint: '编辑评分模板的维度、权重与字段', icon: '📐' },
  { id: 'ai-settings', label: 'AI 设置', hint: '选择服务商、模型与 API Key', icon: '⚙️' },
];

export const QUICK_ACTION_MAP: Record<QuickActionId, QuickActionDef> = Object.fromEntries(
  QUICK_ACTIONS.map((a) => [a.id, a]),
) as Record<QuickActionId, QuickActionDef>;

/** 顶栏同时放太多按钮会把右侧挤爆，超过这个数量在设置里就勾不上 */
export const MAX_QUICK_ACTIONS = 5;

const STORAGE_KEY = 'anime_diary_quick_actions';
const CHANGE_EVENT = 'anime_diary_quick_actions_changed';

const DEFAULT_IDS: QuickActionId[] = ['gif', 'ai-chat'];

function isValidId(id: unknown): id is QuickActionId {
  return typeof id === 'string' && id in QUICK_ACTION_MAP;
}

/** 读取配置；localStorage 里没有 key 时返回默认值（空数组是合法选择，不能当成没配置） */
export function loadQuickActionIds(): QuickActionId[] {
  if (typeof window === 'undefined') return DEFAULT_IDS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_IDS;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_IDS;
    const ids = parsed.filter(isValidId).slice(0, MAX_QUICK_ACTIONS);
    // 去重，防止手工改坏配置后出现两个一样的按钮
    return Array.from(new Set(ids));
  } catch {
    return DEFAULT_IDS;
  }
}

export function saveQuickActionIds(ids: QuickActionId[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids.slice(0, MAX_QUICK_ACTIONS)));
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    /* 存储写入失败不影响当前会话 */
  }
}

/**
 * 顶栏与设置面板共用的配置 hook。
 * 返回的 setIds 会做上限校验；toggle 方便设置面板做勾选。
 */
export function useQuickActionIds() {
  const [ids, setIds] = useState<QuickActionId[]>(loadQuickActionIds);

  useEffect(() => {
    const sync = () => setIds(loadQuickActionIds());
    window.addEventListener(CHANGE_EVENT, sync);
    // 同一窗口里 storage 事件不会触发，所以用自定义事件；这里额外监听 storage
    // 以便未来多窗口时也能同步。
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const update = useCallback((next: QuickActionId[]) => {
    saveQuickActionIds(next);
    setIds(loadQuickActionIds());
  }, []);

  const toggle = useCallback((id: QuickActionId): { ok: boolean; ids: QuickActionId[] } => {
    const current = loadQuickActionIds();
    if (current.includes(id)) {
      const next = current.filter((x) => x !== id);
      saveQuickActionIds(next);
      setIds(next);
      return { ok: true, ids: next };
    }
    if (current.length >= MAX_QUICK_ACTIONS) {
      return { ok: false, ids: current };
    }
    const next = [...current, id];
    saveQuickActionIds(next);
    setIds(next);
    return { ok: true, ids: next };
  }, []);

  return { ids, setIds: update, toggle };
}
