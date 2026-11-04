/**
 * Merge a task branch with git itself, so that binary and empty files, deletions
 * and the task's history all survive. Only files git can't merge go to the
 * resolver. Whatever goes wrong, the project is left as it was. No Electron imports.
 */

import { execFile } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export interface MergeTaskBranchOptions {
  projectDir: string;
  branch: string;
  baseBranch: string;
  /** The task's worktree: its uncommitted edits to tracked files are part of the task */
  worktreePath?: string;
  message: string;
  /** Leave the result staged for the user to commit */
  stageOnly: boolean;
  /** File path → merged text, for the files git couldn't merge. Missing means unresolved. */
  resolveConflicts: (files: string[]) => Promise<Map<string, string>>;
  git?: string;
  env?: NodeJS.ProcessEnv;
}

export interface MergeTaskBranchResult {
  status: 'merged' | 'staged' | 'up_to_date' | 'conflicts' | 'refused';
  /** Why it was refused, in git's or the hook's words */
  message?: string;
  conflictFiles?: string[];
}

/** Text a resolver must not hand back as a merged file. Pure. */
function isUsableMerge(content: string | undefined): content is string {
  return !!content && !content.includes('\0') && !content.includes('�') && !/^(<{7}|>{7}) /m.test(content);
}

export async function mergeTaskBranch(options: MergeTaskBranchOptions): Promise<MergeTaskBranchResult> {
  const { projectDir, branch, worktreePath, stageOnly, git = 'git', env } = options;
  const baseBranch = options.baseBranch.replace(/^origin\//, '');

  const run = (args: string[], cwd = projectDir) =>
    new Promise<{ ok: boolean; stdout: string; output: string }>((resolve) => {
      execFile(git, args, { cwd, env, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
        resolve({ ok: !error, stdout: stdout.trim(), output: `${stderr}\n${stdout}`.trim() });
      });
    });
  const refused = (message: string): MergeTaskBranchResult => ({ status: 'refused', message });

  const rollBack = async () => {
    await run(['reset', '--merge']);
    const squashMsg = (await run(['rev-parse', '--git-path', 'SQUASH_MSG'])).stdout;
    if (squashMsg) rmSync(isAbsolute(squashMsg) ? squashMsg : join(projectDir, squashMsg), { force: true });
  };

  const current = (await run(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout;
  if (current !== baseBranch) {
    return refused(`The project is on "${current}", and this task merges into "${baseBranch}". Switch to "${baseBranch}" and merge again.`);
  }
  if (!(await run(['rev-parse', '--verify', '--quiet', `${branch}^{commit}`])).ok) {
    return refused(`The task branch "${branch}" was not found.`);
  }

  if (worktreePath && (await run(['status', '--porcelain', '--untracked-files=no'], worktreePath)).stdout) {
    await run(['add', '-u'], worktreePath);
    const saved = await run(['commit', '--no-verify', '-m', 'Changes left uncommitted at merge'], worktreePath);
    if (!saved.ok) return refused(saved.output);
  }

  const merge = await run(['merge', '--no-commit', ...(stageOnly ? ['--squash'] : ['--no-ff']), branch]);
  if (!merge.ok) {
    const conflictFiles = (await run(['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').filter(Boolean);
    // No conflicts means git declined to start, and has changed nothing
    if (!conflictFiles.length) return refused(merge.output);

    let resolved = new Map<string, string>();
    try {
      resolved = await options.resolveConflicts(conflictFiles);
    } catch {
      // Treated as unresolved below
    }
    if (!conflictFiles.every((file) => isUsableMerge(resolved.get(file)))) {
      await rollBack();
      return { status: 'conflicts', conflictFiles };
    }
    for (const file of conflictFiles) writeFileSync(join(projectDir, file), resolved.get(file) as string, 'utf-8');
    const added = await run(['add', '--', ...conflictFiles]);
    if (!added.ok) {
      await rollBack();
      return refused(added.output);
    }
  }

  if (stageOnly) {
    const staged = (await run(['diff', '--cached', '--name-only'])).stdout;
    return { status: staged ? 'staged' : 'up_to_date' };
  }
  if (!(await run(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])).ok) return { status: 'up_to_date' };

  const committed = await run(['commit', '-m', options.message]);
  if (!committed.ok) {
    await rollBack();
    return refused(committed.output);
  }
  // Only a branch that is really in the history may be deleted afterwards
  if (!(await run(['merge-base', '--is-ancestor', branch, 'HEAD'])).ok) {
    return refused(`"${branch}" is not in "${baseBranch}" after the merge commit. The branch was kept.`);
  }
  return { status: 'merged' };
}
