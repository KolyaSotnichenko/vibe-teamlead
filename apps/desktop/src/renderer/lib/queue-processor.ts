/**
 * Starting queued tasks: the oldest one that may start, while a slot under the project's
 * parallel-task limit is free and the queue isn't paused (the Telegram bot's /stop_all). One run
 * at a time, so a task is never started twice; a call during a run makes the run look again, so
 * a limit raised or a slot freed meanwhile isn't missed. No React: the app-level hook drives it.
 */
import type { Task } from '../../shared/types';
import { debugLog } from '../../shared/utils/debug-logger';
import { nextQueuedToStart } from './task-dependencies';

export interface QueueProcessorDeps {
  getTasks: () => readonly Task[];
  /** The project's parallel-task limit, read at each step */
  limit: () => number;
  paused: () => boolean;
  /** Moves a queued task to In Progress */
  promote: (taskId: string) => Promise<{ success: boolean; staleCiTask?: boolean; error?: string }>;
  /** A task of the CI check whose reason is gone: main put it back in Planning */
  onStaleCiTask: (task: Task) => void;
}

/** Safety limit: a run stops after this many failures in a row */
const MAX_CONSECUTIVE_FAILURES = 10;

export function createQueueProcessor(deps: QueueProcessorDeps): { process: () => Promise<void> } {
  let running = false;
  let again = false;

  const runOnce = async () => {
    // Tasks that failed to start this round, so they aren't tried forever
    const attempted = new Set<string>();
    let failures = 0;
    while (!deps.paused() && failures < MAX_CONSECUTIVE_FAILURES) {
      const next = nextQueuedToStart(deps.getTasks(), deps.limit(), attempted);
      if (!next) break;
      debugLog(`[Queue] Starting queued task ${next.id} (limit ${deps.limit()})`);
      const result = await deps.promote(next.id);
      if (result.success) {
        failures = 0;
      } else if (result.staleCiTask) {
        attempted.add(next.id);
        deps.onStaleCiTask(next);
      } else {
        console.error(`[Queue] Failed to start task ${next.id}:`, result.error);
        attempted.add(next.id);
        failures++;
      }
    }
  };

  return {
    process: async () => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        do {
          again = false;
          await runOnce();
        } while (again);
      } finally {
        running = false;
      }
    },
  };
}
