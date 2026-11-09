/**
 * What the owner decided about subtasks a coder gave up on (status `failed` or `blocked`,
 * with its reason in `notes`). Resuming as is gives the coder the same subtask under the same
 * limits, and it stops again; the owner either skips the subtask, so the task goes on to QA,
 * or sends it back with an instruction the coder gets on its next session. The plan only
 * shows the decision (`skipped_by_owner` is for display); what the agents are told comes
 * from owner-decisions.ts.
 */

import { createHash } from 'node:crypto';

/** Statuses a coder sets when it can't finish its subtask. */
export const GAVE_UP_STATUSES: ReadonlySet<string> = new Set(['failed', 'blocked']);

/** Longest instruction kept: enough for a paragraph, not for a pasted log. */
export const OWNER_INSTRUCTION_MAX = 4000;

/** `ids`: the subtasks the owner was shown; the decision covers only those. */
export type FailedSubtaskAction = { action: 'skip'; ids?: string[] } | { action: 'retry'; instruction?: string; ids?: string[] };

/** A subtask the decision covered, with the fingerprint of what the owner saw. */
export interface DecidedSubtask {
  id: string;
  fingerprint: string;
}

/**
 * Title and description, hashed: a decision holds for the subtask as the owner saw it, not for
 * whatever an agent later writes under the same id. Pure.
 */
export function subtaskFingerprint(subtask: { title?: unknown; description?: unknown }): string {
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  return createHash('sha256').update(`${text(subtask.title)}\0${text(subtask.description)}`).digest('hex').slice(0, 32);
}

interface PlanLike {
  phases?: Array<{ subtasks?: Array<Record<string, unknown>> }>;
}

/** The plan with the owner's decision applied to every given-up subtask, and their ids. Pure. */
export function resolveFailedSubtasks<T extends PlanLike>(
  plan: T,
  decision: FailedSubtaskAction,
  now: string,
): { plan: T; changed: DecidedSubtask[] } {
  const changed: DecidedSubtask[] = [];
  const shown = decision.ids ? new Set(decision.ids) : null;
  const phases = Array.isArray(plan?.phases) ? plan.phases : [];
  for (const phase of phases) {
    for (const subtask of Array.isArray(phase?.subtasks) ? phase.subtasks : []) {
      if (!subtask || !GAVE_UP_STATUSES.has(String(subtask.status))) continue;
      if (shown && !shown.has(String(subtask.id ?? ''))) continue;
      changed.push({ id: String(subtask.id ?? ''), fingerprint: subtaskFingerprint(subtask) });
      if (decision.action === 'skip') {
        subtask.status = 'completed';
        subtask.skipped_by_owner = true;
        subtask.completed_at = now;
        continue;
      }
      // The instruction goes to the app's own store (owner-decisions.ts), never into the plan agents write
      subtask.status = 'pending';
      delete subtask.skipped_by_owner;
    }
  }
  return { plan, changed };
}
