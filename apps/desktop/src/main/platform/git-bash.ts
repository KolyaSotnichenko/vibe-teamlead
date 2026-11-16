/**
 * Git Bash, the bash.exe of Git for Windows. On Windows Claude Code runs its
 * Bash tool with it, and the app runs project commands (checks, previews, dev
 * servers) with it, so the same shell syntax works on every platform.
 * Windows paths are handled with path.win32, and the file check is a
 * parameter, so this is tested on any machine. No Electron.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import { envValue } from './env';

const win = path.win32;

/** bin\bash.exe of the Git installation `gitExePath` belongs to, or null. */
export function deriveGitBashPath(gitExePath: string, exists: (file: string) => boolean = existsSync): string | null {
  const dir = win.dirname(gitExePath);
  const dirName = win.basename(dir).toLowerCase();
  const parent = win.dirname(dir);
  // …\Git\cmd\git.exe, …\Git\bin\git.exe, …\Git\mingw64\bin\git.exe
  const parentName = win.basename(parent).toLowerCase();
  const root = dirName === 'bin' && (parentName === 'mingw64' || parentName === 'mingw32') ? win.dirname(parent) : parent;
  for (const candidate of [win.join(root, 'bin', 'bash.exe'), win.join(win.dirname(root), 'bin', 'bash.exe')]) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

export interface FindGitBashOptions {
  platform: 'darwin' | 'win32' | 'linux';
  env?: NodeJS.ProcessEnv;
  exists?: (file: string) => boolean;
}

/**
 * Git Bash on Windows (null elsewhere, or when Git for Windows is missing): the
 * user's CLAUDE_CODE_GIT_BASH_PATH, then from git.exe on Path, then the
 * standard install folders.
 */
export function findGitBash({ platform, env = process.env, exists = existsSync }: FindGitBashOptions): string | null {
  if (platform !== 'win32') return null;
  const own = envValue(env, 'CLAUDE_CODE_GIT_BASH_PATH');
  if (own && exists(own)) return own;

  for (const dir of (envValue(env, 'PATH') ?? '').split(';')) {
    if (!dir) continue;
    const git = win.join(dir, 'git.exe');
    if (!exists(git)) continue;
    const bash = deriveGitBashPath(git, exists);
    if (bash) return bash;
  }

  const roots = [
    envValue(env, 'ProgramFiles') ?? 'C:\\Program Files',
    envValue(env, 'ProgramW6432'),
    envValue(env, 'ProgramFiles(x86)') ?? 'C:\\Program Files (x86)',
  ].map((dir) => dir && win.join(dir, 'Git'));
  const local = envValue(env, 'LOCALAPPDATA');
  if (local) roots.push(win.join(local, 'Programs', 'Git'));
  const home = envValue(env, 'USERPROFILE');
  if (home) roots.push(win.join(home, 'scoop', 'apps', 'git', 'current'));
  for (const root of roots) {
    if (!root) continue;
    const bash = win.join(root, 'bin', 'bash.exe');
    if (exists(bash)) return bash;
  }
  return null;
}
