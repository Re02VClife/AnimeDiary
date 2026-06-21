/**
 * core/color — 颜色转换工具函数
 *   纯函数，零业务耦合，可跨项目复用
 */

/** 将字符串哈希为 0-360 的色相值（同一名称始终同色） */
export function nameToHue(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

/** HSL → HEX 颜色转换（h: 0-360, s: 0-100, l: 0-100） */
export function hslToHex(h: number, s: number, l: number): string {
  const sNorm = s / 100;
  const lNorm = l / 100;
  const a = sNorm * Math.min(lNorm, 1 - lNorm);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return lNorm - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
  };
  const r = Math.round(f(0) * 255);
  const g = Math.round(f(8) * 255);
  const b = Math.round(f(4) * 255);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

/** HEX → HSL 颜色转换 */
export function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return { h: h * 360, s: s * 100, l: l * 100 };
}

/** 混合多个 HSL 颜色——色相取环形均值，饱和/亮度取算术均值 */
export function mixHslColors(
  colors: { h: number; s: number; l: number }[],
): { h: number; s: number; l: number } {
  if (colors.length === 0) return { h: 0, s: 0, l: 45 };
  let sinSum = 0;
  let cosSum = 0;
  let sSum = 0;
  let lSum = 0;
  for (const c of colors) {
    const rad = (c.h * Math.PI) / 180;
    sinSum += Math.sin(rad);
    cosSum += Math.cos(rad);
    sSum += c.s;
    lSum += c.l;
  }
  const avgH =
    ((Math.atan2(sinSum / colors.length, cosSum / colors.length) * 180) /
      Math.PI +
      360) %
    360;
  return {
    h: avgH,
    s: sSum / colors.length,
    l: lSum / colors.length,
  };
}
