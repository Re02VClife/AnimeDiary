/**
 * features/character-complete/character-service 单元测试
 *
 * 只测纯函数（类型推断 / 名字匹配 / 卡片拼装），网络部分靠运行时脚本验证。
 * 重点：匹配错了会把别人的立绘和生日做成你的角色卡，所以「不可信」必须能识别出来。
 */
import { describe, it, expect } from 'vitest';
import {
  inferSubjectTypes,
  resolveSubjectTypes,
  matchRecordedNames,
  buildCharacterCardEntry,
  mergeCharacterCardData,
  mergeDetailIntoListed,
} from '../../../features/character-complete/character-service';
import type { CharacterEntry, WorkCandidate } from '../../../features/character-complete/character-service';
import { CHARACTER_TEMPLATE_ID } from '../../../src/types';

function character(partial: Partial<CharacterEntry>): CharacterEntry {
  return {
    sourceId: '1',
    name: '',
    nameCn: null,
    relation: '主角',
    summary: null,
    aliases: [],
    gender: null,
    birthday: null,
    bloodType: null,
    height: null,
    weight: null,
    bwh: null,
    referenceUrl: null,
    imageUrl: null,
    imageThumbUrl: null,
    voiceActors: [],
    works: [],
    aniListId: null,
    age: null,
    popularity: null,
    profile: null,
    detailLoaded: true,
    ...partial,
  };
}

const work: WorkCandidate = { sourceId: '400602', type: 2, title: '葬送のフリーレン', titleCn: '葬送的芙莉莲' };

describe('inferSubjectTypes', () => {
  it('番剧/剧场版 → 动画(type 2)', () => {
    expect(inferSubjectTypes('anime')).toEqual([2]);
    expect(inferSubjectTypes('movie')).toEqual([2]);
  });

  it('书籍 → type 1，游戏 → type 4', () => {
    expect(inferSubjectTypes('book')).toEqual([1]);
    expect(inferSubjectTypes('game')).toEqual([4]);
  });

  it('自定义模板无从判断 → 放宽到常见三类，由标题相似度挑', () => {
    expect(inferSubjectTypes('custom')).toEqual([1, 2, 4]);
    expect(inferSubjectTypes(undefined)).toEqual([1, 2, 4]);
  });

  it('回归：不能默认只搜动画 —— 同一标题在 Bangumi 上常有书籍/动画多个条目', () => {
    // 「路人女主的养成方法」的前三个搜索结果全是书籍(type 1)，
    // 用户如果记的是轻小说，就必须按 book 去搜，否则挂到动画上
    expect(inferSubjectTypes('book')).not.toEqual([2]);
  });
});

describe('resolveSubjectTypes', () => {
  it('自动模式按模板类别推断', () => {
    expect(resolveSubjectTypes('auto', 'game')).toEqual([4]);
    expect(resolveSubjectTypes('auto', 'book')).toEqual([1]);
  });

  it('显式选择覆盖模板推断', () => {
    expect(resolveSubjectTypes('2', 'game')).toEqual([2]);
    expect(resolveSubjectTypes('4', 'anime')).toEqual([4]);
  });

  it('不限返回 undefined（服务端会搜所有类型）', () => {
    expect(resolveSubjectTypes('all', 'anime')).toBeUndefined();
  });
});

describe('matchRecordedNames', () => {
  const list = [
    character({ sourceId: '101', name: 'フリーレン', nameCn: '芙莉莲' }),
    character({ sourceId: '102', name: 'フェルン', nameCn: '菲伦' }),
    character({ sourceId: '103', name: 'ヒンメル', nameCn: '辛美尔' }),
  ];

  it('按简体中文名匹配到正确的人', () => {
    const [m] = matchRecordedNames(list, ['菲伦']);
    expect(m.character?.name).toBe('フェルン');
    expect(m.score).toBe(1);
    expect(m.lowConfidence).toBe(false);
  });

  it('找不到时 character 为 null（不能瞎给一个）', () => {
    const [m] = matchRecordedNames(list, ['孙悟空']);
    expect(m.character).toBeNull();
    expect(m.lowConfidence).toBe(true);
  });

  it('回归：只有弱匹配时标记为不可信，但仍保留最佳候选供人工判断', () => {
    // 详情没抓到（缺中文名）时，中文名对日文原名会得到低分
    const noDetail = [character({ sourceId: '201', name: '加藤恵', nameCn: null })];
    const [m] = matchRecordedNames(noDetail, ['加藤惠']);
    expect(m.character).toBeNull();
    expect(m.lowConfidence).toBe(true);
    expect(m.score).toBeGreaterThan(0);      // 有候选
    expect(m.score).toBeLessThan(0.6);       // 但不可信
  });

  it('多个名字各自独立匹配', () => {
    const ms = matchRecordedNames(list, ['芙莉莲', '辛美尔', '不存在的人']);
    expect(ms.map((m) => m.character?.sourceId || null)).toEqual(['101', '103', null]);
  });

  it('空列表不崩', () => {
    expect(matchRecordedNames([], [])).toEqual([]);
  });
});

describe('buildCharacterCardEntry', () => {
  const full = character({
    sourceId: '86246',
    name: 'フリーレン',
    nameCn: '芙莉莲',
    relation: '主角',
    birthday: '09-27',
    bloodType: 'A',
    height: '168',
    aliases: ['Frieren'],
    imageUrl: 'https://lain.bgm.tv/x.jpg',
    voiceActors: [{ sourceId: '7575', name: '種﨑敦美', imageUrl: null, summary: null }],
    profile: { text: '千年以上的精灵魔法使。', source: 'bangumi', lang: 'ja' },
  });

  it('是角色模板的新条目，评分与评价留空（那是用户自己要打的）', () => {
    const card = buildCharacterCardEntry({ character: full, fallbackWork: work });
    expect(card.templateId).toBe(CHARACTER_TEMPLATE_ID);
    expect(card.scores).toEqual([]);
    expect(card.review).toBeUndefined();
    expect(card.tags).toEqual([]);
  });

  it('标题优先用简体中文名，没有则回退原名', () => {
    expect(buildCharacterCardEntry({ character: full, fallbackWork: work }).title).toBe('芙莉莲');
    expect(buildCharacterCardEntry({
      character: character({ name: 'ホロ', nameCn: null }), fallbackWork: work,
    }).title).toBe('ホロ');
  });

  it('把声优/生日/人设/所属作品填进角色卡字段', () => {
    const card = buildCharacterCardEntry({
      character: full, fallbackWork: work, sourceWorkName: '葬送的芙莉莲',
      localPosterUrl: '/api/images/file?anime=x&file=cover.jpg',
    });
    expect(card.customFields?.char_source).toBe('葬送的芙莉莲');
    expect(card.customFields?.char_cv).toBe('種﨑敦美');
    expect(card.customFields?.char_birthday).toBe('生日09-27 / 血型A / 身高168');
    expect(card.customFields?.char_profile).toBe('千年以上的精灵魔法使。');
    expect(card.posterUrl).toBe('/api/images/file?anime=x&file=cover.jpg');
  });

  it('没传 sourceWorkName 时用角色的所属作品；都没有则留空', () => {
    const withWorks = buildCharacterCardEntry({
      character: character({ ...full, works: [work] }), fallbackWork: work,
    });
    expect(withWorks.customFields?.char_source).toBe('葬送的芙莉莲');

    const noWorks = buildCharacterCardEntry({ character: character({ name: 'X' }), fallbackWork: null });
    expect(noWorks.customFields?.char_source).toBe('');
  });

  it('带上 Bangumi 角色页链接，方便回查', () => {
    const card = buildCharacterCardEntry({ character: full, fallbackWork: work });
    expect(card.link).toBe('https://bgm.tv/character/86246');
  });

  it('没有立绘时不写海报字段（不塞外链）', () => {
    const card = buildCharacterCardEntry({ character: full, fallbackWork: work });
    expect(card.posterUrl).toBe('');
  });

  it('每个卡片的 id 唯一', () => {
    const a = buildCharacterCardEntry({ character: full, fallbackWork: work });
    const b = buildCharacterCardEntry({ character: full, fallbackWork: work });
    expect(a.id).not.toBe(b.id);
  });
});

describe('mergeCharacterCardData（重复角色卡的合并）', () => {
  const character = (partial: Partial<CharacterEntry> = {}): CharacterEntry => ({
    sourceId: '86246', name: 'フリーレン', nameCn: '芙莉莲', relation: '主角',
    summary: null, aliases: [], gender: null,
    birthday: '09-27', bloodType: 'A', height: '168', weight: null, bwh: null,
    referenceUrl: null, imageUrl: null, imageThumbUrl: null,
    voiceActors: [{ sourceId: '1', name: '種﨑敦美', imageUrl: null, summary: null }],
    works: [], aniListId: null, age: null, popularity: null,
    profile: { text: '抓来的人设', source: 'bangumi', lang: 'ja' },
    detailLoaded: true, ...partial,
  });

  it('所属作品取并集 —— 这就是「一对多绑定」', () => {
    const r = mergeCharacterCardData(
      { char_source: '葬送的芙莉莲', char_cv: '種﨑敦美' },
      character(), '葬送的芙莉莲 第二季',
    );
    expect(r.customFields.char_source).toBe('葬送的芙莉莲/葬送的芙莉莲 第二季');
    expect(r.filled).toContain('所属作品');
  });

  it('作品去重：同作品重复合并不新增', () => {
    const r = mergeCharacterCardData({ char_source: '葬送的芙莉莲' }, character(), '葬送的芙莉莲');
    expect(r.customFields.char_source).toBe('葬送的芙莉莲');
    expect(r.filled).not.toContain('所属作品');
  });

  it('回归：只补空、不覆盖 —— 你自己填过的内容不能被抓取结果冲掉', () => {
    const r = mergeCharacterCardData({
      char_source: '葬送的芙莉莲',
      char_cv: '我手填的声优',
      char_birthday: '我自己写的属性',
      char_profile: '我写的长人设',
    }, character(), '葬送的芙莉莲');
    expect(r.customFields.char_cv).toBe('我手填的声优');
    expect(r.customFields.char_birthday).toBe('我自己写的属性');
    expect(r.customFields.char_profile).toBe('我写的长人设');
    expect(r.filled).toEqual([]);
    expect(r.changed).toBe(false);
  });

  it('空字段会被补上，并报告补了哪些', () => {
    const r = mergeCharacterCardData({ char_source: '葬送的芙莉莲' }, character(), '葬送的芙莉莲');
    expect(r.customFields.char_cv).toBe('種﨑敦美');
    expect(r.customFields.char_birthday).toBe('生日09-27 / 血型A / 身高168');
    expect(r.customFields.char_profile).toBe('抓来的人设');
    expect(r.filled).toEqual(expect.arrayContaining(['声优', '生日/属性', '详细人设']));
    expect(r.changed).toBe(true);
  });

  it('原卡片没有 customFields 时也能合并（不会崩）', () => {
    const r = mergeCharacterCardData(undefined, character(), '葬送的芙莉莲');
    expect(r.customFields.char_source).toBe('葬送的芙莉莲');
    expect(r.customFields.char_cv).toBe('種﨑敦美');
  });

  it('所属作品有上限，不会无限增长', () => {
    const many = Array.from({ length: 8 }, (_, i) => `作品${i}`).join('/');
    const r = mergeCharacterCardData({ char_source: many }, character(), '新作品');
    expect(r.customFields.char_source.split('/').length).toBeLessThanOrEqual(6);
  });

  it('数值型旧值会转成字符串（Excel 里可能是数字）', () => {
    const r = mergeCharacterCardData({ char_source: 'A', char_birthday: 123 as unknown as string }, character(), 'A');
    expect(typeof r.customFields.char_birthday).toBe('string');
  });
});

describe('mergeDetailIntoListed（列表项 + 详情）', () => {
  const listed = (): CharacterEntry => ({
    sourceId: '1', name: 'フリーレン', nameCn: null, relation: '主角',
    summary: '日文短简介', aliases: [], gender: null, birthday: null, bloodType: null,
    height: null, weight: null, bwh: null, referenceUrl: null,
    imageUrl: 'https://lain.bgm.tv/list-medium.jpg', imageThumbUrl: 'https://lain.bgm.tv/grid.jpg',
    voiceActors: [{ sourceId: '9', name: '種﨑敦美', imageUrl: null, summary: null }],
    works: [], aniListId: null, age: null, popularity: null,
    profile: { text: '短', source: 'bangumi', lang: 'ja' }, detailLoaded: false,
  });
  const detail = (): CharacterEntry => ({
    ...listed(), nameCn: '芙莉莲', birthday: '09-27', gender: 'female',
    imageUrl: 'https://lain.bgm.tv/detail-large.jpg',
    profile: { text: '长得多的人设文本', source: 'anilist', lang: 'en' }, detailLoaded: true,
  });

  it('详情补上中文名/生日/性别，列表的立绘与声优保留', () => {
    const m = mergeDetailIntoListed(listed(), detail());
    expect(m.nameCn).toBe('芙莉莲');
    expect(m.birthday).toBe('09-27');
    expect(m.gender).toBe('female');
    // 列表的立绘优先（列表给的是中图，详情给的是大图，但列表已有就不覆盖）
    expect(m.imageUrl).toBe('https://lain.bgm.tv/list-medium.jpg');
    expect(m.voiceActors[0].name).toBe('種﨑敦美');
    expect(m.detailLoaded).toBe(true);
  });

  it('人设取更长的那份', () => {
    expect(mergeDetailIntoListed(listed(), detail()).profile?.text).toBe('长得多的人设文本');
    expect(mergeDetailIntoListed(listed(), detail()).profile?.source).toBe('anilist');
  });

  it('详情缺字段时保留列表的值', () => {
    const thin = { ...detail(), nameCn: null, birthday: null, gender: null };
    const m = mergeDetailIntoListed(listed(), thin);
    expect(m.nameCn).toBeNull();
    expect(m.relation).toBe('主角');
    expect(m.imageUrl).toBe('https://lain.bgm.tv/list-medium.jpg');
  });
});
