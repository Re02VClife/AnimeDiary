/**
 * ScreenCapture — 在线截图悬浮窗
 *   主进程 screenshot-desktop (OS 原生) 截图
 *   支持：全屏截图、框选区域、逐帧录制转 GIF、拖拽移动、边框调整大小
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Button, InputNumber, Select, Slider, message, Spin } from 'antd';
import {
  CameraOutlined, VideoCameraOutlined, FolderOpenOutlined,
  CloseOutlined, PauseCircleOutlined, PlayCircleOutlined,
  HighlightOutlined,
} from '@ant-design/icons';
import { saveImage } from '../services/imageService';
import type { ImageEntry } from '../types';
import './ScreenCapture.css';

// ── 类型 ──
type CaptureMode = 'screenshot' | 'record' | 'manage';

interface GifParams { fps: number; widthPercent: number; colors: number; }

interface CropEdges { top: number; bottom: number; left: number; right: number; } // 四边裁剪像素值

interface SavedItem {
  fileName: string; url: string; size: number;
  type: 'image' | 'video' | 'gif'; createdAt: string;
}

interface ScreenCaptureProps {
  animeTitle: string;
  onImageSaved?: (entry: ImageEntry) => void;
  onClose: () => void;
}

// ── 工具 ──
function dataUrlSize(dataUrl: string): number {
  const base64 = dataUrl.split(',')[1] || '';
  return Math.round((base64.length * 3) / 4);
}
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
/** 从 video Blob 按 fps 提取帧，knownDuration 用于 MediaRecorder 缺少 duration 元数据时回退 */
async function extractFrames(
  blob: Blob, fps: number, knownDuration: number,
  onProgress?: (pct: number) => void,
): Promise<ImageData[]> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.src = URL.createObjectURL(blob);
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.onloadedmetadata = async () => {
      // MediaRecorder webm 通常 duration 为 Infinity，用 knownDuration 回退
      let duration = video.duration;
      if (!isFinite(duration) || duration <= 0) {
        duration = knownDuration || 10;
      }
      const totalFrames = Math.max(1, Math.floor(duration * fps));
      const interval = 1 / fps;
      const frames: ImageData[] = [];
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d')!;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      for (let i = 0; i < totalFrames; i++) {
        video.currentTime = i * interval;
        await new Promise<void>((r) => {
          const onSeeked = () => { video.removeEventListener('seeked', onSeeked); r(); };
          video.addEventListener('seeked', onSeeked);
        });
        ctx.drawImage(video, 0, 0);
        frames.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
        onProgress?.(Math.round(((i + 1) / totalFrames) * 100));
      }
      URL.revokeObjectURL(video.src);
      resolve(frames);
    };
    video.onerror = () => {
      URL.revokeObjectURL(video.src);
      reject(new Error('视频加载失败'));
    };
  });
}

/** 按四边像素值裁剪 dataUrl 图片 */
async function cropDataUrl(dataUrl: string, crop: CropEdges): Promise<string> {
  const img = await loadImage(dataUrl);
  const cw = img.width - crop.left - crop.right;
  const ch = img.height - crop.top - crop.bottom;
  if (cw <= 0 || ch <= 0) return dataUrl;
  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, crop.left, crop.top, cw, ch, 0, 0, cw, ch);
  return canvas.toDataURL('image/png');
}

// ── 组件 ──
const ScreenCapture: React.FC<ScreenCaptureProps> = ({ animeTitle, onImageSaved, onClose }) => {
  const [mode, setMode] = useState<CaptureMode>('screenshot');

  // 窗口尺寸 & 拖拽
  const [winSize, setWinSize] = useState({ w: 840, h: 520 });
  const [pos, setPos] = useState({ x: window.innerWidth - 864, y: window.innerHeight - 560 });
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const resizeRef = useRef<{ dir: string; sx: number; sy: number; ow: number; oh: number; ox: number; oy: number } | null>(null);

  // 截图
  const [capturedDataUrl, setCapturedDataUrl] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);

  // 框选区域
  const [crop, setCrop] = useState<CropEdges>({ top: 0, bottom: 0, left: 0, right: 0 });
  const [screenRes, setScreenRes] = useState({ w: 1920, h: 1080 }); // 用于 clip-path 计算
  const [regionSelecting, setRegionSelecting] = useState(false);
  const [regionFullImage, setRegionFullImage] = useState<string | null>(null);
  const [regionRect, setRegionRect] = useState<{ l: number; t: number; r: number; b: number } | null>(null);
  const regionStartRef = useRef<{ x: number; y: number } | null>(null);

  // 录制（MediaRecorder 高性能模式）
  const [recording, setRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [recordedBlobUrl, setRecordedBlobUrl] = useState<string | null>(null);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef2 = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordingDurationRef = useRef(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // 录制倒计时
  const [countdown, setCountdown] = useState(0); // 0=不在倒计时，>0=倒计时中
  const [countdownSec, setCountdownSec] = useState(3); // 默认3秒

  // GIF 参数
  const [gifParams, setGifParams] = useState<GifParams>({ fps: 24, widthPercent: 50, colors: 128 });
  const [gifConverting, setGifConverting] = useState(false);
  const [gifProgress, setGifProgress] = useState(0);
  const [gifResultUrl, setGifResultUrl] = useState<string | null>(null);

  // 片头片尾裁剪 + 调速
  const [trimRange, setTrimRange] = useState<[number, number]>([0, 100]); // 百分比 0-100
  const [speed, setSpeed] = useState(1); // 1=原速, 0.5=半速, 2=双倍速

  // 管理
  const [savedItems, setSavedItems] = useState<SavedItem[]>([]);
  const [saving, setSaving] = useState(false);

  const isElectron = !!window.electronAPI;

  // ── 裁剪滑块变动时跳转视频预览 ──
  useEffect(() => {
    const vid = videoRef.current;
    if (!vid || !recordedBlob) return;
    const dur = recordingDurationRef.current || 10;
    vid.currentTime = dur * (trimRange[0] / 100);
  }, [trimRange, recordedBlob]);

  // 清理
  useEffect(() => {
    return () => {
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      if (streamRef2.current) streamRef2.current.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // ── OS 原生截图 ──
  const takeScreenshot = useCallback(async (): Promise<string | null> => {
    try {
      const result = await window.electronAPI!.takeScreenshot();
      return result.dataUrl;
    } catch (err: any) {
      message.error(`截图失败: ${err?.message || '未知错误'}`);
      return null;
    }
  }, []);

  // ── 自动截图：打开截图 Tab 时立即截全屏 ──
  const doCapture = useCallback(async (): Promise<string | null> => {
    const dataUrl = await takeScreenshot();
    if (!dataUrl) return null;
    // 记录屏幕分辨率
    const img = await loadImage(dataUrl);
    setScreenRes({ w: img.width, h: img.height });
    if (crop.top || crop.bottom || crop.left || crop.right) return cropDataUrl(dataUrl, crop);
    return dataUrl;
  }, [takeScreenshot, crop]);

  useEffect(() => {
    if (isElectron && mode === 'screenshot' && !capturedDataUrl && !capturing) {
      doCapture().then((url) => { if (url) setCapturedDataUrl(url); });
    }
  }, [isElectron, mode]);

  // ── 裁剪值变化后重新截取 ──
  const prevCropRef = useRef(crop);
  useEffect(() => {
    if (!isElectron || mode !== 'screenshot') return;
    if (prevCropRef.current.top !== crop.top || prevCropRef.current.bottom !== crop.bottom
      || prevCropRef.current.left !== crop.left || prevCropRef.current.right !== crop.right) {
      prevCropRef.current = crop;
      takeScreenshot().then((dataUrl) => {
        if (dataUrl) doCapture().then((url) => { if (url) setCapturedDataUrl(url); });
      });
    }
  }, [crop]);

  // ── 单张截图 ──
  const handleScreenshot = async () => {
    setCapturing(true);
    const dataUrl = await takeScreenshot();
    if (!dataUrl) { setCapturing(false); return; }
    const hasCrop = crop.top || crop.bottom || crop.left || crop.right;
    setCapturedDataUrl(hasCrop ? await cropDataUrl(dataUrl, crop) : dataUrl);
    setCapturing(false);
  };

  const handleSaveScreenshot = async () => {
    if (!capturedDataUrl) return;
    setSaving(true);
    try {
      const entry = await saveImage(capturedDataUrl, animeTitle);
      onImageSaved?.(entry);
      setSavedItems((prev) => [...prev, {
        fileName: entry.fileName, url: entry.dataUrl,
        size: dataUrlSize(capturedDataUrl), type: 'image',
        createdAt: new Date().toISOString(),
      }]);
      message.success(`已保存「${entry.fileName}」`);
      setCapturedDataUrl(null);
    } catch { message.error('保存失败'); }
    setSaving(false);
  };

  // ── 框选区域 ──
  const handleStartRegionSelect = async () => {
    setCapturing(true);
    const dataUrl = await takeScreenshot();
    setCapturing(false);
    if (!dataUrl) return;
    setRegionFullImage(dataUrl);
    setRegionRect(null);
    setRegionSelecting(true);
  };

  const handleRegionMouseDown = (e: React.MouseEvent) => {
    regionStartRef.current = { x: e.clientX, y: e.clientY };
    setRegionRect({ l: e.clientX, t: e.clientY, r: e.clientX, b: e.clientY });
  };
  const handleRegionMouseMove = (e: React.MouseEvent) => {
    if (!regionStartRef.current) return;
    const s = regionStartRef.current;
    setRegionRect({
      l: Math.min(s.x, e.clientX), t: Math.min(s.y, e.clientY),
      r: Math.max(s.x, e.clientX), b: Math.max(s.y, e.clientY),
    });
  };
  const handleRegionMouseUp = () => {
    if (!regionRect || !regionFullImage) { setRegionSelecting(false); return; }
    // 计算相对于图片的位置比例
    const img = new Image();
    img.src = regionFullImage;
    img.onload = () => {
      setScreenRes({ w: img.width, h: img.height });
      // 图片居中显示的区域
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const imgRatio = img.width / img.height;
      const viewRatio = vw / vh;
      let imgX: number, imgY: number, imgW: number, imgH: number;
      if (imgRatio > viewRatio) {
        // 图片宽度撑满
        imgW = vw;
        imgH = vw / imgRatio;
        imgX = 0;
        imgY = (vh - imgH) / 2;
      } else {
        imgH = vh;
        imgW = vh * imgRatio;
        imgX = (vw - imgW) / 2;
        imgY = 0;
      }
      const r = regionRect!;
      // 将屏幕坐标换算为图片上的像素坐标
      const scaleX = img.width / imgW;
      const scaleY = img.height / imgH;
      const left = Math.round((r.l - imgX) * scaleX);
      const top = Math.round((r.t - imgY) * scaleY);
      const right = Math.round(img.width - (r.r - imgX) * scaleX);
      const bottom = Math.round(img.height - (r.b - imgY) * scaleY);
      setCrop({
        top: Math.max(0, top),
        bottom: Math.max(0, bottom),
        left: Math.max(0, left),
        right: Math.max(0, right),
      });
      setRegionSelecting(false);
      setRegionFullImage(null);
      setRegionRect(null);
      regionStartRef.current = null;
      message.success(`已选区: ${img.width - left - right}×${img.height - top - bottom}`);
    };
  };

  // ── 录制（MediaRecorder + getDisplayMedia，GPU 加速）──
  const startActualRecord = async () => {
    if (recordedBlobUrl) { URL.revokeObjectURL(recordedBlobUrl); }
    setRecordedBlob(null);
    setRecordedBlobUrl(null);
    chunksRef.current = [];

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true, audio: false,
      } as any);
      streamRef2.current = stream;

      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
        ? 'video/webm;codecs=vp9' : 'video/webm';
      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mimeType });
        const url = URL.createObjectURL(blob);
        setRecordedBlob(blob);
        setRecordedBlobUrl(url);
      };
      recorder.onerror = () => { message.error('录制出错'); handleStopRecord(); };

      recorder.start(100);
      setRecording(true);
      setRecordingTime(0);
      recordingTimerRef.current = setInterval(() => setRecordingTime((t) => t + 1), 1000);
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        message.error(`无法捕获屏幕: ${err?.message || err?.name}`);
      }
    }
  };

  // 点击"开始录制"→先倒计时
  const handleStartRecord = () => {
    if (countdown > 0) return; // 已在倒计时
    setCountdown(countdownSec);
  };

  // 倒计时逻辑
  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setTimeout(() => {
      if (countdown === 1) {
        setCountdown(0);
        startActualRecord();
      } else {
        setCountdown((c) => c - 1);
      }
    }, 1000);
    return () => clearTimeout(timer);
  }, [countdown]);

  const handleStopRecord = () => {
    recordingDurationRef.current = recordingTime;
    if (recordingTimerRef.current) { clearInterval(recordingTimerRef.current); recordingTimerRef.current = null; }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    if (streamRef2.current) {
      streamRef2.current.getTracks().forEach((t) => t.stop());
      streamRef2.current = null;
    }
    setRecording(false);
    setTrimRange([0, 100]);
    setSpeed(1);
  };

  // ── GIF 转换（从 webm 提取帧）──
  const handleConvertGif = async () => {
    if (!recordedBlob) { message.error('没有录制视频'); return; }
    setGifConverting(true);
    setGifProgress(0);
    setGifResultUrl(null);
    try {
      // 1. 从 webm 提取帧（按 GIF 输出 fps）
      const rawFrames = await extractFrames(recordedBlob, gifParams.fps,
        recordingDurationRef.current || recordingTime, setGifProgress);
      if (rawFrames.length === 0) { message.error('无法提取视频帧'); setGifConverting(false); return; }

      // 2. 裁剪片头片尾
      const total = rawFrames.length;
      const trimStart = Math.round(total * (trimRange[0] / 100));
      const trimEnd = Math.round(total * (trimRange[1] / 100));
      let frames = rawFrames.slice(trimStart, Math.min(total, trimEnd));

      // 3. 四边像素裁剪
      if (crop.top || crop.bottom || crop.left || crop.right) {
        const srcW = frames[0].width;
        const srcH = frames[0].height;
        const cw = srcW - crop.left - crop.right;
        const ch = srcH - crop.top - crop.bottom;
        if (cw > 0 && ch > 0) {
          frames = frames.map((fd) => {
            const tmp = document.createElement('canvas');
            tmp.width = cw; tmp.height = ch;
            const tctx = tmp.getContext('2d')!;
            const orig = document.createElement('canvas');
            orig.width = srcW; orig.height = srcH;
            orig.getContext('2d')!.putImageData(fd, 0, 0);
            tctx.drawImage(orig, crop.left, crop.top, cw, ch, 0, 0, cw, ch);
            return tctx.getImageData(0, 0, cw, ch);
          });
        }
      }

      // 4. 调速
      if (speed !== 1) {
        const adjusted: ImageData[] = [];
        if (speed > 1) {
          for (let i = 0; i < frames.length; i += speed) adjusted.push(frames[Math.floor(i)]);
        } else {
          const repeat = Math.round(1 / speed);
          for (const f of frames) {
            for (let r = 0; r < repeat; r++) adjusted.push(f);
          }
        }
        frames = adjusted;
      }
      if (frames.length === 0) { message.error('裁剪/调速后无帧'); setGifConverting(false); return; }

      // 3. 编码 GIF（帧率由 output fps 决定）
      const { GIFEncoder, quantize, applyPalette } = await import('gifenc');
      const srcW = frames[0].width;
      const srcH = frames[0].height;
      const scale = gifParams.widthPercent / 100;
      const outW = Math.max(1, Math.round(srcW * scale));
      const outH = Math.max(1, Math.round(srcH * scale));

      const gif = GIFEncoder();
      const offCanvas = document.createElement('canvas');
      offCanvas.width = outW; offCanvas.height = outH;
      const offCtx = offCanvas.getContext('2d')!;
      const frameDelay = Math.max(20, Math.round(1000 / gifParams.fps));

      setGifProgress(0);
      for (let i = 0; i < frames.length; i++) {
        const imgData = frames[i];
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = srcW; tempCanvas.height = srcH;
        tempCanvas.getContext('2d')!.putImageData(imgData, 0, 0);

        offCtx.clearRect(0, 0, outW, outH);
        offCtx.drawImage(tempCanvas, 0, 0, outW, outH);
        const scaledData = offCtx.getImageData(0, 0, outW, outH);
        const palette = quantize(scaledData.data, gifParams.colors);
        const index = applyPalette(scaledData.data, palette);
        gif.writeFrame(index, outW, outH, { palette, delay: frameDelay });
        setGifProgress(Math.round(((i + 1) / frames.length) * 100));
      }
      gif.finish();
      const uint8 = gif.bytes();
      let binary = '';
      for (let j = 0; j < uint8.length; j++) binary += String.fromCharCode(uint8[j]);
      setGifResultUrl(`data:image/gif;base64,${btoa(binary)}`);
    } catch (err: any) {
      message.error(`GIF 转换失败: ${err?.message || '未知错误'}`);
    }
    setGifConverting(false);
  };

  // 保存 GIF / 视频
  const handleSaveGif = async () => {
    if (!gifResultUrl) return;
    setSaving(true);
    try {
      const entry = await saveImage(gifResultUrl, animeTitle);
      onImageSaved?.(entry);
      setSavedItems((prev) => [...prev, {
        fileName: entry.fileName, url: entry.dataUrl,
        size: dataUrlSize(gifResultUrl), type: 'gif',
        createdAt: new Date().toISOString(),
      }]);
      message.success(`GIF 已保存「${entry.fileName}」`);
      setGifResultUrl(null);
    } catch { message.error('保存失败'); }
    setSaving(false);
  };

  const handleSaveVideo = async () => {
    if (!recordedBlob) return;
    setSaving(true);
    try {
      const arrayBuffer = await recordedBlob.arrayBuffer();
      const buffer = Array.from(new Uint8Array(arrayBuffer));
      const result = await window.electronAPI!.saveVideo(animeTitle, buffer, 'recording.webm');
      if (result.success) {
        setSavedItems((prev) => [...prev, {
          fileName: result.fileName, url: result.url,
          size: recordedBlob.size, type: 'video',
          createdAt: new Date().toISOString(),
        }]);
        message.success(`视频已保存「${result.fileName}」`);
      }
    } catch { message.error('保存失败'); }
    setSaving(false);
  };

  // ── 窗口移动拖拽 ──
  const handleHeaderMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return; // 不拦截按钮点击
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y };
    document.addEventListener('mousemove', handleMoveMouseMove);
    document.addEventListener('mouseup', handleMoveMouseUp);
  };
  const handleMoveMouseMove = (e: MouseEvent) => {
    if (!dragRef.current) return;
    setPos({
      x: Math.max(-winSize.w + 100, Math.min(window.innerWidth - 100, dragRef.current.ox + e.clientX - dragRef.current.sx)),
      y: Math.max(0, Math.min(window.innerHeight - 40, dragRef.current.oy + e.clientY - dragRef.current.sy)),
    });
  };
  const handleMoveMouseUp = () => {
    dragRef.current = null;
    document.removeEventListener('mousemove', handleMoveMouseMove);
    document.removeEventListener('mouseup', handleMoveMouseUp);
  };

  // ── 边框调整大小拖拽 ──
  const handleResizeStart = (dir: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = { dir, sx: e.clientX, sy: e.clientY, ow: winSize.w, oh: winSize.h, ox: pos.x, oy: pos.y };
    document.addEventListener('mousemove', handleResizeMouseMove);
    document.addEventListener('mouseup', handleResizeMouseUp);
  };
  const handleResizeMouseMove = (e: MouseEvent) => {
    if (!resizeRef.current) return;
    const { dir, sx, sy, ow, oh, ox, oy } = resizeRef.current;
    const dx = e.clientX - sx;
    const dy = e.clientY - sy;
    let nw = ow, nh = oh, nx = ox, ny = oy;
    if (dir.includes('e')) nw = Math.max(420, Math.min(window.innerWidth - nx - 20, ow + dx));
    if (dir.includes('s')) nh = Math.max(300, Math.min(window.innerHeight - ny - 20, oh + dy));
    if (dir.includes('w')) {
      nw = Math.max(420, ow - dx);
      nx = ox + ow - nw;
    }
    if (dir.includes('n')) {
      nh = Math.max(300, oh - dy);
      ny = oy + oh - nh;
    }
    setWinSize({ w: nw, h: nh });
    setPos({ x: nx, y: ny });
  };
  const handleResizeMouseUp = () => {
    resizeRef.current = null;
    document.removeEventListener('mousemove', handleResizeMouseMove);
    document.removeEventListener('mouseup', handleResizeMouseUp);
  };

  // ── 快捷键：倒计时中 ESC 取消，录制中 ESC 停止 ──
  useEffect(() => {
    if (!recording && countdown <= 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (countdown > 0) setCountdown(0);
        else if (recording) handleStopRecord();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [recording, countdown]);

  // ── 快捷键 ESC 退出区域选择 ──
  useEffect(() => {
    if (!regionSelecting) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setRegionSelecting(false); setRegionFullImage(null); setRegionRect(null); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [regionSelecting]);

  const formatTime = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  // ══════════════════════════════════════════
  // 渲染
  // ══════════════════════════════════════════
  const floatEl = (
    <div className="screen-capture-float"
      style={{ left: pos.x, top: pos.y, width: winSize.w, height: winSize.h }}>
      {/* 边框调整大小手柄 */}
      <div className="sc-resize-handle sc-resize-handle-e" onMouseDown={handleResizeStart('e')} />
      <div className="sc-resize-handle sc-resize-handle-s" onMouseDown={handleResizeStart('s')} />
      <div className="sc-resize-handle sc-resize-handle-se" onMouseDown={handleResizeStart('se')} />

      {/* 标题栏 */}
      <div className="sc-header" onMouseDown={handleHeaderMouseDown}>
        <div className="sc-tabs">
          <button className={`sc-tab${mode === 'screenshot' ? ' active' : ''}`}
            onClick={() => setMode('screenshot')}><CameraOutlined /> 截图</button>
          <button className={`sc-tab${mode === 'record' ? ' active' : ''}`}
            onClick={() => setMode('record')}><VideoCameraOutlined /> 录制</button>
          <button className={`sc-tab${mode === 'manage' ? ' active' : ''}`}
            onClick={() => setMode('manage')}>
            <FolderOpenOutlined /> 管理{savedItems.length > 0 && <span className="sc-badge">{savedItems.length}</span>}
          </button>
        </div>
        <Button type="text" size="small" icon={<CloseOutlined />} onClick={onClose}
          style={{ color: 'var(--text-muted)' }} />
      </div>

      <div className="sc-body">
        {/* ═══ 截图 ═══ */}
        {mode === 'screenshot' && (
          <div className="sc-panel">
            {!isElectron && (
              <div style={{ textAlign: 'center', padding: 20, color: 'var(--text-muted)' }}>
                📷 截图功能需在 Electron 桌面端使用<br />
                <span style={{ fontSize: 11 }}>请运行 npm run dev</span>
              </div>
            )}

            {isElectron && (
              <>
                {/* 操作按钮行 */}
                <div className="sc-capture-row">
                  <Button type="primary" icon={<CameraOutlined />} loading={capturing}
                    onClick={handleScreenshot} style={{ height: 42, fontSize: 15, padding: '0 36px' }}>
                    截取全屏
                  </Button>
                  <Button icon={<HighlightOutlined />} loading={capturing}
                    onClick={handleStartRegionSelect}>
                    框选区域
                  </Button>
                  <Button size="small" onClick={() => setCrop({ top: 0, bottom: 0, left: 0, right: 0 })}>重置裁剪</Button>
                </div>

                {/* 裁剪像素输入 */}
                <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
                  {(['top','bottom','left','right'] as const).map((edge) => (
                    <span key={edge} style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                      {edge === 'top' ? '上' : edge === 'bottom' ? '下' : edge === 'left' ? '左' : '右'}
                      <InputNumber size="small" min={0} value={crop[edge]}
                        onChange={(v) => setCrop((p) => ({ ...p, [edge]: v ?? 0 }))}
                        style={{ width: 64, marginLeft: 2 }} /> px
                    </span>
                  ))}
                </div>

                {/* 截图结果（仅预览画面） */}
                {capturedDataUrl ? (
                  <div className="sc-result">
                    <img src={capturedDataUrl} alt="截图结果" />
                    <div className="sc-result-actions">
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {(dataUrlSize(capturedDataUrl) / 1024).toFixed(0)}KB
                      </span>
                      <Button size="small" type="primary" loading={saving} onClick={handleSaveScreenshot}>保存</Button>
                      <Button size="small" onClick={() => setCapturedDataUrl(null)}>重拍</Button>
                    </div>
                  </div>
                ) : capturing ? (
                  <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 120 }}>
                    <Spin /> <span style={{ marginLeft: 8, color: 'var(--text-muted)', fontSize: 13 }}>截图中…</span>
                  </div>
                ) : (
                  <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13, minHeight: 120 }}>
                    点击「截取全屏」刷新
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ═══ 录制 ═══ */}
        {mode === 'record' && (
          <div className="sc-panel">
            {!isElectron && (
              <div style={{ textAlign: 'center', padding: 20, color: 'var(--text-muted)' }}>
                🎬 录制功能需在 Electron 桌面端使用
              </div>
            )}

            {!recording && !recordedBlob && (
              <>
                {isElectron && (
                  <>
                    <div className="sc-capture-row">
                      <Button type="primary" danger icon={<PlayCircleOutlined />}
                        onClick={handleStartRecord} style={{ height: 42, fontSize: 15, padding: '0 36px' }}>
                        {countdown > 0 ? `倒计时 ${countdown}...` : '开始录制'}
                      </Button>
                      <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                        倒计时
                        <InputNumber size="small" min={0} max={10} value={countdownSec}
                          onChange={(v) => setCountdownSec(v ?? 3)}
                          style={{ width: 48, marginLeft: 4 }} /> 秒
                      </span>
                      <Button icon={<HighlightOutlined />}
                        onClick={handleStartRegionSelect}>
                        框选区域
                      </Button>
                      <Button size="small" onClick={() => setCrop({ top: 0, bottom: 0, left: 0, right: 0 })}>重置</Button>
                    </div>
                    <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
                      {(['top','bottom','left','right'] as const).map((edge) => (
                        <span key={edge} style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                          {edge === 'top' ? '上' : edge === 'bottom' ? '下' : edge === 'left' ? '左' : '右'}
                          <InputNumber size="small" min={0} value={crop[edge]}
                            onChange={(v) => setCrop((p) => ({ ...p, [edge]: v ?? 0 }))}
                            style={{ width: 64, marginLeft: 2 }} /> px
                        </span>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}

            {recording && (
              <div className="sc-recording-indicator">
                <div className="sc-rec-dot" />
                <span style={{ fontWeight: 600 }}>录制中 {formatTime(recordingTime)}</span>
                <Button size="small" danger icon={<PauseCircleOutlined />}
                  onClick={handleStopRecord}>停止</Button>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>ESC</span>
              </div>
            )}

            {recordedBlob && !recording && (
              <div className="sc-result">
                {/* 视频播放器 */}
                <video ref={videoRef} src={recordedBlobUrl!} controls
                  style={{
                    width: '100%', borderRadius: 8, maxHeight: 400, background: '#000',
                    border: '1px solid var(--border-primary)',
                    ...(crop.top || crop.bottom || crop.left || crop.right ? {
                      clipPath: `inset(${(crop.top / screenRes.h * 100).toFixed(1)}% ${(crop.right / screenRes.w * 100).toFixed(1)}% ${(crop.bottom / screenRes.h * 100).toFixed(1)}% ${(crop.left / screenRes.w * 100).toFixed(1)}%)`,
                    } : {}),
                  }}
                  onPlay={() => {
                    const vid = videoRef.current; if (!vid) return;
                    const dur = recordingDurationRef.current || 10;
                    const start = dur * (trimRange[0] / 100);
                    const end = dur * (trimRange[1] / 100);
                    if (vid.currentTime < start || vid.currentTime >= end) {
                      vid.currentTime = start;
                    }
                  }}
                  onSeeked={() => {
                    const vid = videoRef.current; if (!vid) return;
                    const dur = recordingDurationRef.current || 10;
                    const start = dur * (trimRange[0] / 100);
                    const end = dur * (trimRange[1] / 100);
                    if (vid.currentTime < start) vid.currentTime = start;
                    if (vid.currentTime >= end) vid.currentTime = end - 0.1;
                  }}
                  onTimeUpdate={() => {
                    const vid = videoRef.current; if (!vid) return;
                    const dur = recordingDurationRef.current || 10;
                    const end = dur * (trimRange[1] / 100);
                    if (vid.currentTime >= end) {
                      vid.pause();
                      vid.currentTime = dur * (trimRange[0] / 100);
                    }
                  }}
                />
                <div className="sc-result-actions">
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {formatTime(recordingDurationRef.current || recordingTime)} · {(recordedBlob.size / 1024).toFixed(0)}KB
                  </span>
                  <Button size="small" type="primary" loading={saving} onClick={handleSaveVideo}>保存视频</Button>
                  <Button size="small" onClick={() => {
                    if (recordedBlobUrl) URL.revokeObjectURL(recordedBlobUrl);
                    setRecordedBlob(null); setRecordedBlobUrl(null);
                  }}>重录</Button>
                </div>

                {/* 裁剪范围 */}
                <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
                  {(['top','bottom','left','right'] as const).map((edge) => (
                    <span key={edge} style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                      {edge === 'top' ? '上' : edge === 'bottom' ? '下' : edge === 'left' ? '左' : '右'}
                      <InputNumber size="small" min={0} value={crop[edge]}
                        onChange={(v) => setCrop((p) => ({ ...p, [edge]: v ?? 0 }))}
                        style={{ width: 64, marginLeft: 2 }} /> px
                    </span>
                  ))}
                </div>

                {/* 片头片尾裁剪 + 调速 */}
                <div className="sc-gif-panel">
                  <div className="sc-gif-title">✂️ 剪辑</div>
                  <div className="sc-gif-params">
                    <div className="sc-gif-row">
                      <span>裁剪</span>
                      <Slider range min={0} max={100} value={trimRange}
                        onChange={(v) => setTrimRange(v as [number, number])}
                        style={{ flex: 1, margin: '0 12px' }}
                        tooltip={{ formatter: (v) => `${v}%` }} />
                      <span className="sc-gif-val" style={{ width: 60 }}>
                        {trimRange[0]}%-{trimRange[1]}%
                      </span>
                    </div>
                    <div className="sc-gif-row">
                      <span>速度</span>
                      <Select size="small" value={speed}
                        onChange={(v) => setSpeed(v)}
                        style={{ width: 100, margin: '0 12px' }}
                        options={[
                          { value: 0.25, label: '0.25x 慢放' },
                          { value: 0.5, label: '0.5x' },
                          { value: 1, label: '1x 原速' },
                          { value: 1.5, label: '1.5x' },
                          { value: 2, label: '2x 快放' },
                          { value: 3, label: '3x' },
                        ]} />
                    </div>
                  </div>
                </div>

                <div className="sc-gif-panel">
                  <div className="sc-gif-title">🎞️ GIF 参数</div>
                  <div className="sc-gif-params">
                    <div className="sc-gif-row">
                      <span>帧率</span>
                      <Slider min={1} max={30} value={gifParams.fps}
                        onChange={(v) => setGifParams((p) => ({ ...p, fps: v }))}
                        style={{ flex: 1, margin: '0 12px' }} />
                      <span className="sc-gif-val">{gifParams.fps}</span>
                    </div>
                    <div className="sc-gif-row">
                      <span>尺寸</span>
                      <Slider min={10} max={100} value={gifParams.widthPercent}
                        onChange={(v) => setGifParams((p) => ({ ...p, widthPercent: v }))}
                        style={{ flex: 1, margin: '0 12px' }} />
                      <span className="sc-gif-val">{gifParams.widthPercent}%</span>
                    </div>
                    <div className="sc-gif-row">
                      <span>色彩</span>
                      <Slider min={16} max={256} step={16} value={gifParams.colors}
                        onChange={(v) => setGifParams((p) => ({ ...p, colors: v }))}
                        style={{ flex: 1, margin: '0 12px' }} />
                      <span className="sc-gif-val">{gifParams.colors}</span>
                    </div>
                  </div>
                  {gifConverting ? (
                    <div style={{ textAlign: 'center', padding: 8 }}><Spin size="small" /> 转换中… {gifProgress}%</div>
                  ) : (
                    <Button size="small" block onClick={handleConvertGif}>开始转换</Button>
                  )}
                  {gifResultUrl && (
                    <div className="sc-result" style={{ marginTop: 8 }}>
                      <img src={gifResultUrl} alt="GIF" style={{ maxWidth: '100%', borderRadius: 4 }} />
                      <div className="sc-result-actions">
                        <Button size="small" type="primary" loading={saving} onClick={handleSaveGif}>保存 GIF</Button>
                        <Button size="small" onClick={() => setGifResultUrl(null)}>取消</Button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ═══ 管理 ═══ */}
        {mode === 'manage' && (
          <div className="sc-panel">
            {savedItems.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 20, color: 'var(--text-muted)', fontSize: 13 }}>📭 暂无记录</div>
            ) : (
              <div className="sc-manage-list">
                {savedItems.map((item, i) => (
                  <div key={i} className="sc-manage-item">
                    <span style={{ fontSize: 18 }}>{item.type === 'image' ? '🖼️' : item.type === 'gif' ? '🎞️' : '🎬'}</span>
                    <span style={{ flex: 1, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.fileName}</span>
                    <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{(item.size / 1024).toFixed(0)}KB</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );

  return createPortal(
    <>
      {floatEl}

      {/* 录制倒计时浮层 */}
      {countdown > 0 && createPortal(
        <div style={{
          position: 'fixed', top: 24, left: 24, zIndex: 99999,
          width: 88, height: 88, borderRadius: '50%',
          background: 'rgba(255, 77, 79, 0.9)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 4px 24px rgba(255,77,79,0.5)',
          fontSize: 48, fontWeight: 800, color: '#fff',
          fontFamily: 'monospace',
          animation: 'sc-countdown-pop 0.3s ease-out',
        }}>
          {countdown}
        </div>,
        document.body,
      )}

      {/* 框选区域全屏浮层 */}
      {regionSelecting && regionFullImage && (
        <div className="sc-region-overlay"
          onMouseDown={handleRegionMouseDown}
          onMouseMove={handleRegionMouseMove}
          onMouseUp={handleRegionMouseUp}>
          <img src={regionFullImage} alt="全屏截图" draggable={false} />
          {regionRect && (
            <div className="sc-region-box" style={{
              left: regionRect.l, top: regionRect.t,
              width: regionRect.r - regionRect.l,
              height: regionRect.b - regionRect.t,
            }} />
          )}
          <div className="sc-region-hint">
            拖拽选择区域 · 按 ESC 取消
          </div>
        </div>
      )}
    </>,
    document.body,
  );
};

export default ScreenCapture;
