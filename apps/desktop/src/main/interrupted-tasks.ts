/**
 * Tasks the last session left running. Quitting stops the agents (the quit dialog says the
 * tasks stay unfinished and can be resumed), but their files still say "in progress", so the
 * card used to sit there until the stuck check offered Recover. At launch each such task is
 * stopped the way Stop stops it: to review with Resume when it has a plan, back to the backlog
 * when not. Nothing is restarted, so nothing spends tokens without the owner.
 */

import type { Project, Task } from '../shared/types';

const INTERRUPTED = new Set(['in_progress', 'ai_review']);

/** Pure. */
export function interruptedTasks(tasks: Task[]): Task[] {
  return tasks.filter((task) => INTERRUPTED.has(task.status) && !task.metadata?.archivedAt);
}

export interface SettleDeps {
  projects: Project[];
  tasksOf: (projectId: string) => Task[];
  hasPlan: (project: Project, task: Task) => boolean;
  isRunning: (taskId: string) => boolean;
  stop: (taskId: string, task: Task, project: Project, hasPlan: boolean) => void;
}

/** Stop what the last session left running; returns how many. Never throws. */
export function settleInterruptedTasks({ projects, tasksOf, hasPlan, isRunning, stop }: SettleDeps): number {
  let settled = 0;
  for (const project of projects) {
    try {
      for (const task of interruptedTasks(tasksOf(project.id))) {
        if (isRunning(task.id)) continue;
        stop(task.id, task, project, hasPlan(project, task));
        settled++;
      }
    } catch {
      // an unreadable project stays as it is; the stuck check still offers Recover
    }
  }
  return settled;
}
