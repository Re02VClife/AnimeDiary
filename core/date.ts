/**
 * core/date — 日期转换工具函数
 *   纯函数，零业务耦合，可跨项目复用
 */

/** 将 Excel 序列号转为 ISO 日期字符串 (YYYY-MM-DD) */
export function excelSerialToDate(serial: number): string {
  if (!serial || serial < 1) return '';
  const utcDays = Math.floor(serial) - 25569;
  const date = new Date(utcDays * 86400 * 1000);
  return date.toISOString().split('T')[0];
}

/** 将 ISO 日期字符串转为 Excel 序列号 */
export function dateToExcelSerial(dateStr: string): number {
  if (!dateStr) return 0;
  const d = new Date(dateStr);
  return Math.round(d.getTime() / 86400000) + 25569;
}

/**
 * 解析上映年月格式
 *   "21/4" → "2021-04"
 *   "99/12" → "1999-12"
 *   "05/1"  → "2005-01"
 */
export function parseReleaseDate(raw: string): string {
  if (!raw) return '';
  const parts = String(raw).split('/');
  if (parts.length === 2) {
    let year = parseInt(parts[0], 10);
    const month = parts[1].padStart(2, '0');
    if (year < 50) year += 2000;
    else if (year < 100) year += 1900;
    return `${year}-${month}`;
  }
  return String(raw);
}

/**
 * 解析数值，无效输入返回 0
 *   (虽然不是日期函数，但在 Excel 数据解析中与日期函数紧密配合)
 */
export function parseNumber(raw: unknown): number {
  if (raw === '' || raw === null || raw === undefined) return 0;
  const n = Number(raw);
  return isNaN(n) ? 0 : n;
}
