/**
 * Merge a task branch with git itself, so that binary and empty files, deletions
 * and the task's history all survive. Only files git can't merge go to the
 * resolver. Whatever goes wrong, the project is left as it was. No Electron imports.
 */

import { execFile } from 'node:child_process';
import { lstatSync, rmSync, writeFileSync } from 'node:fs';
import { devNull } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** The three versions of a text file in conflict, as git holds them */
export interface MergeConflictVersions {
  file: string;
  /** Empty when both sides added the file */
  base: string;
  /** The project's branch */
  ours: string;
  /** The task */
  theirs: string;
}

export interface MergeTaskBranchOptions {
  projectDir: string;
  branch: string;
  baseBranch: string;
  /** The task's worktree: its uncommitted edits to tracked files are part of the task */
  worktreePath?: string;
  message: string;
  /** Leave the result staged for the user to commit */
  stageOnly: boolean;
  /** The merged text of a file git couldn't merge. Nothing means unresolved. */
  resolveConflict: (conflict: MergeConflictVersions) => Promise<string | undefined>;
  git?: string;
  env?: NodeJS.ProcessEnv;
}

export interface MergeTaskBranchResult {
  status: 'merged' | 'staged' | 'up_to_date' | 'conflicts' | 'refused';
  /** Why it was refused, in git's or the hook's words */
  message?: string;
  conflictFiles?: string[];
}

/**
 * Hooks stay off: `core.hooksPath` can point into the repository, so the branch
 * could bring the hooks that run here, outside the limits agents work under.
 */
const NO_HOOKS = ['-c', `core.hooksPath=${devNull}`];

const REGULAR_FILE = new Set(['100644', '100755']);

/** Not text the resolver can read: a null byte, or bytes that aren't valid UTF-8. Pure. */
const isBinary = (content: string) => content.includes('\0') || content.includes('\uFFFD');

/** What a resolver must not hand back as a merged file. Pure. */
function isUsableMerge(content: string | undefined, versions: MergeConflictVersions): content is string {
  if (!content || isBinary(content) || /^(<{7}|>{7}) /m.test(content)) return false;
  return !content.startsWith('```') || versions.ours.startsWith('```') || versions.theirs.startsWith('```');
}

export async function mergeTaskBranch(options: MergeTaskBranchOptions): Promise<MergeTaskBranchResult> {
  const { projectDir, branch, worktreePath, stageOnly, git = 'git', env } = options;
  const baseBranch = options.baseBranch.replace(/^origin\//, '');

  const run = (args: string[], cwd = projectDir) =>
    new Promise<{ ok: boolean; raw: string; stdout: string; output: string }>((resolve) => {
      execFile(git, args, { cwd, env, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
        resolve({ ok: !error, raw: stdout, stdout: stdout.trim(), output: `${stderr}\n${stdout}`.trim() });
      });
    });
  const refused = (message: string): MergeTaskBranchResult => ({ status: 'refused', message });

  const rollBack = async () => {
    await run(['reset', '--merge']);
    const squashMsg = (await run(['rev-parse', '--git-path', 'SQUASH_MSG'])).stdout;
    if (squashMsg) rmSync(isAbsolute(squashMsg) ? squashMsg : join(projectDir, squashMsg), { force: true });
  };

  /** Only text files both sides still have reach the resolver; the rest stay for the user. */
  const resolveOne = async (file: string, versions: Map<string, { mode: string; blob: string }>): Promise<string | undefined> => {
    const ours = versions.get('2');
    const theirs = versions.get('3');
    if (!ours || !theirs || [...versions.values()].some(({ mode }) => !REGULAR_FILE.has(mode))) return undefined;
    if (lstatSync(join(projectDir, file), { throwIfNoEntry: false })?.isSymbolicLink()) return undefined;
    const read = async (blob?: string) => (blob ? (await run(['cat-file', 'blob', blob])).raw : '');
    const conflict = { file, base: await read(versions.get('1')?.blob), ours: await read(ours.blob), theirs: await read(theirs.blob) };
    if (isBinary(conflict.base) || isBinary(conflict.ours) || isBinary(conflict.theirs)) return undefined;
    try {
      const resolved = await options.resolveConflict(conflict);
      if (!isUsableMerge(resolved, conflict)) return undefined;
      return conflict.ours.endsWith('\n') && !resolved.endsWith('\n') ? `${resolved}\n` : resolved;
    } catch {
      return undefined;
    }
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
    const saved = await run([...NO_HOOKS, 'commit', '-m', 'Changes left uncommitted at merge'], worktreePath);
    if (!saved.ok) return refused(saved.output);
  }

  const merge = await run([...NO_HOOKS, 'merge', '--no-commit', ...(stageOnly ? ['--squash'] : ['--no-ff']), branch]);
  if (!merge.ok) {
    // Stage 1 is the base, 2 the project's branch, 3 the task
    const stages = new Map<string, Map<string, { mode: string; blob: string }>>();
    for (const entry of (await run(['ls-files', '--unmerged', '-z'])).raw.split('\0').filter(Boolean)) {
      const [info, file] = entry.split('\t');
      const [mode, blob, stage] = info.split(' ');
      if (!stages.has(file)) stages.set(file, new Map());
      stages.get(file)?.set(stage, { mode, blob });
    }
    const conflictFiles = [...stages.keys()];
    // No conflicts means git declined to start, and has changed nothing
    if (!conflictFiles.length) return refused(merge.output);

    const merged = new Map<string, string>();
    for (const [file, versions] of stages) {
      const resolved = await resolveOne(file, versions);
      if (resolved === undefined) {
        await rollBack();
        return { status: 'conflicts', conflictFiles };
      }
      merged.set(file, resolved);
    }
    for (const [file, content] of merged) writeFileSync(join(projectDir, file), content, 'utf-8');
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

  const committed = await run([...NO_HOOKS, 'commit', '-m', options.message]);
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
