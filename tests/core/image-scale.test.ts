import { describe, it, expect } from 'vitest';
import {
  resizeRgba,
  resizeMask,
  letterboxRgba,
  cropMask,
  rgbaToChw,
  applyMaskToAlpha,
  IMAGENET_MEAN,
  IMAGENET_STD,
  type LetterboxInfo,
} from '../../core/image-scale';
import type { RgbaImage } from '../../core/white-background';

function makeImage(w: number, h: number, fill: [number, number, number] = [10, 20, 30]): RgbaImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = fill[0];
    data[i * 4 + 1] = fill[1];
    data[i * 4 + 2] = fill[2];
    data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
}

const px = (img: RgbaImage, x: number, y: number) => {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]] as [number, number, number];
};

describe('resizeRgba', () => {
  it('输出尺寸与请求一致', () => {
    const out = resizeRgba(makeImage(10, 20), 5, 40);
    expect(out.width).toBe(5);
    expect(out.height).toBe(40);
    expect(out.data.length).toBe(5 * 40 * 4);
  });

  it('尺寸不变时原样复制（不重采样）', () => {
    const src = makeImage(3, 3, [7, 8, 9]);
    const out = resizeRgba(src, 3, 3);
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
  });

  it('纯色图缩放后仍是同一个颜色', () => {
    const out = resizeRgba(makeImage(8, 8, [200, 100, 50]), 4, 4);
    expect(px(out, 2, 2)).toEqual([200, 100, 50]);
  });

  it('零尺寸不抛错', () => {
    const out = resizeRgba(makeImage(4, 4), 0, 0);
    expect(out.data.length).toBe(0);
  });
});

describe('resizeMask', () => {
  it('同尺寸时直接复制', () => {
    const src = new Float32Array([0, 0.5, 1, 0.25]);
    expect(Array.from(resizeMask(src, 2, 2, 2, 2))).toEqual([0, 0.5, 1, 0.25]);
  });

  it('放大后仍落在 0..1 之间', () => {
    const src = new Float32Array([0, 1, 1, 0]);
    const out = resizeMask(src, 2, 2, 6, 6);
    expect(out.length).toBe(36);
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('letterboxRgba', () => {
  it('竖长图按长边贴合并水平居中', () => {
    // 400x800 → scale = 1024/800 = 1.28 → 内容 512x1024
    const { image, box } = letterboxRgba(makeImage(400, 800), 1024);
    expect(image.width).toBe(1024);
    expect(image.height).toBe(1024);
    expect(box.contentWidth).toBe(512);
    expect(box.contentHeight).toBe(1024);
    expect(box.offsetX).toBe(256);
    expect(box.offsetY).toBe(0);
  });

  it('横长图按长边贴合并垂直居中', () => {
    const { box } = letterboxRgba(makeImage(800, 400), 1024);
    expect(box.contentWidth).toBe(1024);
    expect(box.contentHeight).toBe(512);
    expect(box.offsetX).toBe(0);
    expect(box.offsetY).toBe(256);
  });

  it('正方形图铺满画布，没有补边', () => {
    const { box } = letterboxRgba(makeImage(300, 300), 1024);
    expect(box.offsetX).toBe(0);
    expect(box.offsetY).toBe(0);
    expect(box.contentWidth).toBe(1024);
    expect(box.contentHeight).toBe(1024);
  });

  it('补边区域是白色，内容区域是原色', () => {
    const { image, box } = letterboxRgba(makeImage(400, 800, [12, 34, 56]), 1024);
    // 左上角属于补边
    expect(px(image, 0, 0)).toEqual([255, 255, 255]);
    // 内容中心是原色
    expect(px(image, 512, 512)).toEqual([12, 34, 56]);
    // 内容左边界正好从 offsetX 开始
    expect(px(image, box.offsetX, 500)).toEqual([12, 34, 56]);
    expect(px(image, box.offsetX - 1, 500)).toEqual([255, 255, 255]);
  });

  it('内容完整落在画布内', () => {
    for (const [w, h] of [[504, 1440], [1440, 504], [751, 1378], [100, 100]]) {
      const { box } = letterboxRgba(makeImage(w, h), 1024);
      expect(box.offsetX).toBeGreaterThanOrEqual(0);
      expect(box.offsetY).toBeGreaterThanOrEqual(0);
      expect(box.offsetX + box.contentWidth).toBeLessThanOrEqual(1024);
      expect(box.offsetY + box.contentHeight).toBeLessThanOrEqual(1024);
    }
  });
});

describe('cropMask', () => {
  it('按版面信息裁出内容区', () => {
    // 4x4 画布，内容在 (1,1)-(2,2)
    const canvas = new Float32Array(16);
    for (const [x, y] of [[1, 1], [2, 1], [1, 2], [2, 2]]) canvas[y * 4 + x] = 1;
    const box: LetterboxInfo = { offsetX: 1, offsetY: 1, contentWidth: 2, contentHeight: 2 };
    expect(Array.from(cropMask(canvas, 4, box))).toEqual([1, 1, 1, 1]);
  });

  it('裁出的长度等于内容面积', () => {
    const box: LetterboxInfo = { offsetX: 2, offsetY: 3, contentWidth: 5, contentHeight: 7 };
    const out = cropMask(new Float32Array(64), 8, box);
    expect(out.length).toBe(35);
  });
});

describe('rgbaToChw', () => {
  it('按 ImageNet 参数归一化，并与 NCHW 排布一致', () => {
    const img = makeImage(1, 1, [255, 0, 0]);
    const chw = rgbaToChw(img);
    expect(chw.length).toBe(3);
    expect(chw[0]).toBeCloseTo((1 - IMAGENET_MEAN[0]) / IMAGENET_STD[0], 5);
    expect(chw[1]).toBeCloseTo((0 - IMAGENET_MEAN[1]) / IMAGENET_STD[1], 5);
    expect(chw[2]).toBeCloseTo((0 - IMAGENET_MEAN[2]) / IMAGENET_STD[2], 5);
  });

  it('通道分离：第 i 个像素的 R 落在前 1/3 区段', () => {
    const img = makeImage(2, 1, [0, 0, 0]);
    img.data[0] = 255; // 第 0 个像素的 R
    const chw = rgbaToChw(img);
    const area = 2;
    expect(chw[0]).toBeGreaterThan(chw[1]);
    expect(chw[area]).toBeCloseTo((0 - IMAGENET_MEAN[1]) / IMAGENET_STD[1], 5);
  });
});

describe('applyMaskToAlpha', () => {
  it('把 mask 写进 alpha，并保留原色', () => {
    const src = makeImage(2, 1, [11, 22, 33]);
    const out = applyMaskToAlpha(src, new Float32Array([0, 1]));
    expect(out[0]).toBe(11);
    expect(out[1]).toBe(22);
    expect(out[2]).toBe(33);
    expect(out[3]).toBe(0);
    expect(out[7]).toBe(255);
  });

  it('越界值被夹到 0..255', () => {
    const src = makeImage(2, 1);
    const out = applyMaskToAlpha(src, new Float32Array([-3, 9]));
    expect(out[3]).toBe(0);
    expect(out[7]).toBe(255);
  });

  it('不修改原图', () => {
    const src = makeImage(1, 1);
    const before = src.data[3];
    applyMaskToAlpha(src, new Float32Array([0]));
    expect(src.data[3]).toBe(before);
  });
});
