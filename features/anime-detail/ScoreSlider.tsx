/**
 * features/anime-detail/ScoreSlider — 拖拽滑条打分控件
 *   支持鼠标拖拽/点击设置分数，带渐变填充条和刻度标记
 */
import React, { useRef, useState, useEffect, useCallback } from 'react';

interface ScoreSliderProps {
  dimKey: string;
  score: number;
  dimLabel: string;
  isVibe: boolean;
  onChange: (value: number) => void;
  onClose: () => void;
  sliderRef: React.RefObject<HTMLDivElement>;
}

const ScoreSlider: React.FC<ScoreSliderProps> = ({
  dimKey,
  score,
  dimLabel,
  isVibe,
  onChange,
  onClose,
  sliderRef,
}) => {
  const barRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [localScore, setLocalScore] = useState(score);

  // 同步外部 score 变化
  useEffect(() => { setLocalScore(score); }, [score]);

  // 点击外部关闭
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        sliderRef.current &&
        !sliderRef.current.contains(e.target as Node) &&
        !(e.target as HTMLElement).closest('.ant-input-number')
      ) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose, sliderRef]);

  // 键盘 Escape 关闭
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const step = isVibe ? 0.01 : 0.1;
  const precision = isVibe ? 2 : 1;

  /** 根据鼠标位置计算分数 */
  const calcScore = useCallback(
    (clientX: number) => {
      const bar = barRef.current;
      if (!bar) return localScore;
      const rect = bar.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const raw = pct * 10;
      const rounded = Math.round(raw / step) * step;
      return Math.max(0, Math.min(10, +rounded.toFixed(precision)));
    },
    [localScore, step, precision],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      const newScore = calcScore(e.clientX);
      setLocalScore(newScore);
      onChange(newScore);
    },
    [calcScore, onChange],
  );

  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const bar = barRef.current;
      if (!bar) return;
      const rect = bar.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const raw = pct * 10;
      const rounded = Math.round(raw / step) * step;
      const clamped = Math.max(0, Math.min(10, +rounded.toFixed(precision)));
      setLocalScore(clamped);
      onChange(clamped);
    };
    const handleUp = () => { dragging.current = false; };
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    return () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
    };
  }, [step, precision, onChange]);

  const pct = Math.min((localScore / 10) * 100, 100);

  return (
    <div
      ref={sliderRef}
      style={{
        marginTop: 8, padding: '10px 14px',
        background: '#161b22', borderRadius: 8,
        border: '1px solid rgba(251,114,153,0.2)',
        display: 'flex', alignItems: 'center', gap: 12,
      }}
    >
      <span style={{ fontSize: 12, fontWeight: 600, color: '#e6edf3', minWidth: 36 }}>
        {dimLabel}
      </span>
      <span style={{
        fontSize: 14, fontWeight: 700, color: '#fb7299',
        minWidth: isVibe ? 48 : 36, textAlign: 'center', fontVariantNumeric: 'tabular-nums',
      }}>
        {localScore.toFixed(precision)}
      </span>

      <div
        ref={barRef}
        onMouseDown={handleMouseDown}
        style={{
          flex: 1, height: 20, borderRadius: 10,
          background: '#21262d', cursor: 'pointer',
          position: 'relative', overflow: 'visible',
          userSelect: 'none',
        }}
      >
        <div
          style={{
            position: 'absolute', left: 0, top: 0, height: '100%',
            width: `${pct}%`,
            background: 'linear-gradient(90deg, #fb7299, #e85d8a)',
            borderRadius: 10,
            transition: dragging.current ? 'none' : 'width 0.1s ease',
          }}
        />
        <div
          style={{
            position: 'absolute', left: `${pct}%`, top: '50%',
            transform: 'translate(-50%, -50%)',
            width: 16, height: 16, borderRadius: '50%',
            background: '#fff',
            border: '2px solid #fb7299',
            boxShadow: '0 0 6px rgba(251,114,153,0.4)',
            pointerEvents: 'none',
          }}
        />
        {[0, 2, 4, 6, 8, 10].map((m) => (
          <div
            key={m}
            style={{
              position: 'absolute', left: `${(m / 10) * 100}%`, top: '50%',
              transform: 'translate(-50%, -50%)',
              width: 2, height: 10, background: 'rgba(255,255,255,0.15)',
              borderRadius: 1, pointerEvents: 'none',
            }}
          />
        ))}
      </div>

      <span
        onClick={onClose}
        style={{
          cursor: 'pointer', color: '#484f58', fontSize: 14,
          width: 20, textAlign: 'center', lineHeight: '20px',
        }}
        title="取消选中 (Esc)"
      >
        ✕
      </span>
    </div>
  );
};

export default ScoreSlider;
