/**
 * Merge a task branch with git itself, so that binary and empty files, deletions
 * and the task's history all survive. Conflicts are solved before this, in the
 * task's folder (integrate-task.ts): a conflict here means the project's branch
 * moved a moment ago. Whatever goes wrong, the project is left as it was. No
 * Electron imports.
 */

import { execFile } from 'node:child_process';
import { rmSync } from 'node:fs';
import { devNull } from 'node:os';
import { isAbsolute, join } from 'node:path';

export interface MergeTaskBranchOptions {
  projectDir: string;
  branch: string;
  baseBranch: string;
  /** The task's worktree */
  worktreePath?: string;
  /**
   * Whether QA approved the worktree exactly as it is now: only then are its
   * uncommitted edits part of the task. Anything else may be what nobody has read.
   */
  uncommittedApproved?: () => Promise<boolean>;
  message: string;
  /** Leave the result staged for the user to commit */
  stageOnly: boolean;
  git?: string;
  env?: NodeJS.ProcessEnv;
}

export interface MergeTaskBranchResult {
  status: 'merged' | 'staged' | 'up_to_date' | 'conflicts' | 'refused';
  /** Why it was refused, in git's or the hook's words; for conflicts, what happened */
  message?: string;
  conflictFiles?: string[];
}

/**
 * The environment for git commands that must run no hooks: `core.hooksPath` can
 * point into the repository, so a merged branch could bring the hooks that run
 * here, outside the limits agents work under. Set in the environment so that
 * every command is covered, including ref updates (reference-transaction). Pure.
 */
export function withoutGitHooks(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const index = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10) || 0;
  return {
    ...env,
    GIT_CONFIG_COUNT: String(index + 1),
    [`GIT_CONFIG_KEY_${index}`]: 'core.hooksPath',
    [`GIT_CONFIG_VALUE_${index}`]: devNull,
  };
}

export type GitRun = ReturnType<typeof gitRunner>;

export function gitRunner(projectDir: string, git: string, baseEnv: NodeJS.ProcessEnv) {
  const env = withoutGitHooks(baseEnv);
  return (args: string[], cwd = projectDir) =>
    new Promise<{ ok: boolean; raw: string; stdout: string; output: string }>((resolve) => {
      execFile(git, args, { cwd, env, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
        resolve({ ok: !error, raw: stdout, stdout: stdout.trim(), output: `${stderr}\n${stdout}`.trim() });
      });
    });
}

const refused = (message: string): MergeTaskBranchResult => ({ status: 'refused', message });

/** A file inside the repository's git directory. */
export async function gitPath(run: GitRun, projectDir: string, name: string): Promise<string> {
  const raw = (await run(['rev-parse', '--git-path', name])).stdout;
  return isAbsolute(raw) ? raw : join(projectDir, raw);
}

const ROLLBACK_ATTEMPTS = 5;
const ROLLBACK_WAIT_MS = 200;
const STILL_OPEN = 'The merge could not be undone, so the project is still in the middle of it. Nothing is committed. Run "git reset --merge" in the project, then try again.';

/** False when git could not undo the merge: another git command can hold the index for a moment. */
async function rollBackMerge(run: GitRun, projectDir: string): Promise<boolean> {
  let undone = false;
  for (let attempt = 0; attempt < ROLLBACK_ATTEMPTS && !undone; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, ROLLBACK_WAIT_MS));
    undone = (await run(['reset', '--merge'])).ok;
  }
  if (!undone) return false;
  rmSync(await gitPath(run, projectDir, 'SQUASH_MSG'), { force: true });
  return true;
}

/** What stops this task merging into the project right now, if anything. Changes nothing. */
export async function mergeBlocker(options: Pick<MergeTaskBranchOptions, 'projectDir' | 'branch' | 'baseBranch' | 'git' | 'env'>): Promise<MergeTaskBranchResult | undefined> {
  const { projectDir, branch, git = 'git' } = options;
  const baseBranch = options.baseBranch.replace(/^origin\//, '');
  const run = gitRunner(projectDir, git, options.env ?? process.env);
  const current = (await run(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout;
  if (current !== baseBranch) {
    return refused(`The project is on "${current}", and this task merges into "${baseBranch}". Switch to "${baseBranch}" and merge again.`);
  }
  if (!(await run(['rev-parse', '--verify', '--quiet', `${branch}^{commit}`])).ok) {
    return refused(`The task branch "${branch}" was not found.`);
  }
  // Its conflicts aren't this task's to resolve, and undoing them would lose someone's work
  const merging = (await run(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])).ok;
  if (merging || (await run(['ls-files', '--unmerged'])).stdout) {
    return refused('The project is already in the middle of a merge. Finish it, or drop it with "git merge --abort", and merge again.');
  }
  return undefined;
}

/** Commits the worktree's edits if they are approved. Anything else may be what nobody has read: then a refusal. */
export async function saveApprovedChanges(options: Pick<MergeTaskBranchOptions, 'projectDir' | 'worktreePath' | 'uncommittedApproved' | 'git' | 'env'>): Promise<MergeTaskBranchResult | undefined> {
  const { projectDir, worktreePath, git = 'git' } = options;
  if (!worktreePath) return undefined;
  const run = gitRunner(projectDir, git, options.env ?? process.env);
  if (!(await run(['status', '--porcelain', '--untracked-files=no'], worktreePath)).stdout) return undefined;
  if (!(await options.uncommittedApproved?.())) {
    const files = (await run(['diff', '--name-only', 'HEAD'], worktreePath)).stdout.split('\n').filter(Boolean);
    const shown = files.slice(0, 10).join(', ') + (files.length > 10 ? ` and ${files.length - 10} more` : '');
    return refused(`The task's folder has uncommitted changes QA did not review: ${shown}. Nothing was changed. Commit them on the task branch if you want them, or discard them, then merge again.`);
  }
  await run(['add', '-u'], worktreePath);
  const saved = await run(['commit', '-m', 'Changes left uncommitted at merge'], worktreePath);
  return saved.ok ? undefined : refused(saved.output);
}

export async function mergeTaskBranch(options: MergeTaskBranchOptions): Promise<MergeTaskBranchResult> {
  const { projectDir, branch, stageOnly, git = 'git' } = options;
  const baseBranch = options.baseBranch.replace(/^origin\//, '');
  const run = gitRunner(projectDir, git, options.env ?? process.env);
  /** Undo the merge and report `result`, unless the merge is still open: then that is what the user must hear. */
  const undoThen = async (result: MergeTaskBranchResult) => ((await rollBackMerge(run, projectDir)) ? result : refused(STILL_OPEN));

  const blocked = (await mergeBlocker(options)) ?? (await saveApprovedChanges(options));
  if (blocked) return blocked;

  const merge = await run(['merge', '--no-commit', ...(stageOnly ? ['--squash'] : ['--no-ff']), branch]);
  if (!merge.ok) {
    const unmerged = (await run(['diff', '--name-only', '--diff-filter=U', '-z'])).raw.split('\0').filter(Boolean);
    // No conflicts means git declined to start, and has changed nothing
    if (!unmerged.length) return refused(merge.output);
    return undoThen({ status: 'conflicts', conflictFiles: unmerged, message: `"${baseBranch}" changed during the merge` });
  }

  if (stageOnly) {
    const staged = (await run(['diff', '--cached', '--name-only'])).stdout;
    return { status: staged ? 'staged' : 'up_to_date' };
  }
  if (!(await run(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])).ok) return { status: 'up_to_date' };

  const committed = await run(['commit', '-m', options.message]);
  if (!committed.ok) return undoThen(refused(committed.output));
  // Only a branch that is really in the history may be deleted afterwards
  if (!(await run(['merge-base', '--is-ancestor', branch, 'HEAD'])).ok) {
    return refused(`"${branch}" is not in "${baseBranch}" after the merge commit. The branch was kept.`);
  }
  return { status: 'merged' };
}
