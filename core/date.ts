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
 * 解析上映年月格式，统一为 "YYYY-MM"
 *   "21/4"   → "2021-04"
 *   "99/12"  → "1999-12"
 *   "05/1"   → "2005-01"
 *   "26.7"   → "2026-07"
 *   "2021年4月" → "2021-04"
 *   "2021"   → "2021-01"
 *   "46138"  → "2026-04"（Excel 日期序列号，曾被当成「4613 年」写进日期选择器）
 * 无法识别时原样返回，交由调用方处理。
 */
export function parseReleaseDate(raw: string): string {
  if (raw === null || raw === undefined) return '';
  const s = String(raw).trim();
  if (!s) return '';

  // 1) 完整日期 "2021-04-17" / "2021/4/17" / "2021年4月17日"
  const full = s.match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?$/);
  if (full) {
    const y = parseInt(full[1], 10);
    const mo = parseInt(full[2], 10);
    if (mo >= 1 && mo <= 12 && y >= 1900 && y <= 2100) {
      return `${y}-${String(mo).padStart(2, '0')}`;
    }
  }

  // 2) 年月 "2021-04" / "21/4" / "26.7" / "2021年4月"
  const ym = s.match(/^(\d{2,4})\s*[-/.年]\s*(\d{1,2})\s*月?$/);
  if (ym) {
    let y = parseInt(ym[1], 10);
    const mo = parseInt(ym[2], 10);
    if (ym[1].length <= 2) y += y < 50 ? 2000 : 1900;
    if (mo >= 1 && mo <= 12 && y >= 1900 && y <= 2100) {
      return `${y}-${String(mo).padStart(2, '0')}`;
    }
  }

  // 3) 纯数字：5 位以上视作 Excel 日期序列号（46138 → 2026-04），4 位视作年份
  if (/^\d+$/.test(s)) {
    if (s.length >= 5) {
      const iso = excelSerialToDate(Number(s));
      if (iso) return iso.slice(0, 7);
    } else if (s.length === 4) {
      return `${s}-01`;
    }
  }

  return s;
}

/**
 * 上映年月的中文显示："2021-04" → "2021年4月"
 * 解析不出年月时原样返回（不隐藏原始数据）
 */
export function formatReleaseDateCn(raw: string | undefined): string {
  const s = parseReleaseDate(raw || '');
  const m = s.match(/^(\d{4})-(\d{2})$/);
  return m ? `${m[1]}年${parseInt(m[2], 10)}月` : s;
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
