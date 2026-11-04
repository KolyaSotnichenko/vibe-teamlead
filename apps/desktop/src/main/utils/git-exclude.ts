/**
 * Keep something the app creates in a project out of git without touching the
 * project's files: .git/info/exclude is local and shared by its worktrees. No
 * Electron imports.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

export function excludeFromGit(projectDir: string, entry: string): void {
  try {
    const raw = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], {
      cwd: projectDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const excludePath = isAbsolute(raw) ? raw : join(projectDir, raw);
    const current = existsSync(excludePath) ? readFileSync(excludePath, 'utf-8') : '';
    if (current.split('\n').some((line) => line.trim() === entry)) return;
    mkdirSync(dirname(excludePath), { recursive: true });
    appendFileSync(excludePath, `${current && !current.endsWith('\n') ? '\n' : ''}${entry}\n`);
  } catch {
    // Not a git repository: nothing to exclude from.
  }
}
