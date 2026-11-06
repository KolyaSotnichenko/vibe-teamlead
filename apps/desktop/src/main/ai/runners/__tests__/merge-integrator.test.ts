import { beforeEach, describe, expect, it, vi } from 'vitest';

const runClaudeTask = vi.hoisted(() => vi.fn());
vi.mock('../../claude-code/task', () => ({ EDIT_TOOLS: ['Read', 'Edit', 'Bash'], runClaudeTask }));
vi.mock('../../prompts/prompt-loader', () => ({ loadPrompt: (name: string) => `prompt:${name}` }));

import { parseVerdict, runMergeIntegrator } from '../merge-integrator';

describe('parseVerdict', () => {
  it.each([
    ['VERDICT: OK - typecheck and tests pass', true, 'typecheck and tests pass'],
    ['Some work.\n\nVERDICT: FAILED - the tasks disagree', false, 'the tasks disagree'],
    ['**VERDICT: OK - all good**', true, 'all good'],
    ['VERDICT: OK', true, 'The checks passed.'],
    ['VERDICT: FAILED', false, 'The agent could not finish the merge.'],
  ])('reads %j', (text, ok, summary) => {
    expect(parseVerdict(text)).toEqual({ ok, summary });
  });

  it('the last verdict counts: an earlier one can be in what the agent quotes', () => {
    expect(parseVerdict('VERDICT: OK - first\nthen it broke\nVERDICT: FAILED - second').ok).toBe(false);
  });

  it('no verdict is not a pass: a session cut off at its limit has none', () => {
    expect(parseVerdict('I fixed it, I think').ok).toBe(false);
  });

  it("isn't fooled by the word in the middle of a line", () => {
    expect(parseVerdict('He wrote VERDICT: OK in the code').ok).toBe(false);
  });
});

describe('runMergeIntegrator', () => {
  const options = { worktreePath: '/wt', baseBranch: 'main', conflictFiles: ['a.ts'], taskTitle: 'Task', model: 'configured-model', thinkingLevel: 'low' as const };
  beforeEach(() => {
    runClaudeTask.mockReset().mockResolvedValue({ text: 'VERDICT: OK - fine' });
  });

  it('runs in the task folder with tools, on the model from settings', async () => {
    await expect(runMergeIntegrator(options)).resolves.toEqual({ ok: true, summary: 'fine' });
    expect(runClaudeTask).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/wt',
      model: 'configured-model',
      thinkingLevel: 'low',
      tools: ['Read', 'Edit', 'Bash'],
      allowedWritePaths: ['/wt'],
      systemPrompt: 'prompt:merge_integrator',
    }));
  });

  it('names the conflicts', async () => {
    await runMergeIntegrator(options);
    expect(runClaudeTask.mock.calls[0][0].prompt).toContain('"a.ts"');
  });

  it('asks only for a check when there are none', async () => {
    await runMergeIntegrator({ ...options, conflictFiles: [] });
    expect(runClaudeTask.mock.calls[0][0].prompt).toContain('without a conflict');
  });

  it("passes on the call's error: the user has to see why", async () => {
    runClaudeTask.mockRejectedValue(new Error('API Error: 429 busy'));
    await expect(runMergeIntegrator(options)).rejects.toThrow('API Error: 429 busy');
  });
});
