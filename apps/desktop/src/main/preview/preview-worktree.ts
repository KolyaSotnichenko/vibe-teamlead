/**
 * The Preview runs the project from a worktree of the main branch of its own,
 * never from the owner's checkout: what it shows is exactly main, and starting
 * it can't touch the owner's uncommitted work. Detached, since main is checked
 * out elsewhere. It lives in the app's folder, outside the project, so nothing
 * that looks upwards for a `.env` (python-dotenv does) finds the owner's real
 * one. No Electron imports.
 */

import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { getIsolatedGitEnv } from '../utils/git-isolation';

const run = promisify(execFile);

const LOCKFILES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lockb', 'bun.lock']);

/** `root` is …/.vibe-teamlead/worktrees/preview in the app's folder: dev-servers finds leftovers under it. */
export function previewWorktreePath(root: string, projectId: string): string {
  return join(root, projectId.replace(/[^\w.-]/g, '_'));
}

/** Where the preview keeps logs and its list of servers: inside the worktree, so a crashed run's servers are found there. */
export function previewSpecDir(worktree: string): string {
  return join(worktree, '.vibe-teamlead', 'specs', 'preview');
}

async function git(gitBin: string, cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run(gitBin, args, { cwd, env: getIsolatedGitEnv(), maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

/** Creates the worktree at `path` on mainBranch, or moves it there. lockfileChanged: dependencies need installing. moved: the code changed. */
export async function syncPreviewWorktree(projectPath: string, mainBranch: string, gitBin: string, path: string): Promise<{ path: string; lockfileChanged: boolean; moved: boolean }> {
  const target = await git(gitBin, projectPath, ['rev-parse', '--verify', `${mainBranch}^{commit}`]);

  if (!existsSync(join(path, '.git'))) {
    await git(gitBin, projectPath, ['worktree', 'prune']);
    await git(gitBin, projectPath, ['worktree', 'add', '--detach', '--force', path, target]);
    return { path, lockfileChanged: true, moved: true };
  }

  const current = await git(gitBin, path, ['rev-parse', 'HEAD']);
  if (current === target) return { path, lockfileChanged: false, moved: false };
  await git(gitBin, path, ['checkout', '--detach', '--force', target]);
  const changed = (await git(gitBin, path, ['diff', '--name-only', current, target])).split('\n');
  return { path, lockfileChanged: changed.some((file) => LOCKFILES.has(file.split('/').pop() ?? '')), moved: true };
}

/**
 * At app start: dev servers a crashed preview left running, in every preview
 * worktree. Best effort.
 */
export function cleanUpPreviewLeftovers(root: string, cleanUp: (specDir: string) => void): void {
  let names: string[];
  try {
    names = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return;
  }
  for (const name of names) cleanUp(previewSpecDir(join(root, name)));
}
