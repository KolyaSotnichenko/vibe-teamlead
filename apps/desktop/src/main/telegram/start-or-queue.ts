/**
 * The bot's Start keeps the board's rules: the project's parallel-task limit, and the queue
 * paused by /stop_all. Otherwise a press on the phone could run more agents than the owner
 * allows. Pure.
 */
import type { Task } from '../../shared/types';
import { isAtCapacity } from '../../shared/utils/task-slots';

export function startOrQueue(input: { paused: boolean; tasks: Task[]; limit: number; taskId: string }): 'start' | 'queue' {
  if (input.paused) return 'queue';
  return isAtCapacity(input.tasks, input.limit, input.taskId) ? 'queue' : 'start';
}
