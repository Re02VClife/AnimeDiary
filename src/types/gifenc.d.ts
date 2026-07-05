declare module 'gifenc' {
  function GIFEncoder(): {
    writeFrame(index: Uint8Array | Uint8ClampedArray, width: number, height: number, opts: { palette: number[][]; delay: number }): void;
    finish(): void;
    bytes(): Uint8Array;
  };
  function quantize(data: Uint8Array | Uint8ClampedArray, colors: number): number[][];
  function applyPalette(data: Uint8Array | Uint8ClampedArray, palette: number[][]): Uint8Array;
}
