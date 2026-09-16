import { describe, it, expect } from 'vitest';
import {
  removeWhiteBackground,
  describeCutoutQuality,
  SUSPICIOUS_BG_RATIO,
  SUSPICIOUS_CORNER_OPAQUE,
  type RgbaImage,
} from '../../core/white-background';

/** 造一张纯色图 */
function makeImage(w: number, h: number, fill: [number, number, number] = [255, 255, 255]): RgbaImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = fill[0];
    data[i * 4 + 1] = fill[1];
    data[i * 4 + 2] = fill[2];
    data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
}

function setPx(img: RgbaImage, x: number, y: number, rgb: [number, number, number]) {
  const i = (y * img.width + x) * 4;
  img.data[i] = rgb[0];
  img.data[i + 1] = rgb[1];
  img.data[i + 2] = rgb[2];
}

function fillRect(img: RgbaImage, x0: number, y0: number, x1: number, y1: number, rgb: [number, number, number]) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) setPx(img, x, y, rgb);
}

const alpha = (img: RgbaImage, x: number, y: number) => img.data[(y * img.width + x) * 4 + 3];
const px = (img: RgbaImage, x: number, y: number) => {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]] as [number, number, number];
};

describe('removeWhiteBackground', () => {
  it('整张纯白图会被完全透明化', () => {
    const img = makeImage(8, 8);
    const stats = removeWhiteBackground(img);
    expect(stats.bg).toEqual([255, 255, 255]);
    expect(stats.bgRatio).toBe(1);
    expect(alpha(img, 0, 0)).toBe(0);
    expect(alpha(img, 7, 7)).toBe(0);
  });

  it('不接触边界的色块保留不透明，四周背景被移除', () => {
    const img = makeImage(12, 12);
    fillRect(img, 4, 4, 7, 7, [0, 0, 0]);
    const stats = removeWhiteBackground(img);
    expect(alpha(img, 5, 5)).toBe(255);
    expect(alpha(img, 0, 0)).toBe(0);
    expect(stats.bgRatio).toBeGreaterThan(0.5);
    expect(stats.bgRatio).toBeLessThan(1);
  });

  it('被描边围住的白（角色白衣服）必须保留 —— 这是本功能的核心约束', () => {
    // 12x12 全白，画一个 1px 黑框，框内中心留白
    const img = makeImage(12, 12);
    for (let y = 4; y <= 8; y++) {
      for (let x = 4; x <= 8; x++) {
        const isBorder = x === 4 || x === 8 || y === 4 || y === 8;
        setPx(img, x, y, isBorder ? [0, 0, 0] : [255, 255, 255]);
      }
    }
    removeWhiteBackground(img);
    // 框中心的纯白到不了图像边界 → 不能被洪泛吃掉
    expect(alpha(img, 6, 6)).toBe(255);
    // 框外的白正常移除
    expect(alpha(img, 0, 0)).toBe(0);
    expect(alpha(img, 11, 11)).toBe(0);
  });

  it('灰白底（#f0f0f0）也能识别为背景，不必是纯白', () => {
    const img = makeImage(10, 10, [240, 240, 240]);
    fillRect(img, 4, 4, 6, 6, [0, 0, 0]);
    const stats = removeWhiteBackground(img);
    expect(stats.bg).toEqual([240, 240, 240]);
    expect(alpha(img, 0, 0)).toBe(0);
    expect(alpha(img, 5, 5)).toBe(255);
  });

  it('非白底同样按「背景色」处理 —— 算法认的是采样色而不是白色', () => {
    const img = makeImage(10, 10, [30, 90, 200]);
    const stats = removeWhiteBackground(img);
    expect(stats.bg).toEqual([30, 90, 200]);
    expect(stats.bgRatio).toBe(1);
    expect(alpha(img, 5, 5)).toBe(0);
  });

  it('背景与前景之间的过渡像素得到介于 0 和 255 的 alpha', () => {
    // 浅灰块（dist≈0.098）落在 solidTol 与 edgeTol 之间
    const img = makeImage(10, 10);
    fillRect(img, 4, 4, 5, 5, [230, 230, 230]);
    removeWhiteBackground(img);
    const a = alpha(img, 4, 4);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(255);
  });

  it('颜色去污会把半透明像素往前景色推（消除白边）', () => {
    const img = makeImage(10, 10);
    fillRect(img, 4, 4, 5, 5, [230, 230, 230]);
    removeWhiteBackground(img);
    // 只设 alpha 的话颜色仍是 230（偏白）；去污后应明显变暗
    expect(px(img, 4, 4)[0]).toBeLessThan(230);
  });

  it('关闭去污时只改 alpha、不动颜色', () => {
    const img = makeImage(10, 10);
    fillRect(img, 4, 4, 5, 5, [230, 230, 230]);
    removeWhiteBackground(img, { decontaminate: false });
    expect(alpha(img, 4, 4)).toBeGreaterThan(0);
    expect(px(img, 4, 4)).toEqual([230, 230, 230]);
  });

  it('solidTol 越大吃掉的背景越多', () => {
    // 白边框 + 220 灰内部：背景采样为白，灰块 dist≈0.137
    const build = () => {
      const img = makeImage(10, 10);
      fillRect(img, 1, 1, 8, 8, [220, 220, 220]);
      return img;
    };
    const strict = build();
    const loose = build();
    removeWhiteBackground(strict, { solidTol: 0.05 });
    removeWhiteBackground(loose, { solidTol: 0.2 });
    // 严格阈值下灰块只在边缘变半透明，宽松阈值下整块被当背景吃掉
    expect(alpha(strict, 5, 5)).not.toBe(0);
    expect(alpha(loose, 5, 5)).toBe(0);
  });

  it('统计四个角的不透明占比，用于提示「背景不是白底」', () => {
    const img = makeImage(64, 64);
    // 占满整个角落采样区（16x16），确保检出
    fillRect(img, 0, 0, 15, 15, [10, 200, 10]);
    const stats = removeWhiteBackground(img);
    expect(stats.cornerOpaque).toBeGreaterThan(SUSPICIOUS_CORNER_OPAQUE);
    expect(stats.cornerOpaque).toBeLessThan(1);
  });

  it('干净的白底立绘角落占比为 0', () => {
    const img = makeImage(64, 64);
    fillRect(img, 20, 20, 40, 40, [10, 10, 10]);
    const stats = removeWhiteBackground(img);
    expect(stats.cornerOpaque).toBe(0);
    expect(stats.bgRatio).toBeGreaterThan(SUSPICIOUS_BG_RATIO);
  });

  it('空图不抛错', () => {
    const img: RgbaImage = { width: 0, height: 0, data: new Uint8ClampedArray(0) };
    const stats = removeWhiteBackground(img);
    expect(stats.bgRatio).toBe(0);
    expect(stats.size).toBe('0x0');
  });

  it('记录尺寸与软边占比', () => {
    const img = makeImage(20, 30);
    fillRect(img, 5, 5, 14, 24, [0, 0, 0]);
    const stats = removeWhiteBackground(img);
    expect(stats.size).toBe('20x30');
    expect(stats.softRatio).toBeGreaterThan(0);
  });
});

describe('describeCutoutQuality', () => {
  const base = { bg: [255, 255, 255] as [number, number, number], bgRatio: 0.5, softRatio: 0.01, cornerOpaque: 0, size: '10x10' };

  it('指标正常时不返回任何提示', () => {
    expect(describeCutoutQuality(base)).toEqual([]);
  });

  it('背景移除比例过低时提示可能不是白底', () => {
    const hints = describeCutoutQuality({ ...base, bgRatio: 0.08 });
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain('8.0%');
  });

  it('角落仍有内容时提示核对原图', () => {
    const hints = describeCutoutQuality({ ...base, cornerOpaque: 0.55 });
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain('四个角');
  });

  it('两项都异常时给出两条提示', () => {
    const hints = describeCutoutQuality({ ...base, bgRatio: 0.1, cornerOpaque: 1 });
    expect(hints).toHaveLength(2);
  });
});
