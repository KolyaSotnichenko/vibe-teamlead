/**
 * Which mood the teamlead shows for the selected project. One mood at a time,
 * by priority: a reaction to a click, a fresh merge, an error, a question for
 * you, a task to review, work, QA, the queue, and finally rest. Pure.
 */

import type { TeamleadMood } from './sprite';

export const SLEEP_AFTER_MS = 60 * 60 * 1000;
export const DONE_FOR_MS = 2000;
export const HELLO_FOR_MS = 1600;

export interface TeamTaskLike {
  status: string;
  reviewReason?: string;
}

export interface MoodCounts {
  /** in_progress */
  coding: number;
  /** ai_review */
  qa: number;
  queued: number;
  /** human_review that isn't an error */
  review: number;
  /** human_review with errors, or a task that errored */
  errors: number;
}

export function countMood(tasks: TeamTaskLike[]): MoodCounts {
  const c: MoodCounts = { coding: 0, qa: 0, queued: 0, review: 0, errors: 0 };
  for (const t of tasks) {
    if (t.status === 'in_progress') c.coding += 1;
    else if (t.status === 'ai_review') c.qa += 1;
    else if (t.status === 'queue') c.queued += 1;
    else if (t.status === 'error' || (t.status === 'human_review' && t.reviewReason === 'errors')) c.errors += 1;
    else if (t.status === 'human_review') c.review += 1;
  }
  return c;
}

export interface MoodInput extends MoodCounts {
  waiting: number;
  /** Time since anything about the team last changed */
  quietForMs: number;
  justMerged: boolean;
  hello: boolean;
}

export function teamleadMood(m: MoodInput): TeamleadMood {
  if (m.hello) return 'hello';
  if (m.justMerged) return 'done';
  if (m.errors > 0) return 'error';
  if (m.waiting > 0) return 'waiting';
  if (m.review > 0) return 'review';
  if (m.coding > 0) return 'working';
  if (m.qa > 0) return 'qa';
  if (m.queued > 0) return 'queued';
  return m.quietForMs >= SLEEP_AFTER_MS ? 'sleep' : 'idle';
}
