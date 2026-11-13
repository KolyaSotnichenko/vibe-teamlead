/**
 * Plays a strip of frames: the strip slides left by one frame per step. A timer does it,
 * one style change per frame, because a CSS animation (even `steps()`) makes the browser
 * work on every screen frame for as long as it runs: about 6% of a CPU core for a picture
 * that changes 2 to 5 times a second. No timer runs while the window is hidden, and none
 * at all for people who asked for reduced motion (they see the first frame).
 */

export interface StripClock {
  hidden(): boolean;
  reducedMotion(): boolean;
  /** Calls `fn` every `ms`; returns how to stop it */
  every(ms: number, fn: () => void): () => void;
  /** Calls `fn` when the window is hidden or shown; returns how to stop listening */
  onVisibility(fn: () => void): () => void;
}

const browserClock: StripClock = {
  hidden: () => document.hidden,
  reducedMotion: () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  every: (ms, fn) => {
    const timer = window.setInterval(fn, ms);
    return () => window.clearInterval(timer);
  },
  onVisibility: (fn) => {
    document.addEventListener('visibilitychange', fn);
    return () => document.removeEventListener('visibilitychange', fn);
  },
};

/** Starts playing; returns how to stop. The element is `frames` times as wide as one frame. */
export function playStrip(
  element: { style: { transform: string } },
  frames: number,
  frameMs: number,
  clock: StripClock = browserClock,
): () => void {
  let frame = 0;
  let stopTimer: (() => void) | undefined;
  const show = () => {
    element.style.transform = `translateX(${frame === 0 ? 0 : -(frame * 100) / frames}%)`;
  };
  show();
  if (frames <= 1 || clock.reducedMotion()) return () => undefined;

  const sync = () => {
    if (clock.hidden()) {
      stopTimer?.();
      stopTimer = undefined;
    } else if (!stopTimer) {
      stopTimer = clock.every(frameMs, () => {
        frame = (frame + 1) % frames;
        show();
      });
    }
  };
  const stopListening = clock.onVisibility(sync);
  sync();
  return () => {
    stopListening();
    stopTimer?.();
    stopTimer = undefined;
  };
}
