/**
 * The owner asks for the app's own checks again on a task waiting for review: no model, no QA,
 * only the typecheck, the tests and the start, run anew on what is committed. What the task's
 * agents left running is stopped first: it would hold the ports the project expects. What the
 * checks found replaces the task's `verification.json`, which the task's window shows.
 */

import type { VerificationReport } from '../../ai/verification/verify-task';
import { verificationSummary } from '../../ai/verification/verify-task';
import type { VerificationSummary } from '../../../shared/utils/verification-summary';

export interface VerifyAgainDeps {
  /** The task's status now */
  status: string;
  /** The task's own folder; null when it has none */
  worktree: string | null;
  /** One run at a time for this key (the project and the task) */
  key?: string;
  stopContainers: () => Promise<void>;
  verify: (options: { fresh: true }) => Promise<VerificationReport>;
  write: (summary: VerificationSummary) => Promise<void>;
  /** The checks now find the task broke something */
  regression: () => void;
}

const running = new Set<string>();

export async function verifyAgain(deps: VerifyAgainDeps): Promise<VerificationSummary> {
  if (deps.status !== 'human_review') throw new Error('The checks run again only for a task waiting for your review.');
  if (!deps.worktree) throw new Error('This task has no folder to check.');
  const key = deps.key ?? deps.worktree;
  if (running.has(key)) throw new Error('The checks are already running for this task.');
  running.add(key);
  try {
    await deps.stopContainers().catch(() => undefined);
    const report = await deps.verify({ fresh: true });
    const summary = verificationSummary(report);
    await deps.write(summary);
    if (report.status === 'regression') deps.regression();
    return summary;
  } finally {
    running.delete(key);
  }
}
