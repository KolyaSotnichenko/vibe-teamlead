import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// The checks run through the platform's shell (Git Bash on Windows): what runShell
// reports for a missing Git for Windows is a missing tool, not the task failing.
const runShell = vi.hoisted(() => vi.fn());
vi.mock('../../../platform/exec', async (original) => ({ ...(await original<typeof import('../../../platform/exec')>()), runShell }));

import { verifyTask } from '../verify-task';

describe('verifyTask runs checks through the platform shell', () => {
  it('passes each check command to runShell, and a missing shell makes the check unavailable', async () => {
    const message = 'Git for Windows is required to run commands on Windows';
    // As runShell does: the reason also goes to the line callback
    runShell.mockImplementation(async (_command: string, options: { onLine?: (line: string) => void }) => {
      options.onLine?.(message);
      return { code: 127, stdout: '', stderr: message, timedOut: false, aborted: false, error: message };
    });
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'vtl-verify-shell-')));
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'first');
    const wt = join(repo, 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'task', wt);
    writeFileSync(join(wt, 'b.txt'), 'b\n');
    git(wt, 'add', '-A');
    git(wt, 'commit', '-q', '-m', 'task');

    const report = await verifyTask({ worktreePath: wt, baseRef: 'main', commands: ['npm test'], env: {}, lockDir: join(repo, '.git', 'verify-lock') });

    expect(runShell).toHaveBeenCalledWith('npm test', expect.objectContaining({ killGroup: true }));
    expect(report.checks[0].outcome).toBe('unavailable');
    expect(report.checks[0].tail).toContain('Git for Windows');
  });
});
