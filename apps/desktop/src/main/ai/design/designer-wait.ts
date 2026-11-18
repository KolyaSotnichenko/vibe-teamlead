/**
 * The designer's wait between tries (design-runner.ts `wait`), in the worker: the card and the
 * Design tab show it (execution progress `designWait`), a rate limit is waited out as the coder's
 * is (its pause file; a RESUME file ends it early), a passing error on a timer. The owner's Stop
 * waiting ends it with 'stop' (the design stops for the owner now); a stopped task with false.
 */

import type { DesignWait } from '../../../shared/types/task';
import type { DesignerWaitInfo } from './design-runner';

export interface DesignerWaiterDeps {
  /** The task's abort */
  signal: AbortSignal;
  /** The card's line: the wait, or null once the designer works again */
  progress: (wait: DesignWait | null) => void;
  /** Waits out a rate limit (pause file, RESUME); ends early when `signal` aborts */
  rateLimitWait: (ms: number, error: string, signal: AbortSignal) => Promise<unknown>;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

export function createDesignerWaiter(deps: DesignerWaiterDeps) {
  let stop: (() => void) | undefined;
  return {
    async wait(ms: number, kind: DesignWait['kind'], error: string, info: DesignerWaitInfo): Promise<boolean | 'stop'> {
      const local = new AbortController();
      let stopped = false;
      stop = () => {
        stopped = true;
        local.abort();
      };
      const onAbort = () => local.abort();
      deps.signal.addEventListener('abort', onAbort, { once: true });
      if (deps.signal.aborted) local.abort();
      deps.progress({ kind, until: new Date(info.until).toISOString(), attempt: info.attempt, of: info.of });
      try {
        if (kind === 'rate_limited') await deps.rateLimitWait(ms, error, local.signal);
        else await sleep(ms, local.signal);
      } finally {
        stop = undefined;
        deps.signal.removeEventListener('abort', onAbort);
      }
      if (stopped) return 'stop';
      return !deps.signal.aborted;
    },
    /** The owner's Stop waiting; false when the designer isn't waiting */
    stopWaiting(): boolean {
      if (!stop) return false;
      stop();
      return true;
    },
  };
}
