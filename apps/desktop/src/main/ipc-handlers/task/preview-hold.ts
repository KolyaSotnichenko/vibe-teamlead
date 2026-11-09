/**
 * A task held for the owner's preview ("UI tasks wait for my preview") says so in its plan,
 * so its card shows it after a restart too. The card shows it only while the task waits
 * in review: once it merges or goes back to the agents, the mark means nothing.
 */

import { existsSync } from 'node:fs';

import { updatePlanFile } from './plan-file-utils';

/** `on` false clears it: the task went back to the agents */
export async function markWaitingForPreview(planPaths: string[], on = true): Promise<void> {
  for (const planPath of planPaths) {
    if (!existsSync(planPath)) continue;
    await updatePlanFile<Record<string, unknown>>(planPath, (plan) => {
      const { waitingForPreview: _old, ...rest } = plan;
      return on ? { ...rest, waitingForPreview: true } : rest;
    });
  }
}
