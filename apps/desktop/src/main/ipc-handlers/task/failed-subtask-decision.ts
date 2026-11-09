/**
 * Writes what the owner decided about subtasks the coder gave up on into every copy of
 * the task's plan: the worktree's, which the build reads, and the main project's, which
 * the task list reads when there is no worktree.
 */

import { app } from 'electron';

import { resolveFailedSubtasks, type FailedSubtaskAction } from '../../ai/orchestration/failed-subtasks';
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
  const changed = new Set<string>();
  for (const planPath of planPaths) {
    await updatePlanFile<Record<string, unknown>>(planPath, (plan) => {
      const result = resolveFailedSubtasks(plan as { phases?: Array<{ subtasks?: Array<Record<string, unknown>> }> }, decision, now);
      for (const id of result.changed) changed.add(id);
      return plan;
    });
  }
  if (changed.size) recordOwnerDecision(decisionsFile, [...changed], decision);
  return { changed: [...changed] };
}

/** The decision as the renderer sent it, or null when it is not one. Pure. */
export function parseFailedSubtaskDecision(value: unknown): FailedSubtaskAction | null {
  if (!value || typeof value !== 'object') return null;
  const { action, instruction } = value as { action?: unknown; instruction?: unknown };
  if (action === 'skip') return { action: 'skip' };
  if (action === 'retry') return { action: 'retry', instruction: typeof instruction === 'string' ? instruction : undefined };
  return null;
}
