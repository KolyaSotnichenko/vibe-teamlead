/**
 * A task's preview: the link to its branch's Vercel build. The main process answers
 * from GitHub (and does not cache errors), so the renderer asks at most every 30 s,
 * and only while a build is running, plus whenever the task's branch is pushed.
 */

import { useEffect, useState } from 'react';
import type { Task } from '../../../shared/types';
import type { TaskPreview } from '../../../shared/types/deploy';

type Listener = () => void;

export const PREVIEW_REFRESH_MS = 30_000;

const listeners = new Map<string, Set<Listener>>();
let unsubscribe: (() => void) | undefined;

/** One listener for all cards: a board can hold dozens of them. */
function listen(taskId: string, listener: Listener): () => void {
  unsubscribe ??= window.electronAPI?.deploy?.onPreviewUpdate?.(({ taskId: id }) => {
    for (const each of listeners.get(id) ?? []) each();
  });
  if (!listeners.has(taskId)) listeners.set(taskId, new Set());
  listeners.get(taskId)?.add(listener);
  return () => {
    listeners.get(taskId)?.delete(listener);
    if (!listeners.get(taskId)?.size) listeners.delete(taskId);
    if (!listeners.size) resetPreviewSubscription();
  };
}

export function resetPreviewSubscription(): void {
  unsubscribe?.();
  unsubscribe = undefined;
  listeners.clear();
}

export function usePreview(task: Pick<Task, 'id' | 'projectId'>): TaskPreview | undefined {
  const [preview, setPreview] = useState<TaskPreview | undefined>(undefined);
  const building = preview?.state === 'building';

  useEffect(() => {
    setPreview(undefined);
    let cancelled = false;
    const ask = () => {
      window.electronAPI?.deploy
        ?.previewState?.(task.projectId, task.id)
        .then((next) => {
          if (!cancelled && next) setPreview(next);
        })
        .catch(() => {});
    };
    ask();
    const stop = listen(task.id, ask);
    return () => {
      cancelled = true;
      stop();
    };
  }, [task.id, task.projectId]);

  useEffect(() => {
    if (!building) return;
    const timer = setInterval(() => {
      window.electronAPI?.deploy
        ?.previewState?.(task.projectId, task.id)
        .then((next) => {
          if (next) setPreview(next);
        })
        .catch(() => {});
    }, PREVIEW_REFRESH_MS);
    return () => clearInterval(timer);
  }, [building, task.id, task.projectId]);

  return preview;
}
