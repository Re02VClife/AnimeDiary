/**
 * core/text 单元测试
 */
import { describe, it, expect } from 'vitest';
import { extractJSON, truncate, extractKeywords, parseTagString } from '../../core/text';

describe('extractJSON', () => {
  it('提取 markdown 代码块中的 JSON', () => {
    const raw = '```json\n{"key": "value"}\n```';
    expect(extractJSON(raw)).toBe('{"key": "value"}');
  });

  it('提取无语言标记的代码块', () => {
    const raw = '```\n{"a":1}\n```';
    expect(extractJSON(raw)).toBe('{"a":1}');
  });

  it('从普通文本中提取首个 {} 包裹的 JSON', () => {
    const raw = '前言文字{"result": [1,2,3]}后记文字';
    expect(extractJSON(raw)).toBe('{"result": [1,2,3]}');
  });

  it('无 JSON 结构时返回 trim 后的原文', () => {
    const raw = '  纯文本输出  ';
    expect(extractJSON(raw)).toBe('纯文本输出');
  });

  it('空字符串返回空', () => {
    expect(extractJSON('')).toBe('');
  });
});

describe('truncate', () => {
  it('短字符串不变', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('恰好等于 maxLen 不变', () => {
    expect(truncate('12345', 5)).toBe('12345');
  });

  it('超长截断并加省略号', () => {
    expect(truncate('123456', 3)).toBe('123…');
  });
});

describe('extractKeywords', () => {
  it('从中文文本提取高频词', () => {
    // 注意：分词是按标点/空格分割为片段，不做更细粒度的词语切分
    const keywords = extractKeywords(['科幻 科幻 战争 日常']);
    expect(keywords.length).toBeGreaterThan(0);
    // "科幻" 出现 2 次，应排在最前面
    expect(keywords[0]).toBe('科幻');
    // 所有词都在列表中
    expect(keywords).toContain('战争');
    expect(keywords).toContain('日常');
  });

  it('过滤停用词', () => {
    const keywords = extractKeywords(['这部番的剧情很好']);
    // "这部番" 和 "很好" 不应出现（在停用词中）
    expect(keywords).not.toContain('这部番');
    expect(keywords).not.toContain('很好');
    expect(keywords).not.toContain('的');
  });

  it('过短或过长的词被过滤', () => {
    const keywords = extractKeywords(['a bc defghijk12345']);
    // "a" 长度<2，"defghijk12345" 长度>8
    expect(keywords.every((k) => k.length >= 2 && k.length <= 8)).toBe(true);
  });

  it('空数组返回空结果', () => {
    expect(extractKeywords([])).toEqual([]);
  });
});

describe('parseTagString', () => {
  it('斜杠分隔', () => {
    expect(parseTagString('科幻/战争/音乐')).toEqual(['科幻', '战争', '音乐']);
  });

  it('顿号分隔', () => {
    expect(parseTagString('日常、治愈、剧场版')).toEqual(['日常', '治愈', '剧场版']);
  });

  it('空字符串返回空数组', () => {
    expect(parseTagString('')).toEqual([]);
    expect(parseTagString('  ')).toEqual([]);
  });

  it('去除空白', () => {
    expect(parseTagString(' 科幻 / 战争 ')).toEqual(['科幻', '战争']);
  });
});
