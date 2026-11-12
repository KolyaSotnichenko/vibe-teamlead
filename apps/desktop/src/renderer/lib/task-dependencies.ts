/**
 * Task dependencies (from brief import): a task lists the spec ids it builds on
 * in `metadata.dependencies`. It may start only when every dependency is done —
 * merged into the base branch, so the code it needs exists in its new worktree.
 */

import type { Task } from '../../shared/types';
import { occupiesSlot } from '../../shared/utils/task-slots';

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

/**
 * The queued task to start next, oldest first, or undefined when every slot is taken (`limit`,
 * the project's parallel-task limit) or no queued task may start. `skip`: tasks that already
 * failed to start this round.
 */
export function nextQueuedToStart(allTasks: readonly Task[], limit: number, skip: ReadonlySet<string> = new Set()): Task | undefined {
  if (allTasks.filter(occupiesSlot).length >= limit) return undefined;
  return allTasks
    .filter((t) => t.status === 'queue' && !t.metadata?.archivedAt && !skip.has(t.id) && isReadyToStart(t, allTasks))
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())[0];
}
