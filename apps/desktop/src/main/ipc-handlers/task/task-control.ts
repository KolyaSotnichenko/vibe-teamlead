/**
 * Stopping tasks and pausing the queue, shared by the window (IPC) and the Telegram bot.
 *
 * - stopTaskLikeStop: what the Stop button does to one task.
 * - The queue pause: while paused, the board starts no queued task (KanbanBoard processQueue
 *   asks); it lives in memory, so a restart starts with the queue running.
 */

import type { Project, Task } from '../../../shared/types';

export interface StopDeps {
  killTask: (taskId: string) => unknown;
  unwatch: (taskId: string) => Promise<unknown>;
  findTaskAndProject: (taskId: string) => { task?: Task; project?: Project };
  hasPlanWithSubtasks: (project: Project, task: Task) => boolean;
  stopTask: (taskId: string, task: Task, project: Project, hasPlan: boolean) => void;
  prepareForRestart: (taskId: string) => void;
  onUnwatchError?: (error: unknown) => void;
}

export function stopTaskLikeStop(taskId: string, deps: StopDeps): void {
  deps.killTask(taskId);
  deps.unwatch(taskId).catch((error) => deps.onUnwatchError?.(error));

  // Find task and project to emit USER_STOPPED with plan context
  const { task, project } = deps.findTaskAndProject(taskId);
  if (!task || !project) return;

  // Use shared utility to determine if a valid implementation plan exists
  const hasPlan = deps.hasPlanWithSubtasks(project, task);
  deps.stopTask(taskId, task, project, hasPlan);

  // Clear stale tracking state so a subsequent restart works correctly
  deps.prepareForRestart(taskId);
}

export interface QueuePause {
  isPaused(): boolean;
  /** True when the state changed */
  set(paused: boolean): boolean;
  onChange(listener: (paused: boolean) => void): () => void;
}

export function createQueuePause(): QueuePause {
  let paused = false;
  const listeners = new Set<(paused: boolean) => void>();
  return {
    isPaused: () => paused,
    set(next) {
      if (next === paused) return false;
      paused = next;
      for (const listener of listeners) {
        try {
          listener(paused);
        } catch {
          // a listener never breaks the pause
        }
      }
      return true;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The app's queue pause */
export const queuePause = createQueuePause();

/** Emergency stop: the queue is paused first (so a freed slot starts nothing), then every running task is stopped. */
export function stopAllTasks(deps: { running: () => string[]; stop: (taskId: string) => void; pause?: QueuePause }): string[] {
  (deps.pause ?? queuePause).set(true);
  const ids = deps.running();
  for (const id of ids) deps.stop(id);
  return ids;
}
