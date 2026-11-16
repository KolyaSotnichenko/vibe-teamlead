import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ key: 'darwin' as 'darwin' | 'win32' | 'linux' }));
vi.mock('../../../platform', async (original) => ({
  ...(await original<typeof import('../../../platform')>()),
  getPlatformKey: () => platform.key,
}));

import { createOrGetWorktree, gitSubcommand } from '../worktree-manager';

let project: string;
const longpaths = (cwd: string) => {
  try {
    return execFileSync('git', ['config', '--get', 'core.longpaths'], { cwd, stdio: 'pipe' }).toString().trim();
  } catch {
    return '';
  }
};

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  project = realpathSync(mkdtempSync(path.join(tmpdir(), 'wt-longpaths-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: project, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  writeFileSync(path.join(project, '.gitignore'), '.vibe-teamlead/\n');
  writeFileSync(path.join(project, 'README.md'), '# P\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
});
afterEach(() => {
  vi.restoreAllMocks();
  platform.key = 'darwin';
  rmSync(project, { recursive: true, force: true });
});

describe('task worktrees and long paths', () => {
  it('on Windows a new worktree has core.longpaths (paths past 260 characters)', async () => {
    platform.key = 'win32';
    const { worktreePath } = await createOrGetWorktree(project, '001-task', 'main', true, false);
    expect(longpaths(worktreePath)).toBe('true');
  });

  it('on macOS the git config is left alone', async () => {
    const { worktreePath } = await createOrGetWorktree(project, '002-task', 'main', true, false);
    expect(longpaths(worktreePath)).toBe('');
  });

  it('on Windows reuses the worktree on the next call instead of adding it again', async () => {
    platform.key = 'win32';
    const first = await createOrGetWorktree(project, '003-task', 'main', true, false);
    writeFileSync(path.join(first.worktreePath, 'work.txt'), 'uncommitted\n');
    const again = await createOrGetWorktree(project, '003-task', 'main', true, false);
    expect(again.worktreePath).toBe(first.worktreePath);
    expect(readFileSync(path.join(again.worktreePath, 'work.txt'), 'utf-8')).toBe('uncommitted\n');
  });

  it('names the git sub-command in errors, past the -c options Windows adds', () => {
    expect(gitSubcommand(['-c', 'core.longpaths=true', 'worktree', 'add', 'w'])).toBe('worktree');
    expect(gitSubcommand(['worktree', 'prune'])).toBe('worktree');
  });
});
