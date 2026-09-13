/**
 * features/media-complete/media-service 单元测试
 *
 * 这里只测纯函数（标题归一化 / 相似度 / 最佳匹配）。
 * 重点覆盖「补全时必须避免误配」的场景 —— 匹配错了会把错误的封面和上映时间
 * 写进用户的 Excel，所以宁可判低置信度让人工复核，也不能给出虚高的分数。
 */
import { describe, it, expect } from 'vitest';
import { normalizeTitle, titleSimilarity, pickBestMatch, seasonMark, keywordChain, LOW_CONFIDENCE } from '../../../features/media-complete/media-service';
import type { MediaCandidate } from '../../../features/media-complete/media-service';

/** 造一个候选条目，只填测试关心的字段 */
function candidate(partial: Partial<MediaCandidate>): MediaCandidate {
  return {
    source: 'bangumi',
    sourceId: '1',
    title: '',
    titleCn: '',
    aliases: [],
    coverUrl: '',
    score: null,
    releaseDate: null,
    episodes: null,
    studio: null,
    tags: [],
    summary: '',
    link: '',
    ...partial,
  };
}

describe('normalizeTitle', () => {
  it('全角标点与半角标点归一为同一串', () => {
    expect(normalizeTitle('Re：从零开始的异世界生活')).toBe(normalizeTitle('Re: 从零开始的异世界生活'));
  });

  it('去掉空格、括号与装饰符', () => {
    expect(normalizeTitle('葬送的芙莉莲 2')).toBe('葬送的芙莉莲2');
    expect(normalizeTitle('【我推的孩子】')).toBe('我推的孩子');
    expect(normalizeTitle('轻音少女（第一季）')).toBe('轻音少女第一季');
  });

  it('大小写归一', () => {
    expect(normalizeTitle('AngleBeats!')).toBe(normalizeTitle('anglebeats!'));
  });

  it('空值与纯符号返回空串', () => {
    expect(normalizeTitle('')).toBe('');
    expect(normalizeTitle('   ')).toBe('');
    expect(normalizeTitle('···')).toBe('');
  });
});

describe('titleSimilarity', () => {
  it('完全相同（含标点差异）得 1', () => {
    expect(titleSimilarity('轻音少女', '轻音少女')).toBe(1);
    expect(titleSimilarity('Re：从零开始', 'Re: 从零开始')).toBe(1);
  });

  it('互相包含时落在 0.75~1，且长度越接近分越高', () => {
    const close = titleSimilarity('葬送的芙莉莲', '葬送的芙莉莲 第二季');
    const far = titleSimilarity('芙莉莲', '葬送的芙莉莲 第二季');
    expect(close).toBeGreaterThanOrEqual(0.75);
    expect(close).toBeLessThanOrEqual(1);
    expect(far).toBeGreaterThanOrEqual(0.75);
    expect(close).toBeGreaterThan(far);
  });

  it('毫无关系的标题分数很低', () => {
    expect(titleSimilarity('轻音少女', '进击的巨人')).toBeLessThan(0.2);
  });

  it('空输入得 0 而不是 NaN', () => {
    expect(titleSimilarity('', '轻音少女')).toBe(0);
    expect(titleSimilarity('轻音少女', '')).toBe(0);
  });
});

describe('pickBestMatch', () => {
  const kon = candidate({ sourceId: '1172', titleCn: '轻音少女 第一季', title: 'けいおん!' });
  const kon2 = candidate({ sourceId: '1173', titleCn: '轻音少女 第二季', title: 'けいおん!!' });
  const frieren = candidate({ source: 'bilibili', sourceId: '46089', titleCn: '葬送的芙莉莲', title: '葬送のフリーレン' });

  it('选出最贴合的那个候选', () => {
    const best = pickBestMatch([kon2, kon, frieren], ['轻音少女']);
    expect(best).not.toBeNull();
    expect(['1172', '1173']).toContain(best!.candidate.sourceId);
    expect(best!.score).toBeGreaterThanOrEqual(LOW_CONFIDENCE);
  });

  it('检索名优先于中文名（关键词按优先级传入）', () => {
    // 检索名精确指向第二季时，应选第二季而不是分数更"平均"的第一季
    const best = pickBestMatch([kon, kon2], ['轻音少女 第二季', '轻音少女']);
    expect(best!.candidate.sourceId).toBe('1173');
  });

  it('别名也能参与匹配', () => {
    const withAlias = candidate({ sourceId: '9', titleCn: '完全无关的名字', aliases: ['进击的巨人'] });    const best = pickBestMatch([frieren, withAlias], ['进击的巨人']);
    expect(best!.candidate.sourceId).toBe('9');
  });

  it('完全对不上时分数低于低置信度阈值', () => {
    const best = pickBestMatch([frieren], ['某部完全不相干的动画']);
    expect(best!.score).toBeLessThan(LOW_CONFIDENCE);
  });

  it('没有候选或没有关键词时返回 null', () => {
    expect(pickBestMatch([], ['轻音少女'])).toBeNull();
    expect(pickBestMatch([kon], [])).toBeNull();
    expect(pickBestMatch([kon], ['   '])).toBeNull();
  });

  // ── 回归：检索名列错位（真实数据里的既有问题）──
  // 这份 Excel 的「检索名」列有 23 处错位：「利兹与青鸟」和「玉子爱情故事」的
  // 检索名都被写成了 トニカクカワイイ。拿检索名搜索会召回「总之就是非常可爱」，
  // 若再拿检索名打分，就会以 100% 置信度把完全不相干的封面写进 Excel。
  it('检索名错位时不得判为高置信度', () => {
    const tonikaku = candidate({
      source: 'bilibili',
      sourceId: '38329',
      titleCn: '总之就是非常可爱',
      title: 'トニカクカワイイ',
    });
    const best = pickBestMatch([tonikaku], ['利兹与青鸟']);
    expect(best).not.toBeNull();
    expect(best!.score).toBeLessThan(LOW_CONFIDENCE);
  });

  it('日文名一致时仍可判为高置信度（标题的两个来源都可信）', () => {
    const frierenByJa = candidate({ titleCn: '葬送的芙莉莲', title: '葬送のフリーレン' });
    const best = pickBestMatch([frierenByJa], ['葬送的芙莉莲', '葬送のフリーレン']);
    expect(best!.score).toBe(1);
  });
});

describe('seasonMark', () => {
  it('识别中文「第N季/期/部」', () => {
    expect(seasonMark('我心里危险的东西 第二季')).toBe(2);
    expect(seasonMark('间谍过家家 第三季')).toBe(3);
    expect(seasonMark('路人女主的养成方法 第2期')).toBe(2);
    expect(seasonMark('青春猪头少年 第一部分')).toBe(1);
  });

  it('识别 part N', () => {
    expect(seasonMark('间谍过家家 part1')).toBe(1);
    expect(seasonMark('间谍过家家 part2')).toBe(2);
  });

  it('识别末尾数字', () => {
    expect(seasonMark('我推的孩子3')).toBe(3);
    expect(seasonMark('RE：从零开始的异世界生活4')).toBe(4);
    expect(seasonMark('我心里危险的东西2')).toBe(2);
  });

  it('识别罗马数字', () => {
    expect(seasonMark('無職転生Ⅱ')).toBe(2);
    expect(seasonMark('无职转生 II')).toBe(2);
  });

  it('无季数标记返回 null（年份开头的 86 不能被当成季数）', () => {
    expect(seasonMark('轻音少女')).toBeNull();
    expect(seasonMark('利兹与青鸟')).toBeNull();
    expect(seasonMark('86 不存在的战区')).toBeNull();
    expect(seasonMark('我推的孩子剧场版(第一集)')).toBeNull();
  });
});

describe('续作匹配（真实数据里的高频错误）', () => {
  const s1 = candidate({ sourceId: '1', titleCn: '我心里危险的东西', title: '僕の心のヤバイやつ' });
  const s2 = candidate({ sourceId: '2', titleCn: '我心里危险的东西 第二季', title: '僕の心のヤバイやつ 第2期' });

  it('「…2」应匹配到第二季而不是第一季', () => {
    // 不加季数校验时，第一季因为是"短标题子串"反而会以 97% 胜出
    const best = pickBestMatch([s1, s2], ['我心里危险的东西2']);
    expect(best!.candidate.sourceId).toBe('2');
    expect(best!.score).toBeGreaterThanOrEqual(LOW_CONFIDENCE);
  });

  it('无季数标记时不应匹配到第二季', () => {
    const best = pickBestMatch([s1, s2], ['我心里危险的东西']);
    expect(best!.candidate.sourceId).toBe('1');
  });

  it('「part1」与数据源的无标记第一季视为同一季', () => {
    const spy = candidate({ sourceId: '10', titleCn: '间谍过家家', title: 'SPY×FAMILY' });
    const best = pickBestMatch([spy], ['间谍过家家 part1']);
    expect(best!.candidate.sourceId).toBe('10');
    expect(best!.score).toBeGreaterThanOrEqual(LOW_CONFIDENCE);
  });

  it('同人/续作干扰时，用 Excel 里已有的上映年份消歧', () => {
    // 真实案例：Bangumi 搜「无职转生」时，排在前面的是标题更长的同人动画
    // （2025 年、评分 4.5），而正片是 2021 年。包含规则偏袒短标题会让同人胜出。
    const doujin = candidate({ sourceId: 'd', titleCn: '【无职转生同人动画】血契之约', releaseDate: '2025-07' });
    const official = candidate({ sourceId: 'o', titleCn: '无职转生 ～到了异世界就拿出真本事～', releaseDate: '2021-01' });
    const best = pickBestMatch([doujin, official], ['无职转生'], '2021-01');
    expect(best!.candidate.sourceId).toBe('o');
    expect(best!.score).toBeGreaterThanOrEqual(LOW_CONFIDENCE);
  });

  it('年份只差一年时不奖惩（跨年放送很常见）', () => {
    const c = candidate({ sourceId: 'x', titleCn: '某番', releaseDate: '2022-01' });
    const withEntry = pickBestMatch([c], ['某番'], '2021-10');
    const withoutEntry = pickBestMatch([c], ['某番']);
    expect(withEntry!.score).toBe(withoutEntry!.score);
  });

  it('年份差异大时降权（但不会因为年份就否掉标题本身很吻合的候选）', () => {
    const movie = candidate({ sourceId: 'old', titleCn: '轻音少女 剧场版', releaseDate: '2011-12' });
    const penalized = pickBestMatch([movie], ['轻音少女'], '2026-09');
    const neutral = pickBestMatch([movie], ['轻音少女']);
    expect(penalized!.score).toBeLessThan(neutral!.score);
  });
});

describe('可信检索名（表内唯一）的身份确认', () => {
  // 真实案例：行62「辉夜大小姐想让我告白3」的检索名是
  // かぐや様は告らせたい-ウルトラロマンティック-（第三季标准日文名），
  // 但数据源用副标题而不是数字表示季数，于是季数启发式把正确答案压到了低置信度。
  const s1 = candidate({ sourceId: 'a', titleCn: '辉夜大小姐想让我告白', title: 'かぐや様は告らせたい～天才たちの恋愛頭脳戦～' });
  const s3 = candidate({ sourceId: 'c', titleCn: '辉夜大小姐想让我告白 -究极浪漫-', title: 'かぐや様は告らせたい-ウルトラロマンティック-' });

  it('不给可信检索名时，第三季会因季数启发式被判低置信度', () => {
    const best = pickBestMatch([s1, s3], ['辉夜大小姐想让我告白3'], null);
    expect(best!.score).toBeLessThan(LOW_CONFIDENCE);
  });

  it('给了可信检索名后，同名候选被身份确认（满分并写入）', () => {
    const best = pickBestMatch([s1, s3], ['辉夜大小姐想让我告白3'], null, ['かぐや様は告らせたい-ウルトラロマンティック-']);
    expect(best!.candidate.sourceId).toBe('c');
    expect(best!.score).toBe(1);
  });

  it('身份确认不受年份差异影响（不被 -0.08 拖回阈值以下）', () => {
    const best = pickBestMatch([s3], ['辉夜大小姐想让我告白3'], '2019-01', ['かぐや様は告らせたい-ウルトラロマンティック-']);
    expect(best!.score).toBe(1);
  });

  it('不可信的检索名（表内重复）不会被传进来，错配保护依然有效', () => {
    // 利兹与青鸟的检索名被错写成 トニカクカワイイ（与另两条重复）→ 调用方不传它
    const tonikaku = candidate({ source: 'bilibili', sourceId: 'x', titleCn: '总之就是非常可爱', title: 'トニカクカワイイ' });
    const best = pickBestMatch([tonikaku], ['利兹与青鸟'], null, []);
    expect(best!.score).toBeLessThan(LOW_CONFIDENCE);
  });
});

describe('keywordChain', () => {
  it('名字列优先，检索名与日文名作为回退', () => {
    expect(keywordChain({ title: '轻音少女', searchAlias: 'けいおん!', titleJa: '' }))
      .toEqual(['轻音少女', 'けいおん!']);
  });

  it('带季数的标题会插入"去掉季数"的主标题（救 XX3 这类续作的召回）', () => {
    // 真实案例：「辉夜大小姐想让我告白3」在 Bangumi 上叫
    // 「辉夜大小姐想让我告白 -Ultra Romantic-」，带着 3 搜一无所获；
    // 用主标题搜才能把候选召回来供人工挑选。
    expect(keywordChain({ title: '辉夜大小姐想让我告白3' }))
      .toEqual(['辉夜大小姐想让我告白3', '辉夜大小姐想让我告白']);
    expect(keywordChain({ title: '间谍过家家 part2' }))
      .toEqual(['间谍过家家 part2', '间谍过家家']);
    expect(keywordChain({ title: '我心里危险的东西2' }))
      .toEqual(['我心里危险的东西2', '我心里危险的东西']);
  });

  it('标题本身没有季数标记时不插入重复项', () => {
    expect(keywordChain({ title: '轻音少女' })).toEqual(['轻音少女']);
    // 「86 不存在的战区」的 86 在开头，不该被当成季数剥掉
    expect(keywordChain({ title: '86 不存在的战区' })).toEqual(['86 不存在的战区']);
  });

  it('全部为空时返回空数组', () => {
    expect(keywordChain({})).toEqual([]);
    expect(keywordChain({ title: '  ', searchAlias: '', titleJa: '' })).toEqual([]);
  });
});
