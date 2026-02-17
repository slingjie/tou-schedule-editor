import React from 'react';

interface UploadProgressRingProps {
  progress: number; // 0-100
  size?: number; // px
  stroke?: number; // stroke width
  className?: string;
  status?: 'uploading' | 'parsing' | 'computing' | 'done' | 'error' | 'idle';
  labelOverride?: string | null; // 自定义文本，若为空则显示百分比
}

// 简单环形进度：使用两个圆，底层背景与前景进度；文本显示百分比
export const UploadProgressRing: React.FC<UploadProgressRingProps> = ({
  progress,
  size = 32,
  stroke = 4,
  className = '',
  status = 'idle',
  labelOverride = null,
}) => {
  const pct = Math.min(100, Math.max(0, progress));
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - pct / 100);
  const done = status === 'done';
  const parsing = status === 'parsing';
  const computing = status === 'computing';
  const error = status === 'error';
  const strokeColor = error
    ? '#dc2626'
    : parsing
      ? '#f59e0b'
      : computing
        ? '#6366f1'
      : done
        ? '#10b981'
        : '#3b82f6';
  const textColor = error
    ? '#b91c1c'
    : parsing
      ? '#b45309'
      : computing
        ? '#4338ca'
      : done
        ? '#047857'
        : '#1e40af';
  const displayText = labelOverride != null
    ? labelOverride
    : parsing
      ? '解析'
      : computing
        ? '计算'
      : `${pct}%`;
  return (
    <div className={`relative inline-flex items-center justify-center ${className}`} style={{ width: size, height: size }} aria-label={`上传进度 ${displayText}`}>
      <svg width={size} height={size} className="rotate-[-90deg]">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="transparent"
          stroke="#e2e8f0" // slate-200
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="transparent"
          stroke={strokeColor}
          strokeWidth={stroke}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 0.25s ease, stroke 0.3s ease' }}
        />
      </svg>
      <span className="absolute text-[10px] font-semibold select-none" style={{ color: textColor }}>
        {displayText}
      </span>
    </div>
  );
};

export default UploadProgressRing;