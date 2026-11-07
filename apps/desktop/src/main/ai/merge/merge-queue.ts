/**
 * One merge at a time per project. Each task then integrates with the main branch
 * as the task before it left it, however many were asked to merge at once. Lives
 * in memory: a queue doesn't survive a restart, and neither do the waiting calls.
 */

const tails = new Map<string, Promise<unknown>>();
const waiting = new Map<string, number>();
const queued = new Set<string>();

/** Whether this task is merging or waiting to. */
const settledListeners = new Set<(projectDir: string) => void>();

/** Hear when a merge of a project finished, whether it succeeded or not. Returns the unsubscribe. */
export function onMergeSettled(listener: (projectDir: string) => void): () => void {
  settledListeners.add(listener);
  return () => settledListeners.delete(listener);
}

export function isMergeQueued(taskId: string): boolean {
  return queued.has(taskId);
}

export function inMergeQueue<T>(
  projectDir: string,
  taskId: string,
  merge: () => Promise<T>,
  /** Called at once when others are ahead, with how many */
  onWait?: (ahead: number) => void,
): Promise<T> {
  const ahead = waiting.get(projectDir) ?? 0;
  if (ahead) onWait?.(ahead);
  waiting.set(projectDir, ahead + 1);
  queued.add(taskId);

  const run = (tails.get(projectDir) ?? Promise.resolve()).then(merge, merge).finally(() => {
    queued.delete(taskId);
    for (const listener of settledListeners) {
      try {
        listener(projectDir);
      } catch {
        // A listener's failure is its own: the queue goes on
      }
    }
    const left = (waiting.get(projectDir) ?? 1) - 1;
    if (left) {
      waiting.set(projectDir, left);
    } else {
      waiting.delete(projectDir);
      tails.delete(projectDir);
    }
  });
  // The next merge goes ahead whether this one failed or not; this one's caller hears the failure
  tails.set(projectDir, run.catch(() => undefined));
  return run;
}
