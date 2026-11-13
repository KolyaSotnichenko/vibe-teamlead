/**
 * The pixel teamlead. The mood's frames are one SVG strip, slid one frame per
 * step by a timer (play-strip.ts): one style change per frame, no re-renders
 * while it plays, nothing while the window is hidden. Reduced motion shows the
 * first frame.
 */

import { useEffect, useRef } from 'react';

import { cn } from '../../../lib/utils';
import { playStrip } from './play-strip';
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
  const stripRef = useRef<SVGSVGElement>(null);
  // The svg is keyed by mood, so a new mood is a new element starting at its first frame
  useEffect(() => {
    const element = stripRef.current;
    if (!element) return;
    return playStrip(element, strip.frames, strip.durationMs / strip.frames);
  }, [strip]);
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
        ref={stripRef}
        aria-hidden
        className="vt-teamlead-strip block h-full"
        width={`${strip.frames * 100}%`}
        viewBox={`0 0 ${SPRITE_W * strip.frames} ${SPRITE_H}`}
        preserveAspectRatio="none"
        shapeRendering="crispEdges"
      >
        <path d={strip.paths.s} fill="var(--vt-text-muted-dark)" />
        <path d={strip.paths.b} fill="var(--vt-ground)" />
        <path d={strip.paths.d} fill="var(--vt-ink)" />
        <path d={strip.paths.x} fill="var(--vt-signal-on-dark)" />
      </svg>
    </button>
  );
}
