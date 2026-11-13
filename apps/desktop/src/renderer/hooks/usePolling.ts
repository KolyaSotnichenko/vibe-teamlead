import { useEffect, useRef } from 'react';

/**
 * Calls `tick` every `intervalMs` while `enabled` and the window is visible.
 *
 * - Nothing runs while the window is hidden; when it shows again `tick` runs once at once,
 *   so what changed meanwhile is fetched without waiting for the next interval.
 * - A `tick` that returns a promise is not started again until that promise settles.
 * - The first call is the caller's own (usually together with resetting its state).
 * - `tick` may change on every render: the newest one is called, the timer is not restarted.
 */
export function usePolling(tick: () => unknown, intervalMs: number, enabled = true): void {
  const latest = useRef(tick);
  latest.current = tick;

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    let running = false;
    let stopped = false;

    const run = () => {
      if (running || stopped) return;
      const result = latest.current();
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        running = true;
        const done = () => { running = false; };
        (result as PromiseLike<unknown>).then(done, done);
      }
    };
    const sync = (showsAgain: boolean) => {
      if (document.visibilityState === 'hidden') {
        if (timer) clearInterval(timer);
        timer = undefined;
        return;
      }
      if (!timer) {
        timer = setInterval(run, intervalMs);
        if (showsAgain) run();
      }
    };
    const onVisibility = () => sync(true);

    sync(false);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVisibility);
      if (timer) clearInterval(timer);
    };
  }, [intervalMs, enabled]);
}
