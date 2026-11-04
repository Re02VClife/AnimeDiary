/**
 * core/tag-name 单测
 *
 * 这组函数的职责只有一个：判断「这两个标签是不是同一个」。
 * 判断错了的后果是安静的数据分裂 —— 计数被劈成两半、筛选筛不全，
 * 界面上还看不出来（肉眼分不清 `科幻` 和 `科幻 `）。
 */
import { describe, it, expect } from 'vitest';
import { normalizeTagName, sameTagName, groupTagNames, findLikelyDuplicates } from '../../core/tag-name';

describe('normalizeTagName', () => {
  it('去掉首尾空白', () => {
    expect(normalizeTagName('  科幻  ')).toBe('科幻');
    expect(normalizeTagName('科幻\n')).toBe('科幻');
  });

  it('合并中间连续空白', () => {
    expect(normalizeTagName('轻 小说  改')).toBe('轻 小说 改');
  });

  it('去掉零宽字符（肉眼不可见）', () => {
    expect(normalizeTagName('科\u200B幻')).toBe('科幻');
    expect(normalizeTagName('\uFEFF科幻')).toBe('科幻');
  });

  it('全角转半角（NFKC）', () => {
    expect(normalizeTagName('３D动画')).toBe('3D动画');
    expect(normalizeTagName('ＡＢ')).toBe('AB');
  });

  it('空值与纯空白返回空串', () => {
    expect(normalizeTagName('')).toBe('');
    expect(normalizeTagName('   ')).toBe('');
  });
});

describe('sameTagName', () => {
  it('尾空格、零宽、全角都算同一个', () => {
    expect(sameTagName('科幻', '科幻 ')).toBe(true);
    expect(sameTagName('科幻', '科\u200B幻')).toBe(true);
    expect(sameTagName('3D动画', '３D动画')).toBe(true);
  });

  it('近义词不是同一个（不能自动合并，交给用户重命名）', () => {
    expect(sameTagName('漫改', '漫改画')).toBe(false);
    expect(sameTagName('轻小说改', '轻改')).toBe(false);
    expect(sameTagName('京都动画', '京阿尼')).toBe(false);
  });
});

describe('groupTagNames', () => {
  it('变体合并成一条，计数相加', () => {
    const groups = groupTagNames([
      ...Array(18).fill('科幻'),
      ...Array(10).fill('科幻 '), // 尾空格变体
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: '科幻', label: '科幻', count: 28 });
    expect(groups[0].variants).toHaveLength(2);
  });

  it('展示写法取用得最多的那个，不擅自改写用户习惯', () => {
    const groups = groupTagNames(['３D动画', '３D动画', '3D动画']);
    expect(groups[0].label).toBe('３D动画');
    expect(groups[0].count).toBe(3);
  });

  it('次数相同时取更短的写法（避免展示带空格的变体）', () => {
    const groups = groupTagNames(['科幻 ', '科幻']);
    expect(groups[0].label).toBe('科幻');
  });

  it('空名字被丢弃', () => {
    expect(groupTagNames(['', '  ', '刀'])).toHaveLength(1);
  });

  it('不同标签各自成组', () => {
    const groups = groupTagNames(['刀', '治愈', '刀']);
    expect(groups.map((g) => g.label).sort()).toEqual(['刀', '治愈']);
  });

  it('近义词不会被合并（只按归一化判断，不做语义猜测）', () => {
    const groups = groupTagNames(['漫改', '漫改画']);
    expect(groups).toHaveLength(2);
  });
});

describe('findLikelyDuplicates', () => {
  const g = (label: string, count: number) => ({ key: label, label, count, variants: [label] });

  it('短名字是长名字前缀时给出建议，保留用得多的那个', () => {
    const out = findLikelyDuplicates([g('群像', 32), g('群像剧', 15)]);
    expect(out).toHaveLength(1);
    expect(out[0].keep.label).toBe('群像');
    expect(out[0].merge.label).toBe('群像剧');
  });

  it('缩写也能认出来（漫改 / 漫画改、轻改 / 轻小说改）', () => {
    expect(findLikelyDuplicates([g('漫改', 26), g('漫画改', 14)])).toHaveLength(1);
    expect(findLikelyDuplicates([g('轻小说改', 28), g('轻改', 12)])).toHaveLength(1);
  });

  it('限定词不算缩写：反青春不是青春，昭和日常不是日常', () => {
    expect(findLikelyDuplicates([g('青春', 42), g('反青春', 3)])).toHaveLength(0);
    expect(findLikelyDuplicates([g('日常', 50), g('昭和日常', 3)])).toHaveLength(0);
  });

  it('用得都太少时不提示（长尾噪音）', () => {
    expect(findLikelyDuplicates([g('日常', 50), g('未来日常', 1)])).toHaveLength(0);
  });

  it('长度差太大时不提示', () => {
    expect(findLikelyDuplicates([g('科幻', 10), g('科幻小说改编', 3)])).toHaveLength(0);
  });

  it('单字标签不参与（误判概率太高）', () => {
    expect(findLikelyDuplicates([g('刀', 13), g('刀子', 3)])).toHaveLength(0);
  });

  it('没有缩写关系就不提示（近义词交给用户重命名）', () => {
    expect(findLikelyDuplicates([g('京都动画', 9), g('京阿尼', 4)])).toHaveLength(0);
  });

  it('同一组只出现一次', () => {
    const out = findLikelyDuplicates([g('群像', 32), g('群像剧', 15)]);
    const pairs = out.map((o) => `${o.keep.label}|${o.merge.label}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it('影响大的排前面（按两边计数之和）', () => {
    const out = findLikelyDuplicates([
      g('漫改', 26), g('漫画改', 14),   // 40
      g('日常', 50), g('日常系', 3),    // 53
    ]);
    expect(out.map((o) => o.keep.label)).toEqual(['日常', '漫改']);
  });
});
