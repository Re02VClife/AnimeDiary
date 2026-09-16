/**
 * 角色立绘去白底（纯函数，不依赖 DOM，便于单测）。
 *
 * ── 为什么不是「把白色像素变透明」──
 * 用户的要求是「白色背景变透明，但不要影响角色身上的白色」。
 * 全局阈值做不到：实测双叶理央的白大褂、四宫辉夜的白衬衫领与白鞋
 * 都会被一起吃掉。所以这里只把**与图像四条边连通**的白当作背景 ——
 * 被描边围住的角色白到不了边界，自然保留。
 *
 * ── 为什么背景色是采样出来的 ──
 * 立绘的底不都是纯白：实测辉夜是 #f0f0f0 灰白、宫园薰是 rgb(255,251,250) 暖白。
 * 写死 255 会把这些图的背景留下一层灰。改为采样四条边的中位数。
 *
 * ── 已知边界 ──
 * 对「背景不是一整片白」的图无效，例如：闭合的装饰边框（加藤惠）、
 * 拼贴图 / 实景照（宫园薰、森岛帆高）。这类图无法用纯像素算法区分
 * 「框内白底」与「角色白衣服」，只能由用户看预览后自己跳过。
 * 全量实测 100 张角色立绘：88 张干净，12 张需要人工判断。
 */

/** 待处理的 RGBA 像素缓冲（与 Canvas ImageData 同构） */
export interface RgbaImage {
  width: number;
  height: number;
  /** 长度 = width * height * 4，顺序 RGBA */
  data: Uint8ClampedArray;
}

export interface RemoveBackgroundOptions {
  /** 距离背景色多近算「确定的背景」，会被洪泛吃掉。默认 0.06 */
  solidTol?: number;
  /** 距离背景色多远算「完全不透明的前景」。默认 0.30 */
  edgeTol?: number;
  /** 是否做颜色去污（消除边缘白边）。默认 true */
  decontaminate?: boolean;
  /** 去污时 alpha 的下限，防止除零放大噪点。默认 0.25 */
  minAlphaForFg?: number;
}

export interface RemoveBackgroundStats {
  /** 采样得到的背景色 */
  bg: [number, number, number];
  /** 被判为背景（完全透明）的像素占比 */
  bgRatio: number;
  /** 半透明边缘像素占比 */
  softRatio: number;
  /** 四个角 (16x16) 中仍不透明的占比；正常白底立绘应接近 0 */
  cornerOpaque: number;
  /** 尺寸描述，如 "504x1440" */
  size: string;
}

/** 默认严格阈值：只吃真正接近背景色的像素，宁可少吃也不要啃到角色 */
export const DEFAULT_SOLID_TOL = 0.06;
export const DEFAULT_EDGE_TOL = 0.3;
export const DEFAULT_MIN_ALPHA_FOR_FG = 0.25;

/** 角落采样方块边长 */
const CORNER_BOX = 16;

/** 判为可疑的阈值（与全量体检脚本保持一致） */
export const SUSPICIOUS_BG_RATIO = 0.25;
export const SUSPICIOUS_CORNER_OPAQUE = 0.1;

/**
 * 就地移除白底，把 alpha 写回 `image.data`。
 *
 * 就地修改而不是返回新对象：图像缓冲动辄几百 KB，
 * 调用方（Canvas）也期望拿到同一个 ImageData。
 */
export function removeWhiteBackground(
  image: RgbaImage,
  options: RemoveBackgroundOptions = {},
): RemoveBackgroundStats {
  const solidTol = options.solidTol ?? DEFAULT_SOLID_TOL;
  const edgeTol = options.edgeTol ?? DEFAULT_EDGE_TOL;
  const decontaminate = options.decontaminate !== false;
  const minAlphaForFg = options.minAlphaForFg ?? DEFAULT_MIN_ALPHA_FOR_FG;

  const { width: w, height: h, data } = image;
  const n = w * h;
  if (n === 0) {
    return { bg: [255, 255, 255], bgRatio: 0, softRatio: 0, cornerOpaque: 0, size: `${w}x${h}` };
  }

  // ── 1. 背景色：采样四条边取中位数（中位数抗 JPEG 噪声与零星深色像素）──
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const sample = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    rs.push(data[i]);
    gs.push(data[i + 1]);
    bs.push(data[i + 2]);
  };
  const step = Math.max(1, Math.floor(Math.min(w, h) / 60));
  for (let x = 0; x < w; x += step) {
    sample(x, 0);
    sample(x, h - 1);
  }
  for (let y = 0; y < h; y += step) {
    sample(0, y);
    sample(w - 1, y);
  }
  const median = (arr: number[]) => {
    arr.sort((a, b) => a - b);
    return arr[arr.length >> 1];
  };
  const bg: [number, number, number] = [median(rs), median(gs), median(bs)];

  // ── 2. 距离场：Chebyshev 距离 ──
  // 用 max 而不是欧氏：浅粉、浅灰这类「接近白但不是白」的颜色在欧氏下距离偏小，
  // 会被误判成背景；取最大通道差更严格。
  const dist = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const dr = Math.abs(data[i * 4] - bg[0]) / 255;
    const dg = Math.abs(data[i * 4 + 1] - bg[1]) / 255;
    const db = Math.abs(data[i * 4 + 2] - bg[2]) / 255;
    dist[i] = Math.max(dr, dg, db);
  }

  // ── 3. 从四条边洪泛（显式栈，避免大图上递归爆栈）──
  const isBg = new Uint8Array(n);
  const stack: number[] = [];
  for (let x = 0; x < w; x++) {
    stack.push(x);
    stack.push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    stack.push(y * w);
    stack.push(y * w + w - 1);
  }
  let bgCount = 0;
  while (stack.length) {
    const p = stack.pop() as number;
    if (isBg[p] || dist[p] > solidTol) continue;
    isBg[p] = 1;
    bgCount++;
    const px = p % w;
    const py = (p / w) | 0;
    if (px > 0) stack.push(p - 1);
    if (px < w - 1) stack.push(p + 1);
    if (py > 0) stack.push(p - w);
    if (py < h - 1) stack.push(p + w);
  }

  // ── 4. 上色：背景全透明，贴边一圈按距离给半透明 + 颜色去污 ──
  // 去污的必要性：原图抗锯齿像素本身就是「前景色 + 白底」的混合，
  // 只设 alpha 不换色，会在深色卡片上留下一圈灰白晕。
  // 按 observed = a*前景 + (1-a)*背景 反解前景色即可。
  const out = new Uint8ClampedArray(data);
  let softCount = 0;
  for (let q = 0; q < n; q++) {
    if (isBg[q]) {
      out[q * 4 + 3] = 0;
      continue;
    }
    const qx = q % w;
    const qy = (q / w) | 0;
    let touches = false;
    for (let dy = -1; dy <= 1 && !touches; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = qx + dx;
        const ny = qy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        if (isBg[ny * w + nx]) {
          touches = true;
          break;
        }
      }
    }
    if (!touches) {
      out[q * 4 + 3] = 255;
      continue;
    }
    let t = dist[q] / edgeTol;
    if (t > 1) t = 1;
    out[q * 4 + 3] = Math.round(t * 255);
    softCount++;
    if (decontaminate && t > 0.02) {
      const aa = t < minAlphaForFg ? minAlphaForFg : t;
      for (let c = 0; c < 3; c++) {
        const v = (data[q * 4 + c] - (1 - aa) * bg[c]) / aa;
        out[q * 4 + c] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
      }
    }
  }
  data.set(out);

  // ── 5. 参考指标（只用于给用户提示，不参与算法决策）──
  const box = Math.min(CORNER_BOX, Math.floor(w / 4), Math.floor(h / 4));
  let cornerOpaque = 0;
  let cornerTotal = 0;
  if (box > 0) {
    const corners: [number, number][] = [
      [0, 0],
      [w - box, 0],
      [0, h - box],
      [w - box, h - box],
    ];
    for (const [cx0, cy0] of corners) {
      for (let cy = 0; cy < box; cy++) {
        for (let cx = 0; cx < box; cx++) {
          const idx = (cy0 + cy) * w + (cx0 + cx);
          cornerTotal++;
          if (out[idx * 4 + 3] > 128) cornerOpaque++;
        }
      }
    }
  }

  return {
    bg,
    bgRatio: bgCount / n,
    softRatio: softCount / n,
    cornerOpaque: cornerTotal ? cornerOpaque / cornerTotal : 0,
    size: `${w}x${h}`,
  };
}

/**
 * 把统计指标翻译成给用户看的中文提示。
 * 返回空数组 = 这张图处理得很干净，可以放心应用。
 */
export function describeCutoutQuality(stats: RemoveBackgroundStats): string[] {
  const hints: string[] = [];
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  if (stats.bgRatio < SUSPICIOUS_BG_RATIO) {
    hints.push(`只移除了 ${pct(stats.bgRatio)} 的背景：这张图四周可能不是干净的白底（装饰边框 / 拼贴图），或者背景本身就是别的颜色`);
  }
  if (stats.cornerOpaque > SUSPICIOUS_CORNER_OPAQUE) {
    hints.push(`四个角还剩 ${pct(stats.cornerOpaque)} 的内容没被移除：背景可能不是白底，建议对照原图确认`);
  }
  return hints;
}
