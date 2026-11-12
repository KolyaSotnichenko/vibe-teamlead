/**
 * A task's preview: the link to its branch's Vercel build. The main process answers
 * from GitHub (and does not cache errors), so the renderer asks at most every 30 s
 * per task however many cards and windows show it: one shared entry per task holds the
 * state, the timer and the ask in flight. It polls only while a build is running, and
 * asks again whenever the task's branch is pushed.
 */

import { useEffect, useState } from 'react';
import type { Task } from '../../../shared/types';
import type { TaskPreview } from '../../../shared/types/deploy';

type Listener = () => void;

export const PREVIEW_REFRESH_MS = 30_000;

interface Entry {
  projectId: string;
  preview: TaskPreview | undefined;
  subscribers: Set<Listener>;
  timer: ReturnType<typeof setInterval> | undefined;
  lastAskAt: number;
  inFlight: boolean;
  askAgain: boolean;
}

const entries = new Map<string, Entry>();
let unsubscribe: (() => void) | undefined;

function syncTimer(entry: Entry, taskId: string): void {
  const poll = entry.preview?.state === 'building' && entry.subscribers.size > 0;
  if (poll && !entry.timer) entry.timer = setInterval(() => ask(taskId, true), PREVIEW_REFRESH_MS);
  if (!poll && entry.timer) {
    clearInterval(entry.timer);
    entry.timer = undefined;
  }
}

/** `force`: a push was heard or the timer fired; otherwise a recent answer is reused. */
function ask(taskId: string, force: boolean): void {
  const entry = entries.get(taskId);
  if (!entry) return;
  if (entry.inFlight) {
    if (force) entry.askAgain = true;
    return;
  }
  if (!force && entry.lastAskAt && Date.now() - entry.lastAskAt < PREVIEW_REFRESH_MS) return;
  entry.inFlight = true;
  entry.lastAskAt = Date.now();
  const query = window.electronAPI?.deploy?.previewState?.(entry.projectId, taskId);
  void Promise.resolve(query)
    .then((next) => {
      if (next && entries.get(taskId) === entry) {
        entry.preview = next;
        for (const each of entry.subscribers) each();
      }
    })
    .catch(() => {})
    .finally(() => {
      entry.inFlight = false;
      if (entries.get(taskId) !== entry) return;
      syncTimer(entry, taskId);
      if (entry.askAgain) {
        entry.askAgain = false;
        ask(taskId, true);
      }
    });
}

function subscribe(task: Pick<Task, 'id' | 'projectId'>, listener: Listener): () => void {
  unsubscribe ??= window.electronAPI?.deploy?.onPreviewUpdate?.(({ taskId }) => ask(taskId, true));
  let entry = entries.get(task.id);
  if (!entry) {
    entry = { projectId: task.projectId, preview: undefined, subscribers: new Set(), timer: undefined, lastAskAt: 0, inFlight: false, askAgain: false };
    entries.set(task.id, entry);
  }
  entry.subscribers.add(listener);
  ask(task.id, false);
  syncTimer(entry, task.id);
  return () => {
    const own = entries.get(task.id);
    if (!own) return;
    own.subscribers.delete(listener);
    if (own.subscribers.size) return;
    if (own.timer) clearInterval(own.timer);
    entries.delete(task.id);
    if (!entries.size) resetPreviewSubscription();
  };
}

export function resetPreviewSubscription(): void {
  unsubscribe?.();
  unsubscribe = undefined;
  for (const entry of entries.values()) if (entry.timer) clearInterval(entry.timer);
  entries.clear();
}

export function usePreview(task: Pick<Task, 'id' | 'projectId'>): TaskPreview | undefined {
  const [preview, setPreview] = useState<TaskPreview | undefined>(() => entries.get(task.id)?.preview);

  useEffect(() => {
    setPreview(entries.get(task.id)?.preview);
    return subscribe(task, () => setPreview(entries.get(task.id)?.preview));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id, task.projectId]);

  return preview;
}
