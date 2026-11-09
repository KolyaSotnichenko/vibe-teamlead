/**
 * What the owner decided about subtasks a coder gave up on (status `failed` or `blocked`,
 * with its reason in `notes`). Resuming as is gives the coder the same subtask under the same
 * limits, and it stops again; the owner either skips the subtask, so the task goes on to QA,
 * or sends it back with an instruction the coder gets on its next session.
 */

/** Statuses a coder sets when it can't finish its subtask. */
export const GAVE_UP_STATUSES: ReadonlySet<string> = new Set(['failed', 'blocked']);

/** Longest instruction kept: enough for a paragraph, not for a pasted log. */
export const OWNER_INSTRUCTION_MAX = 4000;

export type FailedSubtaskAction = { action: 'skip' } | { action: 'retry'; instruction?: string };

interface PlanLike {
  phases?: Array<{ subtasks?: Array<Record<string, unknown>> }>;
}

/** The plan with the owner's decision applied to every given-up subtask, and their ids. Pure. */
export function resolveFailedSubtasks<T extends PlanLike>(
  plan: T,
  decision: FailedSubtaskAction,
  now: string,
): { plan: T; changed: string[] } {
  const changed: string[] = [];
  const phases = Array.isArray(plan?.phases) ? plan.phases : [];
  for (const phase of phases) {
    for (const subtask of Array.isArray(phase?.subtasks) ? phase.subtasks : []) {
      if (!subtask || !GAVE_UP_STATUSES.has(String(subtask.status))) continue;
      changed.push(String(subtask.id ?? ''));
      if (decision.action === 'skip') {
        subtask.status = 'completed';
        subtask.skipped_by_owner = true;
        subtask.completed_at = now;
        continue;
      }
      subtask.status = 'pending';
      delete subtask.skipped_by_owner;
      const instruction = (decision.instruction ?? '').trim().slice(0, OWNER_INSTRUCTION_MAX);
      if (instruction) subtask.owner_instruction = instruction;
      else delete subtask.owner_instruction;
    }
  }
  return { plan, changed };
}
