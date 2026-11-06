import { beforeEach, describe, expect, it, vi } from 'vitest';

const runClaudeTask = vi.hoisted(() => vi.fn());
vi.mock('../../claude-code/task', () => ({ EDIT_TOOLS: ['Read', 'Edit', 'Bash'], runClaudeTask }));
vi.mock('../../prompts/prompt-loader', () => ({ loadPrompt: (name: string) => `prompt:${name}` }));

import { bashSecurityHook } from '../../security/bash-validator';
import { AgentStillRunningError } from '../../merge/integrate-task';
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

  it('gives up on an agent that hangs: it would hold up every task behind it in the queue', async () => {
    let signal: AbortSignal | undefined;
    runClaudeTask.mockImplementation(async (task: { abortSignal: AbortSignal }) => {
      signal = task.abortSignal;
      return new Promise(() => {});
    });
    await expect(runMergeIntegrator({ ...options, timeoutMs: 5, stopGraceMs: 5 })).rejects.toBeInstanceOf(AgentStillRunningError);
    expect(signal?.aborted).toBe(true);
  });

  it('waits for the session to really end before saying it stopped: a live agent could still commit', async () => {
    let ended = false;
    runClaudeTask.mockImplementation((task: { abortSignal: AbortSignal }) => new Promise((_, reject) => {
      task.abortSignal.addEventListener('abort', () => setTimeout(() => {
        ended = true;
        reject(new Error('Claude task failed (cancelled)'));
      }, 20));
    }));
    await expect(runMergeIntegrator({ ...options, timeoutMs: 5, stopGraceMs: 1000 })).rejects.toThrow(/stopped after/);
    expect(ended).toBe(true);
  });

  it("passes on the call's error: the user has to see why", async () => {
    runClaudeTask.mockRejectedValue(new Error('API Error: 429 busy'));
    await expect(runMergeIntegrator(options)).rejects.toThrow('API Error: 429 busy');
  });
});

describe('the commands the prompt asks for', () => {
  const allowed = (command: string) => !('hookSpecificOutput' in bashSecurityHook({ toolName: 'Bash', toolInput: { command }, cwd: '/wt' }));

  it.each([
    'git status',
    'git log -p main..HEAD -- apps/api/src/ideas/ideas.module.ts',
    'git diff --name-only --diff-filter=U',
    'git add apps/web/src/new-file.ts',
    'pnpm install --frozen-lockfile',
    'pnpm --filter @roadmaply/shared build && pnpm -r --if-present typecheck',
    'pnpm --filter @roadmaply/web test',
    'npm ci',
    'npm test',
    'npx tsc --noEmit',
    'grep -rn "STAMP_DICTIONARY" apps/web/src',
  ])('are not blocked: %s', (command) => {
    expect(allowed(command)).toBe(true);
  });
});
