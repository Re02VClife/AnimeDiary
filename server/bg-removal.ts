/**
 * AI 抠图（isnet-anime，rembg 的动漫专用模型，MIT）。
 *
 * ── 为什么还要 AI ──
 * 白底洪泛对「背景就是一整片白」的立绘够用（实测 100 张里 88 张干净），
 * 但对实景背景、拼贴图、渐变底完全无能为力（天野阳菜的透明率只有 0.8%）。
 * 换成这个模型后同一批图：天野阳菜 0.8% → 65.3%，千反田爱瑠 4.7% → 56.3%，
 * 并且角色的白衣服、白帽子靠语义识别保住，不再依赖「有没有描边」。
 *
 * ── 为什么能比白底洪泛快得不成比例 ──
 * 实测 168MB 的 isnet-anime 单张 0.4s，而 470MB 的 ToonOut(BiRefNet) 要 7.9s，
 * 两者出图质量肉眼几乎分不出来 —— 所以这里用 isnet-anime。
 *
 * ── 运行时从哪来 ──
 * onnxruntime-node 是原生模块。为了**不重装应用**，它和模型都不进安装包、
 * 也不进热更新包，而是放在数据目录下：
 *   {DATA_DIR}/runtime/node_modules/onnxruntime-node   （已裁掉非 win32/x64，64MB）
 *   {DATA_DIR}/models/isnet-anime.onnx                  （168MB）
 * 加载优先级：宿主注入的 loadOrt → dataDir/runtime → 项目 node_modules（开发模式）。
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  letterboxRgba,
  cropMask,
  resizeMask,
  rgbaToChw,
  applyMaskToAlpha,
  CUTOUT_INPUT_SIZE,
} from '../core/image-scale';
import type { RgbaImage } from '../core/white-background';

export interface BgRemovalResult {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  /** 完全透明像素占比 */
  transparentRatio: number;
  /** 完全不透明像素占比 */
  opaqueRatio: number;
  inferenceMs: number;
}

export interface BgRemoverStatus {
  /** 模型与运行时都就绪才为 true */
  ready: boolean;
  modelFile: string;
  modelMB: number;
  modelPath: string;
  runtimeReady: boolean;
  runtimePath: string;
  /** 首次推理失败的原因（用于界面提示） */
  error?: string;
}

export interface BgRemover {
  status(): BgRemoverStatus;
  remove(rgba: Uint8ClampedArray, width: number, height: number): Promise<BgRemovalResult>;
  dispose(): Promise<void>;
}

export const CUTOUT_MODEL_FILE = 'isnet-anime.onnx';

/** 模型推理包装。加载失败不会抛到调用方，而是在 status() 里以 error 呈现 */
export function createBgRemover(dataDir: string, loadOrt?: () => unknown): BgRemover {
  const modelPath = path.join(dataDir, 'models', CUTOUT_MODEL_FILE);
  const runtimePath = path.join(dataDir, 'runtime', 'node_modules', 'onnxruntime-node');

  let enginePromise: Promise<{ ort: any; session: any }> | null = null;
  let lastError: string | undefined;

  const modelReady = () => fs.existsSync(modelPath);
  const runtimeReady = () => fs.existsSync(runtimePath);

  function resolveOrt(): any {
    if (loadOrt) return loadOrt();
    const req: any = typeof require === 'function' ? require : null;
    if (!req) throw new Error('当前环境不支持 require，无法加载 onnxruntime-node');
    if (runtimeReady()) {
      // 从 dataDir/runtime 解析；createRequire 只借用这个路径当基准，文件本身不必存在
      const Module = req('module');
      const fromRuntime = Module.createRequire(path.join(dataDir, 'runtime', 'noop.js'));
      return fromRuntime('onnxruntime-node');
    }
    return req('onnxruntime-node');
  }

  async function getEngine() {
    if (!enginePromise) {
      enginePromise = (async () => {
        if (!modelReady()) {
          throw new Error(`抠图模型缺失：${modelPath}（需要 ${CUTOUT_MODEL_FILE}）`);
        }
        const ort = resolveOrt();
        const session = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] });
        return { ort, session };
      })().catch((e) => {
        // 失败不缓存，下次调用可以重试（比如用户刚补上模型文件）
        enginePromise = null;
        lastError = e instanceof Error ? e.message : String(e);
        throw e;
      });
    }
    return enginePromise;
  }

  function status(): BgRemoverStatus {
    // 真的尝试加载一次运行时：只判断目录是否存在并不够 ——
    // 实测 onnxruntime-node 少一个被 npm 提升到顶层的依赖（onnxruntime-common）时，
    // 目录看起来齐全，require 却会失败，界面就误报「就绪」。
    // require 有缓存，重复调用开销可以忽略。
    let runtimeOk = false;
    let error: string | undefined;
    try {
      resolveOrt();
      runtimeOk = true;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    if (!error && lastError) error = lastError;
    const modelOk = modelReady();
    return {
      ready: modelOk && runtimeOk && !lastError,
      modelFile: CUTOUT_MODEL_FILE,
      modelMB: modelOk ? Math.round(fs.statSync(modelPath).size / 1048576) : 0,
      modelPath,
      runtimeReady: runtimeOk,
      runtimePath,
      error,
    };
  }

  async function remove(rgba: Uint8ClampedArray, width: number, height: number): Promise<BgRemovalResult> {
    if (!width || !height) throw new Error('图片尺寸非法');
    const { ort, session } = await getEngine();
    const started = Date.now();

    const src: RgbaImage = { width, height, data: rgba };
    // 等比缩放 + 白边补齐：立绘多是 1:2.8 细长图，直接拉成正方形会让模型认错背景
    const { image, box } = letterboxRgba(src, CUTOUT_INPUT_SIZE);
    const chw = rgbaToChw(image);

    const tensor = new ort.Tensor('float32', chw, [1, 3, CUTOUT_INPUT_SIZE, CUTOUT_INPUT_SIZE]);
    const outputs = await session.run({ [session.inputNames[0]]: tensor });
    const maskCanvas = outputs[session.outputNames[0]].data as Float32Array;

    const cropped = cropMask(maskCanvas, CUTOUT_INPUT_SIZE, box);
    const maskFull = resizeMask(cropped, box.contentWidth, box.contentHeight, width, height);
    const outRgba = applyMaskToAlpha(src, maskFull);

    let transparent = 0;
    let opaque = 0;
    const n = width * height;
    for (let i = 0; i < n; i++) {
      const a = outRgba[i * 4 + 3];
      if (a < 5) transparent++;
      else if (a > 250) opaque++;
    }

    return {
      rgba: outRgba,
      width,
      height,
      transparentRatio: transparent / n,
      opaqueRatio: opaque / n,
      inferenceMs: Date.now() - started,
    };
  }

  async function dispose() {
    const engine = enginePromise ? await enginePromise.catch(() => null) : null;
    enginePromise = null;
    if (engine && typeof engine.session.release === 'function') {
      try { await engine.session.release(); } catch { /* 释放失败不影响退出 */ }
    }
  }

  return { status, remove, dispose };
}
