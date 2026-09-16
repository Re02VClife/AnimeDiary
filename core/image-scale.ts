/**
 * 图像缩放与 letterbox（纯函数，不依赖 DOM / Node，便于单测）。
 *
 * 为什么不用「直接 resize 到 1024×1024」：
 * 角色立绘普遍是 1:2.8 的细长图，直接拉成正方形会把人物横向拉宽近 3 倍。
 * 实测同一张天野阳菜，拉伸预处理会让模型把大片背景误判成前景。
 * 这里统一走 letterbox：按长边等比缩放，再用背景色补边居中。
 */
import type { RgbaImage } from './white-background';

/** ImageNet 归一化参数 —— 必须与 isnet-anime 训练时一致 */
export const IMAGENET_MEAN: [number, number, number] = [0.485, 0.456, 0.406];
export const IMAGENET_STD: [number, number, number] = [0.229, 0.224, 0.225];

/** isnet-anime 的固定输入边长 */
export const CUTOUT_INPUT_SIZE = 1024;

/** letterbox 之后的版面信息，用于把 mask 精确还原回原图 */
export interface LetterboxInfo {
  /** 内容在画布中的左上角 */
  offsetX: number;
  offsetY: number;
  /** 缩放后的内容尺寸 */
  contentWidth: number;
  contentHeight: number;
}

/** 双线性缩放 RGBA */
export function resizeRgba(src: RgbaImage, dw: number, dh: number): RgbaImage {
  const { width: sw, height: sh, data } = src;
  const out = new Uint8ClampedArray(dw * dh * 4);
  if (dw <= 0 || dh <= 0) return { width: Math.max(0, dw), height: Math.max(0, dh), data: out };
  // 尺寸不变时直接复制，避免重采样带来的无谓损失
  if (dw === sw && dh === sh) {
    out.set(data);
    return { width: dw, height: dh, data: out };
  }
  const xr = sw / dw;
  const yr = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy = (y + 0.5) * yr - 0.5;
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(sh - 1, y0 + 1);
    const wy = Math.max(0, Math.min(1, sy - y0));
    for (let x = 0; x < dw; x++) {
      const sx = (x + 0.5) * xr - 0.5;
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(sw - 1, x0 + 1);
      const wx = Math.max(0, Math.min(1, sx - x0));
      const o = (y * dw + x) * 4;
      for (let c = 0; c < 4; c++) {
        const top = data[(y0 * sw + x0) * 4 + c] * (1 - wx) + data[(y0 * sw + x1) * 4 + c] * wx;
        const bot = data[(y1 * sw + x0) * 4 + c] * (1 - wx) + data[(y1 * sw + x1) * 4 + c] * wx;
        out[o + c] = top * (1 - wy) + bot * wy;
      }
    }
  }
  return { width: dw, height: dh, data: out };
}

/** 双线性缩放单通道浮点图（用于把 mask 缩放回原图尺寸） */
export function resizeMask(src: Float32Array, sw: number, sh: number, dw: number, dh: number): Float32Array {
  const out = new Float32Array(Math.max(0, dw) * Math.max(0, dh));
  if (dw <= 0 || dh <= 0) return out;
  if (dw === sw && dh === sh) {
    out.set(src);
    return out;
  }
  const xr = sw / dw;
  const yr = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy = (y + 0.5) * yr - 0.5;
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(sh - 1, y0 + 1);
    const wy = Math.max(0, Math.min(1, sy - y0));
    for (let x = 0; x < dw; x++) {
      const sx = (x + 0.5) * xr - 0.5;
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(sw - 1, x0 + 1);
      const wx = Math.max(0, Math.min(1, sx - x0));
      const top = src[y0 * sw + x0] * (1 - wx) + src[y0 * sw + x1] * wx;
      const bot = src[y1 * sw + x0] * (1 - wx) + src[y1 * sw + x1] * wx;
      out[y * dw + x] = top * (1 - wy) + bot * wy;
    }
  }
  return out;
}

/**
 * 等比缩放并居中补边到 size×size 画布。
 *
 * 补边用白色而不是黑/灰：这些立绘绝大多数本来就是白底，
 * 补白能与原背景连成一片，模型不会把补边当成内容的一部分。
 */
export function letterboxRgba(src: RgbaImage, size: number, fill: [number, number, number] = [255, 255, 255]): {
  image: RgbaImage;
  box: LetterboxInfo;
} {
  const { width: sw, height: sh } = src;
  const scale = Math.min(size / sw, size / sh);
  const contentWidth = Math.max(1, Math.round(sw * scale));
  const contentHeight = Math.max(1, Math.round(sh * scale));
  const scaled = resizeRgba(src, contentWidth, contentHeight);
  const canvas = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    canvas[i * 4] = fill[0];
    canvas[i * 4 + 1] = fill[1];
    canvas[i * 4 + 2] = fill[2];
    canvas[i * 4 + 3] = 255;
  }
  const offsetX = Math.floor((size - contentWidth) / 2);
  const offsetY = Math.floor((size - contentHeight) / 2);
  for (let y = 0; y < contentHeight; y++) {
    canvas.set(
      scaled.data.subarray(y * contentWidth * 4, (y + 1) * contentWidth * 4),
      ((offsetY + y) * size + offsetX) * 4,
    );
  }
  return {
    image: { width: size, height: size, data: canvas },
    box: { offsetX, offsetY, contentWidth, contentHeight },
  };
}

/** 从整幅 mask 里裁出 letterbox 的内容区 */
export function cropMask(src: Float32Array, canvasSize: number, box: LetterboxInfo): Float32Array {
  const { offsetX, offsetY, contentWidth, contentHeight } = box;
  const out = new Float32Array(contentWidth * contentHeight);
  for (let y = 0; y < contentHeight; y++) {
    const srcRow = (offsetY + y) * canvasSize + offsetX;
    out.set(src.subarray(srcRow, srcRow + contentWidth), y * contentWidth);
  }
  return out;
}

/**
 * RGBA → CHW float32 张量数据（RGB/255 后做 ImageNet 归一化）。
 * 输出布局为 [3, size, size]，与 ONNX 的 NCHW 约定一致。
 */
export function rgbaToChw(
  rgba: RgbaImage,
  mean: [number, number, number] = IMAGENET_MEAN,
  std: [number, number, number] = IMAGENET_STD,
): Float32Array {
  const { width: w, height: h, data } = rgba;
  const area = w * h;
  const chw = new Float32Array(3 * area);
  for (let i = 0; i < area; i++) {
    chw[i] = (data[i * 4] / 255 - mean[0]) / std[0];
    chw[area + i] = (data[i * 4 + 1] / 255 - mean[1]) / std[1];
    chw[2 * area + i] = (data[i * 4 + 2] / 255 - mean[2]) / std[2];
  }
  return chw;
}

/** 把 mask（0..1）作为 alpha 贴回原图，返回可编码为 PNG 的 RGBA */
export function applyMaskToAlpha(src: RgbaImage, mask: Float32Array): Uint8ClampedArray {
  const n = src.width * src.height;
  const out = new Uint8ClampedArray(src.data);
  for (let i = 0; i < n; i++) {
    const a = mask[i];
    out[i * 4 + 3] = Math.round(Math.max(0, Math.min(1, a)) * 255);
  }
  return out;
}
