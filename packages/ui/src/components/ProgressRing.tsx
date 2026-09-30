import clsx from 'clsx';

export interface ProgressRingProps {
  value: number;
  size?: number;
  thickness?: number;
  className?: string;
}

export function ProgressRing({ value, size = 20, thickness = 2.5, className }: ProgressRingProps) {
  const clamped = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const center = size / 2;
  const percent = Math.round(clamped * 100);

  return (
    <svg
      className={clsx('inline-block shrink-0', className)}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={`${percent}%`}
    >
      <circle
        className="text-surface-3"
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={thickness}
      />
      <circle
        className="text-accent transition-[stroke-dashoffset] duration-300 ease-swift"
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={thickness}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - clamped)}
        transform={`rotate(-90 ${center} ${center})`}
      />
    </svg>
  );
}
