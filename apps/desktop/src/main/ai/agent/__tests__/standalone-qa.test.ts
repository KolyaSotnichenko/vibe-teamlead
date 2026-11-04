import { describe, expect, it, vi } from 'vitest';

import { runStandaloneQa } from '../standalone-qa';
import type { QAOutcome } from '../../orchestration/qa-loop';

const outcome = (over: Partial<QAOutcome>): QAOutcome => ({ approved: false, totalIterations: 1, durationMs: 1, ...over });

describe('runStandaloneQa', () => {
  it('announces QA before it runs, so the task moves to AI Review for the whole run', async () => {
    const events: string[] = [];
    await runStandaloneQa(
      async () => {
        events.push('qa ran');
        return outcome({ approved: true });
      },
      (type) => events.push(type),
    );
    expect(events).toEqual(['QA_STARTED', 'qa ran', 'QA_PASSED']);
  });

  it('says how a run that did not approve ended', async () => {
    for (const [reason, event] of [
      ['max_iterations', 'QA_MAX_ITERATIONS'],
      ['security_findings', 'QA_MAX_ITERATIONS'],
      ['recurring_issues', 'QA_AGENT_ERROR'],
      ['error', 'QA_AGENT_ERROR'],
    ] as const) {
      const post = vi.fn();
      await runStandaloneQa(async () => outcome({ reason, error: 'x' }), post);
      expect(post.mock.calls.at(-1)?.[0]).toBe(event);
    }
  });

  it('passes the error on and returns the outcome', async () => {
    const post = vi.fn();
    const result = outcome({ reason: 'error', error: 'boom' });
    await expect(runStandaloneQa(async () => result, post)).resolves.toBe(result);
    expect(post).toHaveBeenLastCalledWith('QA_AGENT_ERROR', { error: 'boom' });
  });
});
