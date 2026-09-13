/**
 * core/character 单元测试
 *
 * 这里只测纯函数（infobox 解析 / 生日归一化 / 跨源名字匹配 / 作品匹配 / 卡片字段拼装）。
 * 重点覆盖「绝不能误配」的场景 —— 角色匹配错了，会把别的角色的生日、声优和人设
 * 写进用户的 Excel，而错误数据比空数据更难发现。
 */
import { describe, it, expect } from 'vitest';
import {
  parseInfoboxValue,
  buildInfoboxMap,
  pickInfobox,
  normalizeBirthday,
  normalizeCharacterName,
  characterNameSimilarity,
  workTitleSimilarity,
  stripMarkup,
  stripWorkDecoration,
  pickWorkCandidate,
  relationRank,
  isImportantRelation,
  sortCharactersByRelation,
  scoreCharacterForName,
  pickCharacterForName,
  resolveProfile,
  detectTextLang,
  buildCharacterCardFields,
  anilistMediaTypeFor,
  subjectTypeName,
  isStrongMatch,
  HIGH_CONFIDENCE,
  LOW_CONFIDENCE,
  MAX_SOURCE_WORKS,
} from '../../core/character';
import type { WorkCandidate, NameBearing } from '../../core/character';

function work(partial: Partial<WorkCandidate>): WorkCandidate {
  return { sourceId: '1', type: 2, title: '', titleCn: '', releaseDate: null, ...partial };
}

function character(partial: Partial<NameBearing & { relation?: string }>): NameBearing & { relation?: string } {
  return { name: '', nameCn: null, aliases: [], ...partial };
}

describe('parseInfoboxValue', () => {
  it('纯字符串原样返回并去空白', () => {
    expect(parseInfoboxValue(' 芙莉莲 ')).toBe('芙莉莲');
  });

  it('数字转字符串', () => {
    expect(parseInfoboxValue(168)).toBe('168');
  });

  it('别名数组 [{k,v}] 拼成「标签：值」', () => {
    expect(parseInfoboxValue([{ k: '英文名', v: 'Frieren' }, { k: '昵称', v: '葬送のフリーレン' }]))
      .toBe('英文名：Frieren / 昵称：葬送のフリーレン');
  });

  it('别名数组缺少 k 时只留值（真实数据里很常见）', () => {
    expect(parseInfoboxValue([{ v: 'Himmel' }, { k: '第二中文名', v: '辛美尔' }]))
      .toBe('Himmel / 第二中文名：辛美尔');
  });

  it('纯字符串数组用 / 连接', () => {
    expect(parseInfoboxValue(['a', 'b'])).toBe('a / b');
  });

  it('null / undefined / 非法结构返回空串而不是崩', () => {
    expect(parseInfoboxValue(null)).toBe('');
    expect(parseInfoboxValue(undefined)).toBe('');
    expect(parseInfoboxValue({ notValue: 1 })).toBe('');
  });
});

describe('buildInfoboxMap', () => {
  it('把 infobox 数组转成 map', () => {
    const map = buildInfoboxMap([
      { key: '简体中文名', value: '芙莉莲' },
      { key: '性别', value: '女' },
    ]);
    expect(map['简体中文名']).toBe('芙莉莲');
    expect(map['性别']).toBe('女');
  });

  it('同名 key 用 / 合并而不是覆盖', () => {
    const map = buildInfoboxMap([
      { key: '别名', value: 'A' },
      { key: '别名', value: 'B' },
    ]);
    expect(map['别名']).toBe('A / B');
  });

  it('空值不占位', () => {
    const map = buildInfoboxMap([{ key: '生日', value: '' }, { key: '性别', value: '男' }]);
    expect('生日' in map).toBe(false);
  });

  it('非数组输入返回空对象', () => {
    expect(buildInfoboxMap(null)).toEqual({});
    expect(buildInfoboxMap('x')).toEqual({});
  });
});

describe('pickInfobox', () => {
  it('按候选顺序取第一个非空值（同一概念 key 在不同条目不一样）', () => {
    const map = { 出生日期: '1月1日' };
    expect(pickInfobox(map, ['生日', '出生日期', '誕生日'])).toBe('1月1日');
  });

  it('都没有则返回 null', () => {
    expect(pickInfobox({}, ['生日'])).toBeNull();
    expect(pickInfobox({ 生日: '   ' }, ['生日'])).toBeNull();
  });
});

describe('normalizeBirthday', () => {
  it('「9月27日」归一为 09-27 并补零', () => {
    expect(normalizeBirthday('9月27日')).toBe('09-27');
  });

  it('已经是两位月份的形式原样通过', () => {
    expect(normalizeBirthday('09月27日')).toBe('09-27');
    expect(normalizeBirthday('09/27')).toBe('09-27');
    expect(normalizeBirthday('9-27')).toBe('09-27');
  });

  it('带年份时只取月日', () => {
    expect(normalizeBirthday('1990年9月27日')).toBe('09-27');
  });

  it('「9月27日生」这类后缀不影响解析', () => {
    expect(normalizeBirthday('9月27日生')).toBe('09-27');
  });

  it('AniList 的结构化 month/day 优先', () => {
    expect(normalizeBirthday(null, 3, 8)).toBe('03-08');
  });

  it('只有月没有日时返回 null（不猜）', () => {
    expect(normalizeBirthday('9月')).toBeNull();
    expect(normalizeBirthday(null, 9, null)).toBeNull();
  });

  it('越界值返回 null', () => {
    expect(normalizeBirthday(null, 13, 1)).toBeNull();
    expect(normalizeBirthday(null, 0, 1)).toBeNull();
    expect(normalizeBirthday(null, 1, 32)).toBeNull();
  });

  it('无法解析的文本返回 null', () => {
    expect(normalizeBirthday('不详')).toBeNull();
    expect(normalizeBirthday('')).toBeNull();
    expect(normalizeBirthday(undefined)).toBeNull();
  });
});

describe('normalizeCharacterName', () => {
  it('去掉空白与间隔号', () => {
    expect(normalizeCharacterName('辛・诺赞')).toBe(normalizeCharacterName('辛诺赞'));
  });

  it('全角字母转半角并转小写', () => {
    expect(normalizeCharacterName('ＡＢＣ')).toBe('abc');
  });

  it('回归：中文「惠」与日文「恵」是不同的码位，不能归一成同一个', () => {
    // 这是刻意的：靠猜异体字会把两个不同角色认成同一个。
    // 正确做法是用 infobox 的「简体中文名」拿到中文名，见 scoreCharacterForName。
    expect(normalizeCharacterName('加藤惠')).not.toBe(normalizeCharacterName('加藤恵'));
  });
});

describe('characterNameSimilarity', () => {
  it('归一化后全等给 1', () => {
    expect(characterNameSimilarity('辛・诺赞', '辛诺赞')).toBe(1);
  });

  it('回归：加藤惠 vs 加藤恵 相似度必须低于自动写入阈值', () => {
    const score = characterNameSimilarity('加藤惠', '加藤恵');
    expect(score).toBeLessThan(LOW_CONFIDENCE);
  });

  it('完全不同的名字给 0', () => {
    expect(characterNameSimilarity('蕾娜', '芙莉莲')).toBe(0);
    expect(characterNameSimilarity('', '芙莉莲')).toBe(0);
  });
});

describe('pickWorkCandidate', () => {
  it('回归：必须按类型过滤 —— 搜「路人女主的养成方法」前排是书籍而不是动画', () => {
    const candidates = [
      work({ sourceId: '102486', type: 1, title: '冴えない彼女の育てかた', titleCn: '路人女主的养成方法' }),
      work({ sourceId: '44637', type: 1, title: '冴えない彼女の育てかた', titleCn: '路人女主的养成方法' }),
      work({ sourceId: '99999', type: 2, title: '冴えない彼女の育てかた Fine', titleCn: '路人女主的养成方法 Fine' }),
    ];
    const picked = pickWorkCandidate(candidates, '路人女主的养成方法fine', [2]);
    expect(picked?.item.sourceId).toBe('99999');
    expect(picked?.item.type).toBe(2);
  });

  it('指定类型里没有候选时返回 null（宁可判失败，也不要挂错类型）', () => {
    const candidates = [work({ sourceId: '1', type: 1, titleCn: '路人女主的养成方法' })];
    expect(pickWorkCandidate(candidates, '路人女主的养成方法', [2])).toBeNull();
  });

  it('不传 types 时从全部候选里挑标题最接近的', () => {
    const candidates = [
      work({ sourceId: 'a', type: 2, titleCn: '葬送的芙莉莲' }),
      work({ sourceId: 'b', type: 2, titleCn: '葬送的芙莉莲 第二季' }),
    ];
    expect(pickWorkCandidate(candidates, '葬送的芙莉莲')?.item.sourceId).toBe('a');
  });

  it('空候选返回 null', () => {
    expect(pickWorkCandidate([], '任意', [2])).toBeNull();
  });

  it('回归：用户标题带 part1/季数后缀时，正确作品仍要高置信', () => {
    // 实测踩过的坑：'86 不存在的战区 part1' 与 '86 -不存在的战区-' 只差连字符和 part1，
    // 不归一化会算出 0.4，把本来正确的匹配标成低置信。
    const candidates = [work({ sourceId: '302189', type: 2, title: '86―エイティシックス―', titleCn: '86 -不存在的战区-' })];
    const picked = pickWorkCandidate(candidates, '86 不存在的战区 part1', [2]);
    expect(picked?.item.sourceId).toBe('302189');
    expect(picked!.score).toBeGreaterThanOrEqual(LOW_CONFIDENCE);
  });

  it('回归：带「2」「fine」后缀的标题也能高置信匹配', () => {
    const candidates = [work({ sourceId: '1', type: 2, title: '僕の心のヤバイやつ', titleCn: '我心里危险的东西' })];
    expect(pickWorkCandidate(candidates, '我心里危险的东西2', [2])!.score)
      .toBeGreaterThanOrEqual(LOW_CONFIDENCE);
    const fine = [work({ sourceId: '2', type: 2, title: '冴えない彼女の育てかた Fine', titleCn: '路人女主的养成方法 Fine' })];
    expect(pickWorkCandidate(fine, '路人女主的养成方法fine', [2])!.score)
      .toBeGreaterThanOrEqual(LOW_CONFIDENCE);
  });
});

describe('关系排序', () => {
  it('主角排最前，闲角排最后，未知关系居中', () => {
    const list = [
      { name: '闲', relation: '闲角' },
      { name: '配', relation: '配角' },
      { name: '主', relation: '主角' },
      { name: '未', relation: '' },
    ];
    expect(sortCharactersByRelation(list).map((c) => c.name)).toEqual(['主', '未', '配', '闲']);
    expect(relationRank('主角')).toBeLessThan(relationRank('配角'));
    expect(relationRank('配角')).toBeLessThan(relationRank('闲角'));
  });

  it('同关系保持原顺序（Bangumi 已按登场顺序排）', () => {
    const list = [
      { name: 'a', relation: '主角' },
      { name: 'b', relation: '主角' },
      { name: 'c', relation: '主角' },
    ];
    expect(sortCharactersByRelation(list).map((c) => c.name)).toEqual(['a', 'b', 'c']);
  });

  it('只有主角和配角值得为角色卡抓详情', () => {
    expect(isImportantRelation('主角')).toBe(true);
    expect(isImportantRelation('配角')).toBe(true);
    expect(isImportantRelation('闲角')).toBe(false);
  });
});

describe('scoreCharacterForName', () => {
  it('优先用简体中文名命中，并报告命中字段', () => {
    // 真实场景：记录的是中文名「加藤惠」，Bangumi 原名是日文「加藤恵」
    const target = character({ name: '加藤恵', nameCn: '加藤惠' });
    const match = scoreCharacterForName(target, '加藤惠');
    expect(match?.score).toBe(1);
    expect(match?.matchedOn).toBe('nameCn');
    expect(match?.matchedValue).toBe('加藤惠');
  });

  it('没抓到中文名详情时压低分，不会误判成可靠匹配', () => {
    const target = character({ name: '加藤恵', nameCn: null });
    const match = scoreCharacterForName(target, '加藤惠');
    expect(match?.matchedOn).toBe('name');
    expect(match!.score).toBeLessThan(LOW_CONFIDENCE);
  });

  it('别名也能命中', () => {
    const target = character({ name: 'フリーレン', aliases: ['Frieren', '芙莉莲'] });
    const match = scoreCharacterForName(target, 'Frieren');
    expect(match?.score).toBe(1);
    expect(match?.matchedOn).toBe('alias');
  });

  it('毫无关系的名字不会返回高分', () => {
    const target = character({ name: 'フリーレン', nameCn: '芙莉莲' });
    const match = scoreCharacterForName(target, '蕾娜');
    expect(match!.score).toBeLessThan(LOW_CONFIDENCE);
  });
});

describe('pickCharacterForName', () => {
  it('在本作品角色列表里找出正确的人', () => {
    const list = [
      character({ name: 'フリーレン', nameCn: '芙莉莲', relation: '主角' }),
      character({ name: 'フェルン', nameCn: '菲伦', relation: '主角' }),
      character({ name: 'ヒンメル', nameCn: '辛美尔', relation: '主角' }),
    ];
    const match = pickCharacterForName(list, '菲伦');
    expect(match?.item.name).toBe('フェルン');
    expect(match?.score).toBe(1);
  });

  it('分数相同时主角优先于配角', () => {
    const list = [
      character({ name: '同名', nameCn: '同名', relation: '配角' }),
      character({ name: '同名', nameCn: '同名', relation: '主角' }),
    ];
    expect(pickCharacterForName(list, '同名')?.item.relation).toBe('主角');
  });

  it('列表为空返回 null', () => {
    expect(pickCharacterForName([], '蕾娜')).toBeNull();
  });

  it('回归：默认带置信度下限 —— 0 分的候选绝不能被当成命中', () => {
    // 实测踩过的坑：不加下限时任何名字都会「匹配」到列表里某个角色，
    // 「安艺伦也」被塞成了「霞之丘诗羽」（score 0），调用方还以为匹配完了。
    const list = [
      character({ name: '霞ヶ丘詩羽', nameCn: '霞之丘诗羽', relation: '主角' }),
      character({ name: '加藤恵', nameCn: null, relation: '主角' }),
    ];
    expect(pickCharacterForName(list, '安艺伦也')).toBeNull();
    // 显式传 0 才能拿到「最佳候选」，供人工确认用
    const loose = pickCharacterForName(list, '安艺伦也', 0);
    expect(loose).not.toBeNull();
    expect(loose!.score).toBeLessThan(LOW_CONFIDENCE);
  });

  it('回归：详情还没抓到时（缺中文名）不给出可信匹配，逼调用方继续抓详情', () => {
    // 加藤惠 vs 加藤恵 归一化后不同码位 → 0.35，必须判为不可信
    const notLoaded = [character({ name: '加藤恵', nameCn: null })];
    expect(pickCharacterForName(notLoaded, '加藤惠')).toBeNull();
    // 抓到详情（有简体中文名）后才可信
    const loaded = [character({ name: '加藤恵', nameCn: '加藤惠' })];
    expect(pickCharacterForName(loaded, '加藤惠')?.score).toBe(1);
  });

  it('回归：共用姓氏的亲属不能靠别名包含抢走匹配（星野爱 vs 星野愛久愛海）', () => {
    // 实测：母亲「星野爱」曾被 0.783 匹配成儿子「星野愛久愛海」（共用姓氏「星野」）
    const list = [
      character({ name: 'アクア', nameCn: '星野愛久愛海', aliases: ['星野爱久爱海'], relation: '主角' }),
      character({ name: '星野アイ', nameCn: '星野爱', relation: '配角' }),
    ];
    const picked = pickCharacterForName(list, '星野爱');
    expect(picked?.item.name).toBe('星野アイ');
    expect(picked?.score).toBe(1);
    // 亲属那个确实能拿到一个「包含」分，所以提前停止必须用更高的门槛
    const weak = scoreCharacterForName(list[0], '星野爱');
    expect(weak!.score).toBeGreaterThan(LOW_CONFIDENCE);
    expect(isStrongMatch(weak!.score)).toBe(false);
  });
});

describe('置信度门槛', () => {
  it('强匹配门槛明显高于可信门槛（否则别名包含会过早终止搜索）', () => {
    expect(HIGH_CONFIDENCE).toBeGreaterThan(LOW_CONFIDENCE);
    expect(isStrongMatch(1)).toBe(true);
    expect(isStrongMatch(0.783)).toBe(false); // 「辛」这种别名包含分不该算强匹配
    expect(isStrongMatch(LOW_CONFIDENCE)).toBe(false);
  });
});

describe('resolveProfile', () => {
  it('AniList 的更长时取 AniList 并标记来源', () => {
    const profile = resolveProfile('短简介', 'A much longer english description of the character.');
    expect(profile?.source).toBe('anilist');
    expect(profile?.lang).toBe('en');
  });

  it('AniList 缺失时回退 Bangumi', () => {
    const profile = resolveProfile('千年以上生きるエルフの魔法使い。', null);
    expect(profile?.source).toBe('bangumi');
    expect(profile?.lang).toBe('ja');
  });

  it('两者都空返回 null', () => {
    expect(resolveProfile(null, null)).toBeNull();
    expect(resolveProfile('', '   ')).toBeNull();
  });

  it('语言探测：假名是区分中日的可靠信号', () => {
    // 回归：不能只凭「有汉字」就判成日文 —— 中文也全是汉字。
    // 实测「黑神话：悟空」的孙悟空简介是《西游记》原文，曾被误判成 ja。
    expect(detectTextLang('千年以上生きるエルフ')).toBe('ja');
    expect(detectTextLang('三阳交泰产群生，仙石胞含日月精。')).toBe('zh');
    expect(detectTextLang('芙莉莲')).toBe('zh');
    expect(detectTextLang('Frieren the elf')).toBe('en');
    expect(detectTextLang('')).toBe('unknown');
  });
});

describe('stripMarkup', () => {
  it('去掉 BBCode 标记保留正文（Bangumi 简介里很常见）', () => {
    expect(stripMarkup('[i]三阳交泰产群生[/i]\n正文')).toBe('三阳交泰产群生\n正文');
  });

  it('去掉带参数的 BBCode（[url=…]…[/url]）', () => {
    expect(stripMarkup('见[url=https://example.com]官网[/url]')).toBe('见官网');
  });

  it('回归：Markdown 链接只留文字，不能把方括号里的文字删掉只留裸 URL', () => {
    // AniList 简介里这种链接很多，被误删后正文会变成一串 https://…
    expect(stripMarkup('the classmate of [Tomoya Aki](https://anilist.co/character/88747)')).toBe('the classmate of Tomoya Aki');
    expect(stripMarkup('[赫萝](https://anilist.co/character/7373)是狼神')).toBe('赫萝是狼神');
  });

  it('回归：正常方括号内容（含空格）不能被当成 BBCode 删掉', () => {
    expect(stripMarkup('[Tomoya Aki] 是主角')).toBe('[Tomoya Aki] 是主角');
  });

  it('br 标签转成换行，而不是直接消失', () => {
    expect(stripMarkup('第一行<br>第二行')).toBe('第一行\n第二行');
    expect(stripMarkup('第一行<br/>第二行')).toBe('第一行\n第二行');
  });

  it('去掉 HTML 标签', () => {
    expect(stripMarkup('<br>第一行<b>重点</b>')).toBe('第一行重点');
  });

  it('去掉 Markdown 强调标记但保留文字（AniList 的 __Height:__）', () => {
    expect(stripMarkup('__Height:__ 160 cm')).toBe('Height: 160 cm');
    expect(stripMarkup('**重点**内容')).toBe('重点内容');
  });

  it('CRLF 归一为 LF，多余空行折叠', () => {
    expect(stripMarkup('a\r\nb')).toBe('a\nb');
    expect(stripMarkup('a\n\n\n\nb')).toBe('a\n\nb');
  });

  it('解码常见实体', () => {
    expect(stripMarkup('a&nbsp;b&amp;c')).toBe('a b&c');
  });

  it('非字符串输入返回空串', () => {
    expect(stripMarkup(null)).toBe('');
    expect(stripMarkup(undefined)).toBe('');
  });
});

describe('stripWorkDecoration', () => {
  it('去掉 part 后缀（保留数字前的正文）', () => {
    expect(stripWorkDecoration('86 不存在的战区 part1')).toBe('86 不存在的战区');
  });

  it('去掉结尾的季数数字', () => {
    expect(stripWorkDecoration('我心里危险的东西2')).toBe('我心里危险的东西');
  });

  it('去掉「第二季」这类中文季数', () => {
    expect(stripWorkDecoration('葬送的芙莉莲 第二季')).toBe('葬送的芙莉莲');
  });

  it('去掉剧场版/movie 之类修饰', () => {
    expect(stripWorkDecoration('某作品 剧场版')).toBe('某作品');
    expect(stripWorkDecoration('Some Title The Movie')).toBe('Some Title');
  });

  it('「fine」这类副标题不算季数装饰，靠大小写/空格归一化解决（见 pickWorkCandidate 回归）', () => {
    expect(stripWorkDecoration('路人女主的养成方法fine')).toBe('路人女主的养成方法fine');
  });

  it('保护纯数字名字：不能把「86」整个吃掉', () => {
    expect(stripWorkDecoration('86')).toBe('86');
  });
});

describe('buildCharacterCardFields', () => {
  it('所属作品用 / 连接（与界面 char_source 存储格式一致）', () => {
    const fields = buildCharacterCardFields({
      works: [{ titleCn: '我推的孩子' }, { titleCn: '我推的孩子2' }],
    });
    expect(fields.char_source).toBe('我推的孩子/我推的孩子2');
  });

  it('所属作品去重并截断到上限', () => {
    const fields = buildCharacterCardFields({
      works: Array.from({ length: 8 }, (_, i) => ({ titleCn: `作品${i % 3}` })),
    });
    expect(fields.char_source).toBe('作品0/作品1/作品2');
    expect(fields.char_source.split('/').length).toBeLessThanOrEqual(MAX_SOURCE_WORKS);
  });

  it('中文名为空时回退原名', () => {
    expect(buildCharacterCardFields({ works: [{ title: '冴えない彼女の育てかた' }] }).char_source)
      .toBe('冴えない彼女の育てかた');
  });

  it('声优只取首位（原版日语 CV），不堆国配台配', () => {
    const fields = buildCharacterCardFields({
      voiceActors: [{ name: '種﨑敦美' }, { name: '李蝉妃' }, { name: '李昀晴' }],
    });
    expect(fields.char_cv).toBe('種﨑敦美');
  });

  it('「生日/属性」把生日血型身高体重拼起来，空值不占位', () => {
    const fields = buildCharacterCardFields({
      birthday: '09-27',
      bloodType: 'A',
      height: '168',
      weight: null,
    });
    expect(fields.char_birthday).toBe('生日09-27 / 血型A / 身高168');
  });

  it('全部缺失时输出空串而不是 undefined', () => {
    const fields = buildCharacterCardFields({});
    expect(fields).toEqual({ char_source: '', char_cv: '', char_birthday: '', char_profile: '' });
  });

  it('详细人设去空白', () => {
    expect(buildCharacterCardFields({ profile: '  人设文本  ' }).char_profile).toBe('人设文本');
  });
});

describe('作品类型', () => {
  it('动画映射到 ANIME，书籍/轻小说映射到 MANGA', () => {
    expect(anilistMediaTypeFor(2)).toBe('ANIME');
    expect(anilistMediaTypeFor(1)).toBe('MANGA');
  });

  it('游戏(4)/音乐(3)/三次元(6) 在 AniList 没有对应，返回 null', () => {
    expect(anilistMediaTypeFor(4)).toBeNull();
    expect(anilistMediaTypeFor(3)).toBeNull();
    expect(anilistMediaTypeFor(6)).toBeNull();
  });

  it('类型名可读', () => {
    expect(subjectTypeName(1)).toBe('书籍');
    expect(subjectTypeName(4)).toBe('游戏');
    expect(subjectTypeName(99)).toBe('类型99');
    expect(subjectTypeName('x')).toBe('未知');
  });
});
