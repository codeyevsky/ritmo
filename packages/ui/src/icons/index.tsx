import clsx from 'clsx';
import type { ComponentType, ReactNode } from 'react';

export interface IconProps {
  className?: string;
}

export type IconComponent = ComponentType<IconProps>;

/**
 * Icons default to `1em` so they inherit the control's font-size; a `h-*`/`w-*`
 * class always wins over the presentation attribute when one is given.
 */
const BASE = 'inline-block shrink-0';

function Outline({
  className,
  children,
  sw = 1.8,
}: IconProps & { children: ReactNode; sw?: number }) {
  return (
    <svg
      className={clsx(BASE, className)}
      width="1em"
      height="1em"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

function Solid({ className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      className={clsx(BASE, className)}
      width="1em"
      height="1em"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/* ── navigation ─────────────────────────────────────────────────────────── */

export function Home({ className }: IconProps) {
  return (
    <Outline className={className}>
      <path d="M3.5 10.4 12 3.6l8.5 6.8V19a1.5 1.5 0 0 1-1.5 1.5h-3.75V15h-4.5v5.5H5A1.5 1.5 0 0 1 3.5 19z" />
    </Outline>
  );
}

export function HomeFilled({ className }: IconProps) {
  return (
    <Solid className={className}>
      <path d="M11.37 2.82a1 1 0 0 1 1.26 0l8.5 6.8a1 1 0 0 1 .37.78V19a2.5 2.5 0 0 1-2.5 2.5h-3.75a1 1 0 0 1-1-1V16h-2.5v4.5a1 1 0 0 1-1 1H7A2.5 2.5 0 0 1 4.5 19v-8.6a1 1 0 0 1 .37-.78z" />
    </Solid>
  );
}

export function Search({ className }: IconProps) {
  return (
    <Outline className={className}>
      <circle cx="10.5" cy="10.5" r="6.75" />
      <path d="m15.6 15.6 4.9 4.9" />
    </Outline>
  );
}

export function SearchFilled({ className }: IconProps) {
  return (
    <Solid className={className}>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M10.5 2.4a8.1 8.1 0 1 0 0 16.2 8.1 8.1 0 0 0 0-16.2m0 2.6a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11"
      />
      <path d="M15.6 15.6a1.15 1.15 0 0 1 1.63 0l4.1 4.1a1.15 1.15 0 0 1-1.63 1.63l-4.1-4.1a1.15 1.15 0 0 1 0-1.63" />
    </Solid>
  );
}

export function Library({ className }: IconProps) {
  return (
    <Outline className={className}>
      <rect x="3.25" y="4" width="4" height="16" rx="1.3" />
      <rect x="9" y="4" width="4" height="16" rx="1.3" />
      <rect x="14.7" y="4.6" width="4" height="15" rx="1.3" transform="rotate(13 16.7 12.1)" />
    </Outline>
  );
}

export function LibraryFilled({ className }: IconProps) {
  return (
    <Solid className={className}>
      <rect x="3.25" y="4" width="4" height="16" rx="1.3" />
      <rect x="9" y="4" width="4" height="16" rx="1.3" />
      <rect x="14.7" y="4.6" width="4" height="15" rx="1.3" transform="rotate(13 16.7 12.1)" />
    </Solid>
  );
}

export function Radio({ className }: IconProps) {
  return (
    <Outline className={className}>
      <circle cx="12" cy="12" r="2.1" fill="currentColor" stroke="none" />
      <path d="M8.6 15.4a4.8 4.8 0 0 1 0-6.8" />
      <path d="M15.4 8.6a4.8 4.8 0 0 1 0 6.8" />
      <path d="M5.7 18.3a8.9 8.9 0 0 1 0-12.6" />
      <path d="M18.3 5.7a8.9 8.9 0 0 1 0 12.6" />
    </Outline>
  );
}

export function Settings({ className }: IconProps) {
  return (
    <Outline className={className}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.2 14.9a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.55V21a2 2 0 1 1-4 0v-.11a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1.03H3a2 2 0 1 1 0-4h.11A1.7 1.7 0 0 0 4.66 8.8a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9.1a1.7 1.7 0 0 0 1.03-1.55V3a2 2 0 1 1 4 0v.11a1.7 1.7 0 0 0 1.03 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.11a1.7 1.7 0 0 0 1.55 1.03H21a2 2 0 1 1 0 4h-.11a1.7 1.7 0 0 0-1.55 1.03z" />
    </Outline>
  );
}

/* ── transport ──────────────────────────────────────────────────────────── */

export function Play({ className }: IconProps) {
  return (
    <Solid className={className}>
      <path d="M8.5 5v14l11-7z" />
    </Solid>
  );
}

export function Pause({ className }: IconProps) {
  return (
    <Solid className={className}>
      <rect x="6.6" y="4.6" width="3.8" height="14.8" rx="1.2" />
      <rect x="13.6" y="4.6" width="3.8" height="14.8" rx="1.2" />
    </Solid>
  );
}

export function SkipNext({ className }: IconProps) {
  return (
    <Solid className={className}>
      <path d="M6.5 5.4v13.2L16.4 12z" />
      <rect x="17" y="5" width="2.7" height="14" rx="1.15" />
    </Solid>
  );
}

export function SkipPrevious({ className }: IconProps) {
  return (
    <Solid className={className}>
      <path d="M17.5 5.4v13.2L7.6 12z" />
      <rect x="4.3" y="5" width="2.7" height="14" rx="1.15" />
    </Solid>
  );
}

export function Shuffle({ className }: IconProps) {
  return (
    <Outline className={className}>
      <path d="M16.5 3.5H21V8" />
      <path d="M3 21 21 3.6" />
      <path d="M21 16v5h-4.5" />
      <path d="m14.6 14.6 6.4 6.4" />
      <path d="m3 3.6 5.6 5.6" />
    </Outline>
  );
}

export function Repeat({ className }: IconProps) {
  return (
    <Outline className={className}>
      <path d="m16.8 2.7 3.5 3.5-3.5 3.5" />
      <path d="M20.3 6.2H7.6A3.6 3.6 0 0 0 4 9.8v1.9" />
      <path d="M7.2 21.3l-3.5-3.5 3.5-3.5" />
      <path d="M3.7 17.8h12.7a3.6 3.6 0 0 0 3.6-3.6v-1.9" />
    </Outline>
  );
}

export function RepeatOne({ className }: IconProps) {
  return (
    <Outline className={className}>
      <path d="m16.8 2.7 3.5 3.5-3.5 3.5" />
      <path d="M20.3 6.2H7.6A3.6 3.6 0 0 0 4 9.8v1.9" />
      <path d="M7.2 21.3l-3.5-3.5 3.5-3.5" />
      <path d="M3.7 17.8h12.7a3.6 3.6 0 0 0 3.6-3.6v-1.9" />
      <path d="m10.7 10.9 1.9-1.2v5.2" strokeWidth={1.6} />
    </Outline>
  );
}

export function VolumeHigh({ className }: IconProps) {
  return (
    <Outline className={className}>
      <path d="M11.4 4.9 7 8.9H4.2a1 1 0 0 0-1 1v4.2a1 1 0 0 0 1 1H7l4.4 4a.8.8 0 0 0 1.35-.6V5.5a.8.8 0 0 0-1.35-.6z" />
      <path d="M16.2 9a4.4 4.4 0 0 1 0 6" />
      <path d="M19 6.3a8 8 0 0 1 0 11.4" />
    </Outline>
  );
}

export function VolumeLow({ className }: IconProps) {
  return (
    <Outline className={className}>
      <path d="M11.4 4.9 7 8.9H4.2a1 1 0 0 0-1 1v4.2a1 1 0 0 0 1 1H7l4.4 4a.8.8 0 0 0 1.35-.6V5.5a.8.8 0 0 0-1.35-.6z" />
      <path d="M16.2 9a4.4 4.4 0 0 1 0 6" />
    </Outline>
  );
}

export function VolumeMute({ className }: IconProps) {
  return (
    <Outline className={className}>
      <path d="M11.4 4.9 7 8.9H4.2a1 1 0 0 0-1 1v4.2a1 1 0 0 0 1 1H7l4.4 4a.8.8 0 0 0 1.35-.6V5.5a.8.8 0 0 0-1.35-.6z" />
      <path d="m16.2 9.6 5 4.8" />
      <path d="m21.2 9.6-5 4.8" />
    </Outline>
  );
}

/* ── actions ────────────────────────────────────────────────────────────── */

export function Heart({ className }: IconProps) {
  return (
    <Outline className={className}>
      <path d="M19 13.9c1.5-1.46 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.4c0 2.3 1.5 4.04 3 5.5l7 7z" />
    </Outline>
  );
}

export function HeartFilled({ className }: IconProps) {
  return (
    <Solid className={className}>
      <path d="M19 13.9c1.5-1.46 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.4c0 2.3 1.5 4.04 3 5.5l7 7z" />
    </Solid>
  );
}

export function Plus({ className }: IconProps) {
  return (
    <Outline className={className}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </Outline>
  );
}

export function PlusCircle({ className }: IconProps) {
  return (
    <Outline className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8.2v7.6" />
      <path d="M8.2 12h7.6" />
    </Outline>
  );
}

export function Check({ className }: IconProps) {
  return (
    <Outline className={className}>
      <path d="m4.8 12.6 4.9 4.9L19.4 7.1" />
    </Outline>
  );
}

export function CheckCircle({ className }: IconProps) {
  return (
    <Outline className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.1 12.3 2.7 2.7 5.4-5.6" />
    </Outline>
  );
}

export function Close({ className }: IconProps) {
  return (
    <Outline className={className}>
      <path d="m5.8 5.8 12.4 12.4" />
      <path d="m18.2 5.8-12.4 12.4" />
    </Outline>
  );
}

export function ChevronLeft({ className }: IconProps) {
  return (
    <Outline className={className} sw={2}>
      <path d="M15 5.5 8.5 12l6.5 6.5" />
    </Outline>
  );
}

export function ChevronRight({ className }: IconProps) {
  return (
    <Outline className={className} sw={2}>
      <path d="M9 5.5 15.5 12 9 18.5" />
    </Outline>
  );
}

export function ChevronDown({ className }: IconProps) {
  return (
    <Outline className={className} sw={2}>
      <path d="M5.5 9 12 15.5 18.5 9" />
    </Outline>
  );
}

export function ChevronUp({ className }: IconProps) {
  return (
    <Outline className={className} sw={2}>
      <path d="M5.5 15 12 8.5 18.5 15" />
    </Outline>
  );
}

export function MoreHorizontal({ className }: IconProps) {
  return (
    <Solid className={className}>
      <circle cx="5.4" cy="12" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="18.6" cy="12" r="1.7" />
    </Solid>
  );
}

export function MoreVertical({ className }: IconProps) {
  return (
    <Solid className={className}>
      <circle cx="12" cy="5.4" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="12" cy="18.6" r="1.7" />
    </Solid>
  );
}

/* ── panels ─────────────────────────────────────────────────────────────── */

export function Queue({ className }: IconProps) {
  return (
    <Outline className={className}>
      <path d="M3.5 6.5h13" />
      <path d="M3.5 11.5h13" />
      <path d="M3.5 16.5h7.5" />
      <path d="M15.4 13.6v6l5.1-3z" fill="currentColor" stroke="none" />
    </Outline>
  );
}

export function Lyrics({ className }: IconProps) {
  return (
    <Outline className={className}>
      <path d="M5 4.5h14A1.5 1.5 0 0 1 20.5 6v9a1.5 1.5 0 0 1-1.5 1.5h-7L7.5 20v-3.5H5A1.5 1.5 0 0 1 3.5 15V6A1.5 1.5 0 0 1 5 4.5z" />
      <path d="M7.2 9h9.6" />
      <path d="M7.2 12.4h5.8" />
    </Outline>
  );
}

export function Fullscreen({ className }: IconProps) {
  return (
    <Outline className={className}>
      <path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9" />
      <path d="M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9" />
      <path d="M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15" />
      <path d="M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15" />
    </Outline>
  );
}

export function FullscreenExit({ className }: IconProps) {
  return (
    <Outline className={className}>
      <path d="M9 4v3.5A1.5 1.5 0 0 1 7.5 9H4" />
      <path d="M20 9h-3.5A1.5 1.5 0 0 1 15 7.5V4" />
      <path d="M15 20v-3.5a1.5 1.5 0 0 1 1.5-1.5H20" />
      <path d="M4 15h3.5A1.5 1.5 0 0 1 9 16.5V20" />
    </Outline>
  );
}

/* ── offline & storage ──────────────────────────────────────────────────── */

export function Download({ className }: IconProps) {
  return (
    <Outline className={className}>
      <path d="M12 3.5v11.6" />
      <path d="m7.4 10.6 4.6 4.5 4.6-4.5" />
      <path d="M4.5 19.5h15" />
    </Outline>
  );
}

export function Downloaded({ className }: IconProps) {
  return (
    <Solid className={className}>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 2.5a9.5 9.5 0 1 0 0 19 9.5 9.5 0 0 0 0-19m4.44 6.9a1.05 1.05 0 0 0-1.49-.06l-4.24 4.02-1.63-1.6a1.05 1.05 0 0 0-1.47 1.5l2.35 2.31a1.05 1.05 0 0 0 1.46.01l4.97-4.7a1.05 1.05 0 0 0 .05-1.48"
      />
    </Solid>
  );
}

export function Folder({ className }: IconProps) {
  return (
    <Outline className={className}>
      <path d="M3.5 7.6A1.6 1.6 0 0 1 5.1 6h3.6a1.6 1.6 0 0 1 1.13.47l1.27 1.26H19a1.5 1.5 0 0 1 1.5 1.5v8.27A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z" />
    </Outline>
  );
}

export function FolderPlus({ className }: IconProps) {
  return (
    <Outline className={className}>
      <path d="M3.5 7.6A1.6 1.6 0 0 1 5.1 6h3.6a1.6 1.6 0 0 1 1.13.47l1.27 1.26H19a1.5 1.5 0 0 1 1.5 1.5v8.27A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z" />
      <path d="M12 11.3v4.6" />
      <path d="M9.7 13.6h4.6" />
    </Outline>
  );
}

export function HardDrive({ className }: IconProps) {
  return (
    <Outline className={className}>
      <rect x="2.5" y="12.6" width="19" height="6.9" rx="2" />
      <path d="M5.4 12.6 7.7 5.7A1.6 1.6 0 0 1 9.2 4.6h5.6a1.6 1.6 0 0 1 1.5 1.1l2.3 6.9" />
      <circle cx="17.6" cy="16" r="1.1" fill="currentColor" stroke="none" />
      <path d="M6.5 16h5.5" />
    </Outline>
  );
}

export function Trash({ className }: IconProps) {
  return (
    <Outline className={className}>
      <path d="M4.5 7h15" />
      <path d="M9.5 7V5.3A1.3 1.3 0 0 1 10.8 4h2.4a1.3 1.3 0 0 1 1.3 1.3V7" />
      <path d="m6.6 7 .77 11.9A1.5 1.5 0 0 0 8.87 20.3h6.26a1.5 1.5 0 0 0 1.5-1.4L17.4 7" />
      <path d="M10.4 11v5.5" />
      <path d="M13.6 11v5.5" />
    </Outline>
  );
}

export function Edit({ className }: IconProps) {
  return (
    <Outline className={className}>
      <path d="M12.5 20.5H21" />
      <path d="M16.6 3.6a2.13 2.13 0 0 1 3 3L7 19.2l-4 1 1-4z" />
    </Outline>
  );
}

export function Copy({ className }: IconProps) {
  return (
    <Outline className={className}>
      <rect x="9" y="9" width="11.5" height="11.5" rx="2" />
      <path d="M6.4 15H5.5A2 2 0 0 1 3.5 13V5.5A2 2 0 0 1 5.5 3.5H13a2 2 0 0 1 2 2v.9" />
    </Outline>
  );
}

export function Share({ className }: IconProps) {
  return (
    <Outline className={className}>
      <path d="M12 3.4v11.2" />
      <path d="m8 7.4 4-4 4 4" />
      <path d="M6.4 12.6H5.2A1.7 1.7 0 0 0 3.5 14.3v4.6a1.7 1.7 0 0 0 1.7 1.7h13.6a1.7 1.7 0 0 0 1.7-1.7v-4.6a1.7 1.7 0 0 0-1.7-1.7h-1.2" />
    </Outline>
  );
}

/* ── metadata ───────────────────────────────────────────────────────────── */

export function Clock({ className }: IconProps) {
  return (
    <Outline className={className}>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 7.3V12l3.3 2" />
    </Outline>
  );
}

export function Disc({ className }: IconProps) {
  return (
    <Outline className={className}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="2.6" />
      <path d="M12 3a9 9 0 0 1 8.3 5.5" strokeWidth={1.4} />
    </Outline>
  );
}

export function Mic({ className }: IconProps) {
  return (
    <Outline className={className}>
      <path d="M12 3.3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0v-5a3 3 0 0 1 3-3z" />
      <path d="M5.6 11.3a6.4 6.4 0 0 0 12.8 0" />
      <path d="M12 17.8v3" />
      <path d="M8.6 20.8h6.8" />
    </Outline>
  );
}

export function Users({ className }: IconProps) {
  return (
    <Outline className={className}>
      <path d="M15.6 20.5v-1.7a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1.7" />
      <circle cx="9.3" cy="7.4" r="3.6" />
      <path d="M16.6 4.1a3.6 3.6 0 0 1 0 6.6" />
      <path d="M18 14.9a4 4 0 0 1 3 3.9v1.7" />
    </Outline>
  );
}

export function Music({ className }: IconProps) {
  return (
    <Outline className={className}>
      <circle cx="6.6" cy="17.4" r="3.1" />
      <circle cx="17.9" cy="15.4" r="3.1" />
      <path d="M9.7 17.4V6.6L21 4.4v11" />
    </Outline>
  );
}

export function Star({ className }: IconProps) {
  return (
    <Outline className={className}>
      <path d="m12 3 2.85 5.9 6.45.94-4.65 4.6 1.1 6.46L12 17.86l-5.75 3.04 1.1-6.46L2.7 9.84l6.45-.94z" />
    </Outline>
  );
}

export function Equalizer({ className }: IconProps) {
  return (
    <Outline className={className}>
      <path d="M5 20V9.5" />
      <path d="M12 20V4" />
      <path d="M19 20v-6.5" />
      <path d="M2.8 9.5h4.4" />
      <path d="M9.8 4h4.4" />
      <path d="M16.8 13.5h4.4" />
    </Outline>
  );
}

export function Sliders({ className }: IconProps) {
  return (
    <Outline className={className}>
      <path d="M3.5 7.6h9" />
      <path d="M18.5 7.6h2" />
      <circle cx="15.5" cy="7.6" r="2.4" />
      <path d="M3.5 16.4h4" />
      <path d="M13.5 16.4h7" />
      <circle cx="10.5" cy="16.4" r="2.4" />
    </Outline>
  );
}

export function Sparkles({ className }: IconProps) {
  return (
    <Outline className={className}>
      <path d="M10.5 3.2 12.2 8l4.8 1.7-4.8 1.7-1.7 4.8-1.7-4.8L3.9 9.7 8.8 8z" />
      <path d="M18.2 14.6l.86 2.34 2.34.86-2.34.86-.86 2.34-.86-2.34-2.34-.86 2.34-.86z" />
    </Outline>
  );
}

export function Filter({ className }: IconProps) {
  return (
    <Outline className={className}>
      <path d="M3.6 5.5h16.8l-6.7 8v5.9l-3.4 1.6v-7.5z" />
    </Outline>
  );
}

export function Sort({ className }: IconProps) {
  return (
    <Outline className={className}>
      <path d="M3.5 6.5h9" />
      <path d="M3.5 12h6" />
      <path d="M3.5 17.5h3.5" />
      <path d="M17.5 5.8v12.4" />
      <path d="m14.4 15.1 3.1 3.1 3.1-3.1" />
    </Outline>
  );
}

export function Grid({ className }: IconProps) {
  return (
    <Outline className={className}>
      <rect x="3.5" y="3.5" width="7.4" height="7.4" rx="1.6" />
      <rect x="13.1" y="3.5" width="7.4" height="7.4" rx="1.6" />
      <rect x="3.5" y="13.1" width="7.4" height="7.4" rx="1.6" />
      <rect x="13.1" y="13.1" width="7.4" height="7.4" rx="1.6" />
    </Outline>
  );
}

export function List({ className }: IconProps) {
  return (
    <Outline className={className}>
      <path d="M8.5 6.5h12" />
      <path d="M8.5 12h12" />
      <path d="M8.5 17.5h12" />
      <circle cx="4.4" cy="6.5" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="4.4" cy="12" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="4.4" cy="17.5" r="1.15" fill="currentColor" stroke="none" />
    </Outline>
  );
}

export function GripVertical({ className }: IconProps) {
  return (
    <Solid className={className}>
      <circle cx="9" cy="6.6" r="1.4" />
      <circle cx="15" cy="6.6" r="1.4" />
      <circle cx="9" cy="12" r="1.4" />
      <circle cx="15" cy="12" r="1.4" />
      <circle cx="9" cy="17.4" r="1.4" />
      <circle cx="15" cy="17.4" r="1.4" />
    </Solid>
  );
}

export function ArrowRight({ className }: IconProps) {
  return (
    <Outline className={className}>
      <path d="M4 12h14.6" />
      <path d="m13.2 6.6 5.4 5.4-5.4 5.4" />
    </Outline>
  );
}

/* ── network & status ───────────────────────────────────────────────────── */

export function Wifi({ className }: IconProps) {
  return (
    <Outline className={className}>
      <path d="M2.6 8.6a14 14 0 0 1 18.8 0" />
      <path d="M6 12.2a9.2 9.2 0 0 1 12 0" />
      <path d="M9.4 15.8a4.5 4.5 0 0 1 5.2 0" />
      <circle cx="12" cy="19.3" r="1.2" fill="currentColor" stroke="none" />
    </Outline>
  );
}

export function WifiOff({ className }: IconProps) {
  return (
    <Outline className={className}>
      <path d="M2.6 8.6a14 14 0 0 1 5.3-3.3" />
      <path d="M14.6 5.6a14 14 0 0 1 6.8 3" />
      <path d="M6 12.2a9.2 9.2 0 0 1 3.6-2.2" />
      <path d="M17.2 11.3a9.2 9.2 0 0 1 .8.9" />
      <path d="M9.4 15.8a4.5 4.5 0 0 1 3.5-.4" />
      <circle cx="12" cy="19.3" r="1.2" fill="currentColor" stroke="none" />
      <path d="m3.2 3.2 17.6 17.6" />
    </Outline>
  );
}

export function Refresh({ className }: IconProps) {
  return (
    <Outline className={className}>
      <path d="M20.4 11.6A8.4 8.4 0 1 1 17.7 5.6" />
      <path d="M17.9 2.4v3.9H14" />
    </Outline>
  );
}

export function ExternalLink({ className }: IconProps) {
  return (
    <Outline className={className}>
      <path d="M14 4h6v6" />
      <path d="M20 4 11 13" />
      <path d="M18.5 14v4.5A1.5 1.5 0 0 1 17 20H5.9A1.5 1.5 0 0 1 4.4 18.5V7.4A1.5 1.5 0 0 1 5.9 5.9H10.4" />
    </Outline>
  );
}

export function Link({ className }: IconProps) {
  return (
    <Outline className={className}>
      <path d="m9.4 14.6 5.2-5.2" />
      <path d="M10.8 7.2 12.9 5a4.3 4.3 0 0 1 6.1 6.1l-2.2 2.2" />
      <path d="M13.2 16.8 11 19a4.3 4.3 0 0 1-6.1-6.1l2.2-2.2" />
    </Outline>
  );
}

export function Unlink({ className }: IconProps) {
  return (
    <Outline className={className}>
      <path d="M10.8 7.2 12.9 5a4.3 4.3 0 0 1 6.1 6.1l-2.2 2.2" />
      <path d="M13.2 16.8 11 19a4.3 4.3 0 0 1-6.1-6.1l2.2-2.2" />
      <path d="m3.4 3.4 17.2 17.2" />
    </Outline>
  );
}

export function Globe({ className }: IconProps) {
  return (
    <Outline className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3.3 9.5h17.4" />
      <path d="M3.3 14.5h17.4" />
      <path d="M12 3.1c-2.5 2.5-3.8 5.5-3.8 8.9s1.3 6.4 3.8 8.9" />
      <path d="M12 3.1c2.5 2.5 3.8 5.5 3.8 8.9s-1.3 6.4-3.8 8.9" />
    </Outline>
  );
}

export function Cpu({ className }: IconProps) {
  return (
    <Outline className={className}>
      <rect x="4.6" y="4.6" width="14.8" height="14.8" rx="2.6" />
      <rect x="9" y="9" width="6" height="6" rx="1.2" />
      <path d="M9 2.4v2.2" />
      <path d="M15 2.4v2.2" />
      <path d="M9 19.4v2.2" />
      <path d="M15 19.4v2.2" />
      <path d="M2.4 9h2.2" />
      <path d="M2.4 15h2.2" />
      <path d="M19.4 9h2.2" />
      <path d="M19.4 15h2.2" />
    </Outline>
  );
}

export function Palette({ className }: IconProps) {
  return (
    <Outline className={className}>
      <path d="M12 3.4a8.6 8.6 0 0 0 0 17.2c1.24 0 1.9-.9 1.9-1.95s-.72-1.95-1.9-1.95h-.6a2.05 2.05 0 0 1 0-4.1H18a2.6 2.6 0 0 0 2.6-2.6C20.6 6.4 16.75 3.4 12 3.4z" />
      <circle cx="8" cy="8.4" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="12.4" cy="7.1" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="16.6" cy="8.9" r="1.15" fill="currentColor" stroke="none" />
    </Outline>
  );
}

export function Info({ className }: IconProps) {
  return (
    <Outline className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.6" />
      <circle cx="12" cy="7.9" r="1.1" fill="currentColor" stroke="none" />
    </Outline>
  );
}

export function Warning({ className }: IconProps) {
  return (
    <Outline className={className}>
      <path d="M10.7 4.6a1.5 1.5 0 0 1 2.6 0l7.6 13.4a1.5 1.5 0 0 1-1.3 2.25H4.4A1.5 1.5 0 0 1 3.1 18z" />
      <path d="M12 9.4v4.3" />
      <circle cx="12" cy="17" r="1.05" fill="currentColor" stroke="none" />
    </Outline>
  );
}

export function Error({ className }: IconProps) {
  return (
    <Outline className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="m9.1 9.1 5.8 5.8" />
      <path d="m14.9 9.1-5.8 5.8" />
    </Outline>
  );
}

/* ── window & keys ──────────────────────────────────────────────────────── */

export function Minimize({ className }: IconProps) {
  return (
    <Outline className={className} sw={1.6}>
      <path d="M5.5 12h13" />
    </Outline>
  );
}

export function Maximize({ className }: IconProps) {
  return (
    <Outline className={className} sw={1.6}>
      <rect x="5.5" y="5.5" width="13" height="13" rx="1.6" />
    </Outline>
  );
}

export function Restore({ className }: IconProps) {
  return (
    <Outline className={className} sw={1.6}>
      <rect x="4.2" y="8.2" width="11.6" height="11.6" rx="1.6" />
      <path d="M8.4 8.2V6.2A1.9 1.9 0 0 1 10.3 4.3h7.6a1.9 1.9 0 0 1 1.9 1.9v7.6a1.9 1.9 0 0 1-1.9 1.9h-2" />
    </Outline>
  );
}

export function Windows({ className }: IconProps) {
  return (
    <Solid className={className}>
      <path d="M3 4.8 11.1 3.7v8.05H3z" />
      <path d="M12.4 3.5 21 2.3v9.45h-8.6z" />
      <path d="M3 13.05h8.1v8.05L3 19.95z" />
      <path d="M12.4 13.05H21v9.45l-8.6-1.2z" />
    </Solid>
  );
}

export function Command({ className }: IconProps) {
  return (
    <Outline className={className}>
      <path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z" />
    </Outline>
  );
}

export function Keyboard({ className }: IconProps) {
  return (
    <Outline className={className}>
      <rect x="2.4" y="6" width="19.2" height="12" rx="2.4" />
      <path d="M6.2 10h1.1" />
      <path d="M9.9 10H11" />
      <path d="M13.6 10h1.1" />
      <path d="M17.3 10h.5" />
      <path d="M8.2 14.2h7.6" />
    </Outline>
  );
}

/* ── app mark ───────────────────────────────────────────────────────────── */

/** The five equalizer bars from assets/logo.svg, scaled from 512 to 24. */
export function Ritmo({ className }: IconProps) {
  return (
    <Solid className={className}>
      <g transform="scale(0.046875)">
        <rect x="112" y="208" width="42" height="96" rx="21" />
        <rect x="178" y="152" width="42" height="208" rx="21" />
        <rect x="244" y="110" width="42" height="292" rx="21" />
        <rect x="310" y="152" width="42" height="208" rx="21" />
        <rect x="376" y="208" width="42" height="96" rx="21" />
      </g>
    </Solid>
  );
}

/** Sidebar collapse control in the title bar. */
export function PanelLeft({ className }: IconProps) {
  return (
    <Outline className={className}>
      <rect x="3" y="4.5" width="18" height="15" rx="2.4" />
      <path d="M9.4 4.5v15" />
    </Outline>
  );
}

/** A pack: a box with a lid seam, not a stack of records. */
export function Package({ className }: IconProps) {
  return (
    <Outline className={className}>
      <path d="M3.6 7.7 12 3.5l8.4 4.2v8.6L12 20.5 3.6 16.3z" />
      <path d="M3.6 7.7 12 11.9l8.4-4.2M12 11.9v8.6" />
    </Outline>
  );
}

/** The Bazaar: a market stall's awning over an open front. */
export function Storefront({ className }: IconProps) {
  return (
    <Outline className={className}>
      <path d="M3.2 9.2 5.2 4h13.6l2 5.2z" />
      <path d="M4.6 9.2V19a1.4 1.4 0 0 0 1.4 1.4h12a1.4 1.4 0 0 0 1.4-1.4V9.2" />
      <path d="M9.4 20.4v-4.9h5.2v4.9" />
    </Outline>
  );
}

/* ── aliases ────────────────────────────────────────────────────────────────
   The shell modules reach for an `Icon*` prefix. Aliasing here keeps one set
   of drawings instead of a second, drifting copy of the same geometry. */

export {
  ChevronDown as IconChevronDown,
  ChevronLeft as IconChevronLeft,
  ChevronRight as IconChevronRight,
  ChevronUp as IconChevronUp,
  Close as IconClose,
  Copy as IconCopy,
  Download as IconDownload,
  Edit as IconEdit,
  Filter as IconFilter,
  Fullscreen as IconFullscreen,
  GripVertical as IconGrip,
  Heart as IconHeart,
  HeartFilled as IconHeartFilled,
  Home as IconHome,
  Library as IconLibrary,
  Lyrics as IconLyrics,
  Maximize as IconMaximize,
  Minimize as IconMinimize,
  Music as IconMusic,
  Package as IconPackage,
  PanelLeft as IconPanelLeft,
  Pause as IconPause,
  Play as IconPlay,
  Plus as IconPlus,
  Queue as IconQueue,
  Radio as IconRadio,
  Repeat as IconRepeat,
  RepeatOne as IconRepeatOne,
  Restore as IconRestore,
  Ritmo as IconLogo,
  Search as IconSearch,
  Settings as IconSettings,
  Storefront as IconBazaar,
  Shuffle as IconShuffle,
  SkipNext as IconNext,
  SkipPrevious as IconPrevious,
  Trash as IconTrash,
};
