import clsx from 'clsx';
import type { Track } from '@ritmo/core';
import { useDominantColor } from '../hooks/useDominantColor';
import { Artwork } from './Artwork';

export interface NowPlayingArtProps {
  track?: Track;
  size: number;
  /** Adds the dominant-colour bloom behind the art. */
  glow?: boolean;
  className?: string;
}

export function NowPlayingArt({ track, size, glow = false, className }: NowPlayingArtProps) {
  const artwork = track?.artwork ?? track?.album?.artwork;
  const color = useDominantColor(artwork);

  return (
    <div className={clsx('relative shrink-0', className)} style={{ width: size, height: size }}>
      {glow && color ? (
        <div
          aria-hidden="true"
          // A blurred colour layer rather than a canvas: no per-frame cost and it
          // survives being scaled behind rounded artwork.
          className="absolute inset-0 scale-105 rounded-lg opacity-40 blur-[48px] saturate-[1.6]"
          style={{ backgroundColor: color }}
        />
      ) : null}
      <div className="relative">
        <Artwork
          {...(artwork ? { artwork } : {})}
          {...(track ? { name: track.title } : {})}
          size={size}
          rounded="lg"
          eager
          className="shadow-pop"
        />
      </div>
    </div>
  );
}
