import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

interface PosterFlipOverlayProps {
  posterUrl: string;
  startRect: DOMRect;
  endRect: DOMRect;
  /** 起始 object-position（如 "30% 70%"） */
  startObjPos?: string;
  /** 目标 object-position */
  endObjPos?: string;
  onDone: () => void;
}

/**
 * FLIP 海报过渡：克隆海报从网格位置飞入详情面板位置。
 *
 * 为什么用 background 而不是 <img>：
 *   object-position 是离散值，不能过渡 —— 网格和详情面板的裁剪位置不同时
 *   （角色卡最明显），飞入途中图片内容会瞬间跳一下，看起来像闪帧。
 *   background-position 可以插值，配合 background-size: cover（语义与
 *   object-fit: cover 相同），裁剪位置能跟着尺寸一起连续变化。
 */
const PosterFlipOverlay: React.FC<PosterFlipOverlayProps> = ({
  posterUrl, startRect, endRect, startObjPos, endObjPos, onDone,
}) => {
  const [animating, setAnimating] = useState(false);
  const doneCalled = useRef(false);

  useEffect(() => {
    const done = () => {
      if (doneCalled.current) return;
      doneCalled.current = true;
      onDone();
    };
    // 兜底：过渡事件偶尔不触发（窗口失焦等），别让副本永久留在屏幕上
    const timeout = setTimeout(done, 620);
    const raf = requestAnimationFrame(() => setAnimating(true));
    return () => { cancelAnimationFrame(raf); clearTimeout(timeout); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleTransitionEnd = (e: React.TransitionEvent) => {
    if (e.propertyName === 'left' && !doneCalled.current) {
      doneCalled.current = true;
      onDone();
    }
  };

  const ease = 'cubic-bezier(0.22, 1, 0.36, 1)';
  const move = `380ms ${ease}`;

  const base: React.CSSProperties = {
    position: 'fixed',
    zIndex: 10000,
    pointerEvents: 'none',
    borderRadius: animating ? 8 : 10,
    left: animating ? endRect.left : startRect.left,
    top: animating ? endRect.top : startRect.top,
    width: animating ? endRect.width : startRect.width,
    height: animating ? endRect.height : startRect.height,
    backgroundImage: `url(${JSON.stringify(posterUrl)})`,
    backgroundSize: 'cover',
    backgroundRepeat: 'no-repeat',
    backgroundPosition: animating ? (endObjPos || '50% 50%') : (startObjPos || '50% 50%'),
    willChange: 'left, top, width, height, background-position',
    transition: animating
      ? `left ${move}, top ${move}, width ${move}, height ${move}, border-radius ${move}, background-position ${move}`
      : 'none',
    boxShadow: '0 24px 60px -24px rgba(0, 0, 0, 0.85)',
  };

  return createPortal(
    <div style={base} onTransitionEnd={handleTransitionEnd} />,
    document.body,
  );
};

export default PosterFlipOverlay;
