/**
 * 两个纯 JS 图片库自带的类型声明（它们没有发行 .d.ts，
 * 而 server/ 下的代码会被 tests 引入从而参与 tsc 检查，必须补上）。
 */
declare module 'jpeg-js' {
  export interface RawImage {
    width: number;
    height: number;
    data: Uint8Array;
  }
  export function decode(
    data: Buffer | Uint8Array,
    opts?: {
      useTArray?: boolean;
      formatAsRGBA?: boolean;
      maxMemoryUsageInMB?: number;
      tolerantDecoding?: boolean;
    },
  ): RawImage;
  export function encode(
    raw: { data: Uint8Array; width: number; height: number },
    quality?: number,
  ): { data: Buffer };
}

declare module 'pngjs' {
  export class PNG {
    width: number;
    height: number;
    data: Buffer;
    constructor(options?: { width?: number; height?: number; fill?: boolean });
    static sync: {
      read(buffer: Buffer, options?: unknown): PNG;
      write(png: PNG, options?: unknown): Buffer;
    };
  }
}
