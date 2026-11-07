/**
 * What a task's changes are measured against: where it left the branch. Against the
 * branch itself, everything merged there later reads as the task deleting it. Git
 * diff from that commit still takes in uncommitted work. No Electron imports.
 */

import { execFileSync } from 'node:child_process';

export function taskDiffBase(git: string, worktreePath: string, baseBranch: string): string {
  try {
    return execFileSync(git, ['merge-base', baseBranch, 'HEAD'], { cwd: worktreePath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim() || baseBranch;
  } catch {
    return baseBranch;
  }
}
