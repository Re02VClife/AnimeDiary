/**
 * core/date 单元测试
 */
import { describe, it, expect } from 'vitest';
import { excelSerialToDate, dateToExcelSerial, parseReleaseDate, formatReleaseDateCn, parseNumber } from '../../core/date';

describe('excelSerialToDate', () => {
  it('序列号 0 或负数返回空', () => {
    expect(excelSerialToDate(0)).toBe('');
    expect(excelSerialToDate(-1)).toBe('');
  });

  it('合法序列号返回 ISO 日期', () => {
    // 2024-01-01 对应序列号约 45292
    const result = excelSerialToDate(45292);
    expect(result).toBe('2024-01-01');
  });

  it('NaN 返回空', () => {
    expect(excelSerialToDate(NaN)).toBe('');
  });
});

describe('dateToExcelSerial', () => {
  it('空字符串返回 0', () => {
    expect(dateToExcelSerial('')).toBe(0);
  });

  it('合法日期返回序列号', () => {
    const serial = dateToExcelSerial('2024-01-01');
    expect(serial).toBe(45292);
  });

  it('往返转换一致', () => {
    const date = '2024-06-15';
    const serial = dateToExcelSerial(date);
    const back = excelSerialToDate(serial);
    expect(back).toBe(date);
  });
});

describe('parseReleaseDate', () => {
  it('"21/4" → "2021-04"', () => {
    expect(parseReleaseDate('21/4')).toBe('2021-04');
  });

  it('"99/12" → "1999-12"', () => {
    expect(parseReleaseDate('99/12')).toBe('1999-12');
  });

  it('"05/1" → "2005-01"（补零）', () => {
    expect(parseReleaseDate('05/1')).toBe('2005-01');
  });

  it('已经是标准格式保持不变', () => {
    expect(parseReleaseDate('2021-04')).toBe('2021-04');
  });

  it('空字符串返回空', () => {
    expect(parseReleaseDate('')).toBe('');
  });

  // 回归：用户表里出现过 Excel 日期序列号被当成字符串存下来，
  // 原来会原样返回 "46138"，前端 dayjs 再把前 4 位当成年份 → 日期面板翻到 4613 年
  it('"46138"（Excel 日期序列号）→ "2026-04"', () => {
    expect(parseReleaseDate('46138')).toBe('2026-04');
  });

  it('点分隔 "26.7" → "2026-07"', () => {
    expect(parseReleaseDate('26.7')).toBe('2026-07');
  });

  it('四位年份 + 未补零月份 "2026-4" → "2026-04"', () => {
    expect(parseReleaseDate('2026-4')).toBe('2026-04');
  });

  it('斜杠全称 "2021/04" → "2021-04"', () => {
    expect(parseReleaseDate('2021/04')).toBe('2021-04');
  });

  it('中文 "2021年4月" → "2021-04"', () => {
    expect(parseReleaseDate('2021年4月')).toBe('2021-04');
  });

  it('完整日期 "2021-04-17" 只取年月', () => {
    expect(parseReleaseDate('2021-04-17')).toBe('2021-04');
  });

  it('只填年份 "2021" → "2021-01"', () => {
    expect(parseReleaseDate('2021')).toBe('2021-01');
  });

  it('无法识别时原样返回', () => {
    expect(parseReleaseDate('待定')).toBe('待定');
  });

  it('月份越界不硬凑（"2021-13" 原样返回）', () => {
    expect(parseReleaseDate('2021-13')).toBe('2021-13');
  });
});

describe('formatReleaseDateCn', () => {
  it('"2021-04" → "2021年4月"', () => {
    expect(formatReleaseDateCn('2021-04')).toBe('2021年4月');
  });

  it('"23/10" → "2023年10月"', () => {
    expect(formatReleaseDateCn('23/10')).toBe('2023年10月');
  });

  it('空值返回空', () => {
    expect(formatReleaseDateCn('')).toBe('');
    expect(formatReleaseDateCn(undefined)).toBe('');
  });

  it('无法识别时原样返回', () => {
    expect(formatReleaseDateCn('待定')).toBe('待定');
  });
});

describe('parseNumber', () => {
  it('正常数字字符串', () => {
    expect(parseNumber('42')).toBe(42);
    expect(parseNumber('3.14')).toBe(3.14);
  });

  it('空值返回 0', () => {
    expect(parseNumber('')).toBe(0);
    expect(parseNumber(null)).toBe(0);
    expect(parseNumber(undefined)).toBe(0);
  });

  it('非数字返回 0', () => {
    expect(parseNumber('abc')).toBe(0);
  });

  it('数字类型直接返回', () => {
    expect(parseNumber(7.6)).toBe(7.6);
  });
});
