import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRunClaudeTask = vi.fn();
const mockExecFileSync = vi.fn();

vi.mock('../../../claude-code/task', () => ({
  runClaudeTask: (...args: unknown[]) => mockRunClaudeTask(...args),
}));

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

vi.mock('node:fs', () => ({
  existsSync: () => false,
  readFileSync: () => '',
}));

import { type CreatePRConfig, createPR } from '../pr-creator';

const config = (overrides: Partial<CreatePRConfig> = {}): CreatePRConfig => ({
  projectDir: '/repo',
  worktreePath: '/repo/.wt',
  specId: '001-feature',
  branchName: 'feat/x',
  baseBranch: 'origin/main',
  title: 'Add X',
  ghPath: 'gh',
  gitPath: 'git',
  ...overrides,
});

function bodyArg(): string {
  const ghCall = mockExecFileSync.mock.calls.find((c) => c[0] === 'gh');
  const args = ghCall?.[1] as string[];
  return args[args.indexOf('--body') + 1];
}

describe('createPR', () => {
  beforeEach(() => {
    mockRunClaudeTask.mockReset();
    mockExecFileSync.mockReset();
    mockExecFileSync.mockImplementation((cmd: string) =>
      cmd === 'gh' ? 'https://github.com/o/r/pull/1\n' : '',
    );
  });

  it('generates the PR body with Claude and creates the PR', async () => {
    mockRunClaudeTask.mockResolvedValue({ text: '## Summary\nAdds X' });

    const result = await createPR(config({ modelShorthand: 'sonnet', thinkingLevel: 'medium' }));

    expect(result).toEqual({ success: true, prUrl: 'https://github.com/o/r/pull/1', alreadyExists: false });
    const opts = mockRunClaudeTask.mock.calls[0][0];
    expect(opts).toMatchObject({ model: 'sonnet', thinkingLevel: 'medium' });
    expect(opts.tools).toBeUndefined();
    expect(opts.prompt).toContain('Spec ID: 001-feature');
    expect(bodyArg()).toBe('## Summary\nAdds X');
  });

  it('defaults to haiku / low and falls back to the spec summary when Claude fails', async () => {
    mockRunClaudeTask.mockRejectedValue(new Error('auth_failure'));
    const result = await createPR(config());
    expect(result.success).toBe(true);
    expect(mockRunClaudeTask.mock.calls[0][0]).toMatchObject({ model: 'haiku', thinkingLevel: 'low' });
    expect(bodyArg()).toBe('Implements 001-feature');
  });
});
