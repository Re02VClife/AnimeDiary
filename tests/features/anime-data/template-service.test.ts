/**
 * 角色模板种子（seedCharacterTemplate）单元测试
 *
 * 重点：版本升级时**不能删掉用户自己加的自定义字段**。
 * v3→v4 新增「详细人设」时才发现，原来这条路径写的是
 * `existing.fieldConfig = latest.fieldConfig` 整体覆盖 ——
 * 而这次升级会在所有现存安装上第一次真正执行，会把用户加的字段悄悄删掉。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { seedCharacterTemplate, parsePosterFocus, getPosterObjectPosition } from '../../../features/anime-data/template-service';
import { CHARACTER_TEMPLATE_ID, createCharacterTemplate } from '../../../src/types';

const TEMPLATES_KEY = 'anime_diary_templates';
const SEED_FLAG = 'anime_diary_character_seeded';

function storedTemplates() {
  return JSON.parse(localStorage.getItem(TEMPLATES_KEY) || '[]');
}

describe('seedCharacterTemplate', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('首次运行会补插角色模板，且带上「详细人设」字段', () => {
    seedCharacterTemplate();
    const character = storedTemplates().find((t: any) => t.id === CHARACTER_TEMPLATE_ID);
    expect(character).toBeTruthy();
    const keys = character.fieldConfig.customFields.map((f: any) => f.key);
    expect(keys).toContain('char_source');
    expect(keys).toContain('char_cv');
    expect(keys).toContain('char_birthday');
    expect(keys).toContain('char_profile');
    // 长文本要用 textarea，单行 Input 编辑不了 500~1500 字的人设
    const profile = character.fieldConfig.customFields.find((f: any) => f.key === 'char_profile');
    expect(profile.type).toBe('textarea');
  });

  it('已是最新版本时不重复写入', () => {
    seedCharacterTemplate();
    const first = localStorage.getItem(TEMPLATES_KEY);
    seedCharacterTemplate();
    expect(localStorage.getItem(TEMPLATES_KEY)).toBe(first);
  });

  it('回归：版本升级时保留用户自己加的自定义字段', () => {
    // 造一个「已种子过 v3、且用户自己加过一个字段」的状态
    const template = createCharacterTemplate();
    template.fieldConfig.customFields = template.fieldConfig.customFields
      .filter((f: any) => f.key !== 'char_profile');
    template.fieldConfig.customFields.push({ key: 'my_note', label: '我的备注', type: 'text' });
    localStorage.setItem(TEMPLATES_KEY, JSON.stringify([template]));
    localStorage.setItem(SEED_FLAG, '3'); // 旧版本

    seedCharacterTemplate();

    const keys = storedTemplates()[0].fieldConfig.customFields.map((f: any) => f.key);
    expect(keys).toContain('my_note');       // 用户加的字段必须还在
    expect(keys).toContain('char_profile');  // 新版本字段要补上
  });

  it('用户删除过角色模板时不复活（尊重删除）', () => {
    localStorage.setItem(TEMPLATES_KEY, JSON.stringify([]));
    localStorage.setItem(SEED_FLAG, '3');
    seedCharacterTemplate();
    expect(storedTemplates().find((t: any) => t.id === CHARACTER_TEMPLATE_ID)).toBeUndefined();
  });

  it('回归：v4→v5 升级要补上海报焦点，否则老安装的角色卡仍把立绘的脸裁掉', () => {
    // 造一个 v4 状态：有 char_profile，但 layoutConfig 里没有 posterObjectPosition
    const template = createCharacterTemplate();
    delete (template.layoutConfig as any).posterObjectPosition;
    localStorage.setItem(TEMPLATES_KEY, JSON.stringify([template]));
    localStorage.setItem(SEED_FLAG, '4');

    seedCharacterTemplate();

    const layout = storedTemplates()[0].layoutConfig;
    expect(layout.posterObjectPosition).toBe('50% 0%');
    expect(layout.posterAspectRatio).toBe('1/2');
  });

  it('回归：布局升级不覆盖用户调过的比例', () => {
    const template = createCharacterTemplate();
    delete (template.layoutConfig as any).posterObjectPosition;
    template.layoutConfig!.posterAspectRatio = '3/4'; // 用户手动改过
    localStorage.setItem(TEMPLATES_KEY, JSON.stringify([template]));
    localStorage.setItem(SEED_FLAG, '4');

    seedCharacterTemplate();

    const layout = storedTemplates()[0].layoutConfig;
    expect(layout.posterAspectRatio).toBe('3/4');      // 保留用户值
    expect(layout.posterObjectPosition).toBe('50% 0%'); // 只补缺
  });
});

describe('parsePosterFocus', () => {
  it('解析 object-position 的两个百分数', () => {
    expect(parsePosterFocus('50% 0%')).toEqual({ x: 50, y: 0 });
    expect(parsePosterFocus('50% 50%')).toEqual({ x: 50, y: 50 });
    expect(parsePosterFocus('0% 100%')).toEqual({ x: 0, y: 100 });
  });

  it('容忍多余空格', () => {
    expect(parsePosterFocus('  30%   70% ')).toEqual({ x: 30, y: 70 });
  });

  it('缺失或非法时回退居中（保持番剧海报原有行为）', () => {
    expect(parsePosterFocus(undefined)).toEqual({ x: 50, y: 50 });
    expect(parsePosterFocus('')).toEqual({ x: 50, y: 50 });
    expect(parsePosterFocus('center')).toEqual({ x: 50, y: 50 });
    expect(parsePosterFocus('50%')).toEqual({ x: 50, y: 50 });
  });

  it('越界值被夹到 0-100', () => {
    expect(parsePosterFocus('200% -10%')).toEqual({ x: 100, y: 0 });
  });
});

describe('getPosterObjectPosition', () => {
  beforeEach(() => {
    localStorage.clear();
    seedCharacterTemplate();
  });

  it('条目级拖拽位置优先于模板默认', () => {
    expect(getPosterObjectPosition('default', { x: 12, y: 34 })).toBe('12% 34%');
    expect(getPosterObjectPosition(CHARACTER_TEMPLATE_ID, { x: 12, y: 34 })).toBe('12% 34%');
  });

  it('没有条目级位置时用模板默认焦点', () => {
    expect(getPosterObjectPosition(CHARACTER_TEMPLATE_ID)).toBe('50% 0%');
    expect(getPosterObjectPosition('default')).toBe('50% 50%');
  });

  it('未知模板回退到默认模板（居中）', () => {
    expect(getPosterObjectPosition('不存在的模板')).toBe('50% 50%');
  });
});
