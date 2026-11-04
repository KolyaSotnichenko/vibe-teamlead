/**
 * The pixel teamlead. The mood's frames are one SVG strip slid by a CSS
 * steps() animation: no timers, no re-renders while it plays. Reduced motion
 * shows the first frame.
 */

import { cn } from '../../../lib/utils';
import { moodStrip, SPRITE_H, SPRITE_W, type TeamleadMood } from './sprite';

const SCALE = 5;

export function Teamlead({
  mood,
  label,
  onClick,
  className,
}: {
  mood: TeamleadMood;
  label: string;
  onClick?: () => void;
  className?: string;
}) {
  const strip = moodStrip(mood);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      data-mood={mood}
      className={cn('vt-teamlead block shrink-0 overflow-hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--vt-signal-on-dark)]', className)}
      style={{ width: SPRITE_W * SCALE, height: SPRITE_H * SCALE }}
    >
      <svg
        key={mood}
        aria-hidden
        className="vt-teamlead-strip block h-full"
        width={`${strip.frames * 100}%`}
        viewBox={`0 0 ${SPRITE_W * strip.frames} ${SPRITE_H}`}
        preserveAspectRatio="none"
        shapeRendering="crispEdges"
        style={{ animation: `vt-teamlead-play ${strip.durationMs}ms steps(${strip.frames}) infinite` }}
      >
        <path d={strip.paths.s} fill="var(--vt-text-muted-dark)" />
        <path d={strip.paths.b} fill="var(--vt-ground)" />
        <path d={strip.paths.d} fill="var(--vt-ink)" />
        <path d={strip.paths.x} fill="var(--vt-signal-on-dark)" />
      </svg>
    </button>
  );
}
