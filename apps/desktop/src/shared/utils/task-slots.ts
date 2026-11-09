/**
 * How many tasks of a project may be under way. A task holds its slot until it is
 * merged, not only while agents run: one that starts before the last is merged
 * branches from a main without that work, and the two then meet as a conflict.
 */
import type { Task } from '../types';

export const DEFAULT_MAX_PARALLEL_TASKS = 1;
export const MAX_PARALLEL_TASKS = 3;

const NOT_MERGED_YET = new Set<string>(['in_progress', 'ai_review', 'human_review', 'error']);

/** The saved limit, or the default; a project may have saved more than is allowed now. */
export function parallelTaskLimit(saved: number | undefined): number {
  if (!saved || !Number.isFinite(saved) || saved < 1) return DEFAULT_MAX_PARALLEL_TASKS;
  return Math.min(Math.floor(saved), MAX_PARALLEL_TASKS);
}

export function occupiesSlot(task: Pick<Task, 'status' | 'metadata'>): boolean {
  return NOT_MERGED_YET.has(task.status) && !task.metadata?.archivedAt;
}

/** The spec numbers of the tasks holding the slots, to say what the queue waits for. */
export function slotHolders(tasks: Task[]): string[] {
  return tasks.filter(occupiesSlot).map((task) => (task.specId ?? task.id).split('-')[0]);
}

/**
 * Whether a task starting now would have to wait. `taskId`: a task that already
 * holds a slot resumes in it, however many others there are.
 */
export function isAtCapacity(tasks: Task[], limit: number, taskId?: string): boolean {
  const others = tasks.filter(occupiesSlot);
  if (taskId && others.some((task) => task.id === taskId)) return false;
  return others.length >= limit;
}

/** Whether auto-merge holds this task for the owner's preview right now */
export const waitsForPreview = (task: Pick<Task, 'status' | 'reviewReason' | 'waitingForPreview'>): boolean =>
  task.status === 'human_review' && task.reviewReason === 'completed' && task.waitingForPreview === true;

/** The slot holders' numbers, a held task's through `held` (it waits for the owner, not an agent) */
export function slotHolderLabels(tasks: Task[], held: (number: string) => string): string[] {
  return tasks.filter(occupiesSlot).map((task) => {
    const number = (task.specId ?? task.id).split('-')[0];
    return waitsForPreview(task) ? held(number) : number;
  });
}
