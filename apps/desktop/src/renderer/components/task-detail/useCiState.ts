/**
 * A task's CI status (GitHub Actions runs of its branch for the last push). The main process
 * answers from GitHub (and does not cache errors), so the renderer asks at most every 30 s
 * per task however many cards and windows show it: one shared entry per task holds the
 * state, the timer and the ask in flight. It polls only while CI is running or a run is still
 * awaited (`waiting` and not `settled`: the run may not exist yet), and asks again whenever the branch is pushed.
 */

import { useEffect, useState } from 'react';
import type { Task } from '../../../shared/types';
import type { TaskCiState } from '../../../shared/types/deploy';

type Listener = () => void;

export const PREVIEW_REFRESH_MS = 30_000;

interface Entry {
  projectId: string;
  ci: TaskCiState | undefined;
  subscribers: Set<Listener>;
  timer: ReturnType<typeof setInterval> | undefined;
  lastAskAt: number;
  inFlight: boolean;
  askAgain: boolean;
}

const entries = new Map<string, Entry>();
let unsubscribe: (() => void) | undefined;

function syncTimer(entry: Entry, taskId: string): void {
  const poll = (entry.ci?.state === 'running' || (entry.ci?.state === 'waiting' && !entry.ci.settled)) && entry.subscribers.size > 0;
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
        entry.ci = next;
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
    entry = { projectId: task.projectId, ci: undefined, subscribers: new Set(), timer: undefined, lastAskAt: 0, inFlight: false, askAgain: false };
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

export function useCiState(task: Pick<Task, 'id' | 'projectId'>): TaskCiState | undefined {
  const [ci, setCi] = useState<TaskCiState | undefined>(() => entries.get(task.id)?.ci);

  useEffect(() => {
    setCi(entries.get(task.id)?.ci);
    return subscribe(task, () => setCi(entries.get(task.id)?.ci));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id, task.projectId]);

  return ci;
}
