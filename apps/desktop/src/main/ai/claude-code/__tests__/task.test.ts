import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ClaudeTaskError, runClaudeTask } from '../task';

describe('runClaudeTask', () => {
  it('requires a cwd when tools are enabled', async () => {
    await expect(
      runClaudeTask({ systemPrompt: 's', prompt: 'p', tools: ['Read'], auth: { apiKey: 'k' }, bundled: {} }),
    ).rejects.toThrow(/cwd/);
  });

  it('fails with the session attached when no API key is available', async () => {
    const error = await runClaudeTask({
      systemPrompt: 'Generate a title',
      prompt: 'Add login page',
      auth: {},
      bundled: {},
      outputSchema: z.object({ title: z.string() }),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClaudeTaskError);
    expect((error as ClaudeTaskError).session.outcome).toBe('auth_failure');
  });
});
