/**
 * Task dependencies (from brief import): a task lists the spec ids it builds on
 * in `metadata.dependencies`. It may start only when every dependency is done —
 * merged into the base branch, so the code it needs exists in its new worktree.
 */

import type { Task } from '../../shared/types';

/** Dependencies of `task` that are not done yet (unknown or deleted ones don't block). */
export function unfinishedDependencies(task: Task, allTasks: readonly Task[]): Task[] {
  const deps = task.metadata?.dependencies ?? [];
  if (!deps.length) return [];
  return deps
    .map((dep) => allTasks.find((t) => t.specId === dep || t.id === dep))
    .filter((t): t is Task => !!t && t.status !== 'done' && !t.metadata?.archivedAt);
}

/** Whether a queued task may be started now. */
export function isReadyToStart(task: Task, allTasks: readonly Task[]): boolean {
  return unfinishedDependencies(task, allTasks).length === 0;
}
