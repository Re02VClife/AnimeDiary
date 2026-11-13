import { describe, it, expect } from 'vitest';
import {
  normalizeTitle,
  titleSimilarity,
  matchScore,
  rankCandidates,
  confidenceOf,
  type MatchCandidate,
} from '../../core/bangumi-match';

describe('normalizeTitle', () => {
  it('去空白、大小写、全角', () => {
    expect(normalizeTitle('ＳＴＥＩＮＳ；ＧＡＴＥ')).toBe('steinsgate');
    expect(normalizeTitle(' 86 －エイティシックス－ ')).toBe('86エイティシックス');
  });

  it('保留括号内容（季数/剧场版靠它区分）', () => {
    expect(normalizeTitle('辉夜大小姐想让我告白（第二季）')).toContain('第二季');
  });
});

describe('titleSimilarity', () => {
  it('完全相同为 1', () => {
    expect(titleSimilarity('葬送的芙莉莲', '葬送的芙莉莲')).toBe(1);
  });

  it('一方包含另一方时给中高分，但不会到 1', () => {
    const s = titleSimilarity('辉夜大小姐想让我告白', '辉夜大小姐想让我告白 -Ultra Romantic-');
    expect(s).toBeGreaterThan(0.7);
    expect(s).toBeLessThan(1);
  });

  it('短标题被长标题包含时进不了高置信档', () => {
    expect(confidenceOf(titleSimilarity('无职转生', '无职转生 同人动画'))).toBe('medium');
  });

  it('续作数字后缀必须降档（「我心里危险的东西2」不能匹配到第一季）', () => {
    expect(confidenceOf(titleSimilarity('我心里危险的东西2', '我心里危险的东西'))).toBe('medium');
    expect(confidenceOf(titleSimilarity('更衣人偶坠入爱河2', '更衣人偶坠入爱河'))).toBe('medium');
  });

  it('完全无关的两个标题接近 0', () => {
    expect(titleSimilarity('葬送的芙莉莲', '进击的巨人')).toBeLessThan(0.3);
  });

  it('单字标题不会抛错', () => {
    expect(titleSimilarity('a', 'b')).toBe(0);
  });
});

describe('matchScore：真实场景', () => {
  const furiren: MatchCandidate = {
    id: 400602,
    name: '葬送のフリーレン',
    nameCn: '葬送的芙莉莲',
    aliases: ['Frieren: Beyond Journey\'s End'],
    airDate: '2023-09-29',
  };

  it('中文名精确命中', () => {
    expect(matchScore({ title: '葬送的芙莉莲' }, furiren)).toBeGreaterThanOrEqual(0.98);
  });

  it('日文原名命中', () => {
    expect(matchScore({ title: '葬送的芙莉莲', titleJa: '葬送のフリーレン' }, furiren)).toBe(1);
  });

  it('别名（英文）也能命中', () => {
    expect(matchScore({ title: 'Frieren: Beyond Journey\'s End' }, furiren)).toBeGreaterThan(0.9);
  });

  it('检索别名兜底', () => {
    expect(matchScore({ title: '芙莉莲', searchAlias: '葬送的芙莉莲' }, furiren)).toBeGreaterThan(0.9);
  });

  it('年份一致加一点分', () => {
    const withYear = matchScore({ title: '葬送的芙莉莲', releaseDate: '2023-09' }, furiren);
    const noYear = matchScore({ title: '葬送的芙莉莲' }, furiren);
    expect(withYear).toBeGreaterThanOrEqual(noYear);
  });

  it('同名书籍条目不该被打成高置信', () => {
    const book: MatchCandidate = { id: 400603, name: '葬送のフリーレン', nameCn: '葬送的芙莉莲 漫画', airDate: '2020-04-01' };
    const score = matchScore({ title: '葬送的芙莉莲', releaseDate: '2023-09' }, book);
    // 标题仍有包含关系，所以给到 medium，但不能是 high
    expect(confidenceOf(score)).not.toBe('high');
  });

  it('完全无关的候选落在 none', () => {
    const other: MatchCandidate = { id: 1, name: '进击的巨人', nameCn: '进击的巨人', airDate: '2013-04-07' };
    expect(confidenceOf(matchScore({ title: '葬送的芙莉莲' }, other))).toBe('none');
  });
});

describe('rankCandidates', () => {
  const candidates: MatchCandidate[] = [
    { id: 3, name: '進撃の巨人', nameCn: '进击的巨人' },
    { id: 1, name: '葬送のフリーレン', nameCn: '葬送的芙莉莲' },
    { id: 2, name: '葬送のフリーレン 第2期', nameCn: '葬送的芙莉莲 第二季' },
  ];

  it('按分数降序，取前 N 个', () => {
    const ranked = rankCandidates({ title: '葬送的芙莉莲' }, candidates, 2);
    expect(ranked).toHaveLength(2);
    expect(ranked[0].candidate.id).toBe(1);
    expect(ranked[0].score).toBeGreaterThanOrEqual(ranked[1].score);
  });

  it('没有候选时返回空数组', () => {
    expect(rankCandidates({ title: 'x' }, [])).toEqual([]);
  });

  it('每条都带 confidence 分档', () => {
    const ranked = rankCandidates({ title: '进击的巨人' }, candidates);
    expect(ranked[0].candidate.id).toBe(3);
    expect(['high', 'medium']).toContain(ranked[0].confidence);
  });
});
