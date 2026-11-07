/**
 * The Preview runs the project from a worktree of the main branch of its own,
 * never from the owner's checkout: what it shows is exactly main, and starting
 * it can't touch the owner's uncommitted work. Detached, since main is checked
 * out elsewhere. No Electron imports.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { getIsolatedGitEnv } from '../utils/git-isolation';

const run = promisify(execFile);

export const PREVIEW_WORKTREE_DIR = '.vibe-teamlead/worktrees/preview';
const LOCKFILES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lockb', 'bun.lock']);

export function previewWorktreePath(projectPath: string): string {
  return join(projectPath, PREVIEW_WORKTREE_DIR);
}

/** Where the preview keeps logs and its list of servers: inside the worktree, so a crashed run's servers are found there. */
export function previewSpecDir(worktree: string): string {
  return join(worktree, '.vibe-teamlead', 'specs', 'preview');
}

async function git(gitBin: string, cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run(gitBin, args, { cwd, env: getIsolatedGitEnv(), maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

/** Creates the worktree at mainBranch, or moves it there. lockfileChanged: dependencies need installing. */
export async function syncPreviewWorktree(projectPath: string, mainBranch: string, gitBin: string): Promise<{ path: string; lockfileChanged: boolean }> {
  const path = previewWorktreePath(projectPath);
  const target = await git(gitBin, projectPath, ['rev-parse', '--verify', `${mainBranch}^{commit}`]);

  if (!existsSync(join(path, '.git'))) {
    await git(gitBin, projectPath, ['worktree', 'prune']);
    await git(gitBin, projectPath, ['worktree', 'add', '--detach', '--force', path, target]);
    return { path, lockfileChanged: true };
  }

  const current = await git(gitBin, path, ['rev-parse', 'HEAD']);
  if (current === target) return { path, lockfileChanged: false };
  await git(gitBin, path, ['checkout', '--detach', '--force', target]);
  const changed = (await git(gitBin, path, ['diff', '--name-only', current, target])).split('\n');
  return { path, lockfileChanged: changed.some((file) => LOCKFILES.has(file.split('/').pop() ?? '')) };
}
