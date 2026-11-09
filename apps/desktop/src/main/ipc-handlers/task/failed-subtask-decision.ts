/**
 * Writes what the owner decided about subtasks the coder gave up on into every copy of
 * the task's plan: the worktree's, which the build reads, and the main project's, which
 * the task list reads when there is no worktree.
 */

import { app } from 'electron';

import { resolveFailedSubtasks, type DecidedSubtask, type FailedSubtaskAction } from '../../ai/orchestration/failed-subtasks';
import { ownerDecisionsPath, recordOwnerDecision } from '../../ai/orchestration/owner-decisions';
import { updatePlanFile } from './plan-file-utils';

/**
 * Where the owner's decisions for a task are kept: the app's data, keyed by its spec directory
 * in the main project. Undefined when the app's data folder can't be found: the agents are then
 * told no decision, which is safe, and the task still runs.
 */
export function taskOwnerDecisionsFile(mainSpecDir: string): string | undefined {
  try {
    return ownerDecisionsPath(app.getPath('userData'), mainSpecDir);
  } catch {
    return undefined;
  }
}

/**
 * The plans show the decision; `decisionsFile` is what the agents are told, since they can
 * edit the plans themselves.
 */
export async function applyFailedSubtaskDecision(
  planPaths: string[],
  decision: FailedSubtaskAction,
  decisionsFile: string,
): Promise<{ changed: string[] }> {
  const now = new Date().toISOString();
  // Fingerprints from the first copy, the worktree's when there is one: that is what the build reads
  let decided: DecidedSubtask[] | null = null;
  for (const planPath of planPaths) {
    await updatePlanFile<Record<string, unknown>>(planPath, (plan) => {
      const result = resolveFailedSubtasks(plan as { phases?: Array<{ subtasks?: Array<Record<string, unknown>> }> }, decision, now);
      decided ??= result.changed.length ? result.changed : null;
      return plan;
    });
  }
  const changed: DecidedSubtask[] = decided ?? [];
  if (changed.length) recordOwnerDecision(decisionsFile, changed, decision);
  return { changed: changed.map((c) => c.id) };
}

/** The decision as the renderer sent it, or null when it is not one. Pure. */
export function parseFailedSubtaskDecision(value: unknown): FailedSubtaskAction | null {
  if (!value || typeof value !== 'object') return null;
  const { action, instruction, ids } = value as { action?: unknown; instruction?: unknown; ids?: unknown };
  // The subtasks the owner was shown: the decision covers only those
  if (!Array.isArray(ids) || !ids.length || ids.length > 50 || !ids.every((id) => typeof id === 'string' && id.length <= 200)) return null;
  const shown = ids as string[];
  if (action === 'skip') return { action: 'skip', ids: shown };
  if (action === 'retry') return { action: 'retry', instruction: typeof instruction === 'string' ? instruction : undefined, ids: shown };
  return null;
}
