/**
 * A QA run on its own (Run QA again, Request Changes), outside the build. The
 * build announces QA from its phase changes; here nothing else would, and the
 * task would sit in "in progress" with every subtask done until the task list
 * took it for a finished build. No Electron imports.
 */

import { DEFAULT_QA_ITERATIONS } from '../orchestration/qa-reports';
import type { QAOutcome } from '../orchestration/qa-loop';

export type PostTaskEvent = (type: string, extra?: Record<string, unknown>) => void;

export async function runStandaloneQa(runQa: () => Promise<QAOutcome>, post: PostTaskEvent): Promise<QAOutcome> {
  post('QA_STARTED', { iteration: 0, maxIterations: DEFAULT_QA_ITERATIONS });
  const outcome = await runQa();
  if (outcome.approved) {
    post('QA_PASSED');
  } else if (outcome.reason === 'max_iterations' || outcome.reason === 'security_findings') {
    // Both go to human review with the reports attached.
    post('QA_MAX_ITERATIONS');
  } else {
    post('QA_AGENT_ERROR', { error: outcome.error });
  }
  return outcome;
}
