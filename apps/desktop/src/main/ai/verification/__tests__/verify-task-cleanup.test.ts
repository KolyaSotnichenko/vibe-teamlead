import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

const { rmSyncCalls } = vi.hoisted(() => ({ rmSyncCalls: [] as string[] }));
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return {
    ...actual,
    rmSync: (path: string, options?: object) => {
      rmSyncCalls.push(String(path));
      return actual.rmSync(path, options as never);
    },
  };
});

import { verifyTask } from '../verify-task';

it("doesn't hold up the app while removing its copy: a real one has tens of thousands of files", async () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'vtl-cleanup-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  writeFileSync(join(repo, 'good.txt'), 'yes\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'first');

  const report = await verifyTask({ worktreePath: repo, baseRef: 'main', commands: ['test -f good.txt'], env: {}, lockDir: join(repo, '.git', 'verify-lock') });

  expect(report.status).toBe('passed');
  expect(rmSyncCalls.filter((path) => path.includes('vibe-teamlead-verify-'))).toEqual([]);
});
