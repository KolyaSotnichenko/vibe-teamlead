/**
 * Where this task's merge stands. A merge can wait in a queue and take minutes with
 * an agent at work, long after the window that started it was closed, so the card
 * and the task ask the main process, and hear when it ends.
 */

import { useEffect, useState } from 'react';
import type { MergeProgress, MergeState, Task } from '../../../shared/types';

type Listener = (progress: MergeProgress) => void;

const listeners = new Map<string, Set<Listener>>();
let unsubscribe: (() => void) | undefined;

/** One listener for all cards: a board can hold dozens of them. */
function listen(taskId: string, listener: Listener): () => void {
  unsubscribe ??= window.electronAPI?.onMergeProgress?.((id, progress) => {
    for (const each of listeners.get(id) ?? []) each(progress);
  });
  if (!listeners.has(taskId)) listeners.set(taskId, new Set());
  listeners.get(taskId)?.add(listener);
  return () => {
    listeners.get(taskId)?.delete(listener);
    if (!listeners.get(taskId)?.size) listeners.delete(taskId);
    if (!listeners.size) resetMergeStateSubscription();
  };
}

export function resetMergeStateSubscription(): void {
  unsubscribe?.();
  unsubscribe = undefined;
  listeners.clear();
}

export function useMergeState(task: Task): MergeState | null {
  const [state, setState] = useState<MergeState | null>(null);
  const inReview = task.status === 'human_review';

  useEffect(() => {
    setState(null);
    if (!inReview) return;
    let cancelled = false;
    const ask = () => {
      window.electronAPI
        ?.getTaskMergeState?.(task.id, task.projectId)
        .then((r) => {
          if (!cancelled && r?.success) setState(r.data ?? null);
        })
        .catch(() => {});
    };
    ask();
    const stop = listen(task.id, (progress) => {
      if (progress.stage === 'complete' || progress.stage === 'error') ask();
      else if (!cancelled) setState({ state: 'merging' });
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [task.id, task.projectId, inReview]);

  return state;
}
