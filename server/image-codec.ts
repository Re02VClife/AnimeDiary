/**
 * 服务端图片编解码（纯 JS 实现，会一起打包进 api-routes.cjs）。
 *
 * 为什么不复用渲染进程的 Canvas：AI 推理跑在主进程，原图直接从磁盘读，
 * 避免把几 MB 的 base64 在前后端之间来回搬（90 张就是几百 MB 的无效流量）。
 */
import * as jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

export interface DecodedImage {
  width: number;
  height: number;
  /** RGBA */
  data: Uint8ClampedArray;
}

/** 按扩展名解码为 RGBA */
export function decodeImage(buffer: Buffer, ext: string): DecodedImage {
  const e = ext.toLowerCase();
  if (e === '.png') {
    const png = PNG.sync.read(buffer);
    return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) };
  }
  if (e === '.jpg' || e === '.jpeg') {
    const raw = jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true });
    return { width: raw.width, height: raw.height, data: new Uint8ClampedArray(raw.data) };
  }
  if (e === '.webp') {
    throw new Error('WebP 暂不支持 AI 抠图，请先把该立绘转成 JPG 或 PNG');
  }
  throw new Error(`不支持的图片格式：${ext}`);
}

/** RGBA → PNG（带 alpha 通道，这是去底图能透明的唯一前提） */
export function encodePng(width: number, height: number, rgba: Uint8ClampedArray): Buffer {
  const png = new PNG({ width, height });
  png.data = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  return PNG.sync.write(png);
}
