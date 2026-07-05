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

/** FLIP 海报过渡：克隆海报从网格位置飞入详情面板位置，同步过渡裁剪位置 */
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
    const timeout = setTimeout(done, 500);
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

  const base: React.CSSProperties = {
    position: 'fixed',
    zIndex: 10000,
    objectFit: 'cover',
    pointerEvents: 'none',
    borderRadius: animating ? 8 : 10,
    left: animating ? endRect.left : startRect.left,
    top: animating ? endRect.top : startRect.top,
    width: animating ? endRect.width : startRect.width,
    height: animating ? endRect.height : startRect.height,
    objectPosition: animating ? (endObjPos || '50% 50%') : (startObjPos || '50% 50%'),
    transition: animating
      ? 'all 0.35s cubic-bezier(0.4, 0, 0.2, 1)'
      : 'none',
  };

  return createPortal(
    <img
      src={posterUrl}
      style={base}
      onTransitionEnd={handleTransitionEnd}
    />,
    document.body
  );
};

export default PosterFlipOverlay;
