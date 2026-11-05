import { beforeEach, describe, expect, it, vi } from 'vitest';

const runProcess = vi.fn();
vi.mock('../../../platform/exec', () => ({ runProcess: (...a: unknown[]) => runProcess(...a) }));
vi.mock('../../security/gates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../security/gates')>()),
  resolveBaseRef: vi.fn(async () => 'base-sha'),
}));

import { changedFilesSinceBase, taskTouchesUi, uiChangedSince } from '../qa-browser-scope';

describe('taskTouchesUi', () => {
  it('is true when any changed file is a UI file', () => {
    expect(taskTouchesUi(['src/api/users.ts', 'src/components/Button.tsx'])).toBe(true);
    expect(taskTouchesUi(['src/styles/app.css'])).toBe(true);
    expect(taskTouchesUi(['apps/web/pages/index.vue', 'README.md'])).toBe(true);
  });

  it('is false for backend, config, test and documentation changes', () => {
    expect(taskTouchesUi(['src/api/users.ts', 'src/api/__tests__/users.test.ts', 'package.json', 'docs/api.md', 'prisma/schema.prisma'])).toBe(false);
    expect(taskTouchesUi([])).toBe(false);
  });
});

describe('uiChangedSince', () => {
  it('is undefined when the changed files cannot be listed, so the browser stays on', async () => {
    expect(await uiChangedSince(async () => undefined)).toBeUndefined();
    expect(await uiChangedSince(async () => ['src/App.tsx'])).toBe(true);
    expect(await uiChangedSince(async () => ['src/server.ts'])).toBe(false);
  });
});

describe('changedFilesSinceBase', () => {
  beforeEach(() => {
    runProcess.mockReset().mockResolvedValue({ code: 0, stdout: 'src/App.tsx\n', stderr: '', timedOut: false, aborted: false });
  });

  it('runs git read-only, without external diff tools, and without an inherited GIT_DIR', async () => {
    process.env.GIT_DIR = '/elsewhere/.git';
    try {
      expect(await changedFilesSinceBase('/p')).toEqual(['src/App.tsx', 'src/App.tsx']);
    } finally {
      delete process.env.GIT_DIR;
    }
    expect(runProcess).toHaveBeenCalledTimes(2);
    const [diffArgs, diffOptions] = runProcess.mock.calls[0].slice(1) as [string[], { cwd: string; env: NodeJS.ProcessEnv }];
    expect(diffArgs).toEqual([
      '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', expect.stringMatching(/^core\.hooksPath=/), '--no-optional-locks',
      'diff', '--name-only', '--no-ext-diff', '--no-textconv', '--diff-filter=ACMR', 'base-sha',
    ]);
    expect(diffOptions.cwd).toBe('/p');
    expect(diffOptions.env).toBeDefined();
    expect(diffOptions.env.GIT_DIR).toBeUndefined();
    const [lsArgs, lsOptions] = runProcess.mock.calls[1].slice(1) as [string[], { env: NodeJS.ProcessEnv }];
    expect(lsArgs.slice(-3)).toEqual(['ls-files', '--others', '--exclude-standard']);
    expect(lsArgs).toContain('--no-optional-locks');
    expect(lsOptions.env.GIT_DIR).toBeUndefined();
  });

  it('is undefined when either git call fails', async () => {
    runProcess.mockResolvedValueOnce({ code: 128, stdout: '', stderr: 'fatal', timedOut: false, aborted: false });
    expect(await changedFilesSinceBase('/p')).toBeUndefined();
  });
});
