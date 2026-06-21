/**
 * core/date 单元测试
 */
import { describe, it, expect } from 'vitest';
import { excelSerialToDate, dateToExcelSerial, parseReleaseDate, parseNumber } from '../../core/date';

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
