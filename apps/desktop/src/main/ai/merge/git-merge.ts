/**
 * Merge a task branch with git itself, so that binary and empty files, deletions
 * and the task's history all survive. Only files git can't merge go to the
 * resolver. Whatever goes wrong, the project is left as it was. No Electron imports.
 */

import { execFile } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { devNull } from 'node:os';
import { dirname, isAbsolute, join, sep } from 'node:path';

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
  /** The merged text of a file git couldn't merge. Nothing means unresolved. */
  resolveConflict: (conflict: MergeConflictVersions) => Promise<string | undefined>;
  git?: string;
  env?: NodeJS.ProcessEnv;
}

export interface MergeTaskBranchResult {
  /** needs_review: the model resolved conflicts; staged, with the merge left open for the user */
  status: 'merged' | 'staged' | 'up_to_date' | 'needs_review' | 'cancelled' | 'conflicts' | 'refused';
  /** Why it was refused, in git's or the hook's words; for conflicts, why they stayed */
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

/** In the git directory: agents can't reach it, and git never commits it */
const MERGE_REVIEW_FILE = 'vibe-teamlead-merge-review.json';

const REGULAR_FILE = new Set(['100644', '100755']);

/** Not text the resolver can read: a null byte, or bytes that aren't valid UTF-8. Pure. */
const isBinary = (content: string) => content.includes('\0') || content.includes('\uFFFD');

const hasOuterFence = (versions: MergeConflictVersions) => versions.ours.startsWith('```') || versions.theirs.startsWith('```');

/**
 * The file out of a code fence around the whole answer, which models add despite
 * being told not to. A fence inside it leaves the answer as it is: what is the file
 * and what is a talk about it can't be told apart. Pure.
 */
function withoutOuterFence(content: string, versions: MergeConflictVersions): string {
  if (hasOuterFence(versions)) return content;
  const inner = /^```[^\n]*\n([\s\S]*\n)?```\s*$/.exec(content);
  return inner && !/^```/m.test(inner[1] ?? '') ? (inner[1] ?? '') : content;
}

/** Why a resolver's answer can't be the merged file, if so. Pure. */
function whyUnusable(content: string | undefined, versions: MergeConflictVersions): string | undefined {
  if (!content) return 'the model returned nothing';
  if (isBinary(content)) return 'the answer is not plain text';
  if (/^(<{7}|>{7}) /m.test(content)) return 'the answer still has conflict markers';
  if (content.startsWith('```') && !hasOuterFence(versions)) return 'the answer has code fences besides the file';
  return undefined;
}

const MAX_REASON_CHARS = 300;
const ONLY_A_PERSON = 'only a person can merge this kind of file';

type GitRun = ReturnType<typeof gitRunner>;

function gitRunner(projectDir: string, git: string, baseEnv: NodeJS.ProcessEnv) {
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
async function gitPath(run: GitRun, projectDir: string, name: string): Promise<string> {
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
  rmSync(await gitPath(run, projectDir, MERGE_REVIEW_FILE), { force: true });
  return true;
}

export interface MergeReviewOptions {
  projectDir: string;
  branch: string;
  git?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * The merge waiting for the user's decision, if any. It lives in git's own state,
 * so it survives a restart, and ends by itself if the user finishes or drops the
 * merge in a terminal. A merge of anything but this branch is not this task's.
 */
export async function getMergeReview(options: MergeReviewOptions): Promise<{ files: string[] } | null> {
  const { projectDir, branch, git = 'git', env = process.env } = options;
  const run = gitRunner(projectDir, git, env);
  const merging = await run(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']);
  const tip = await run(['rev-parse', '--verify', '--quiet', `${branch}^{commit}`]);
  if (!merging.ok || !tip.ok || merging.stdout !== tip.stdout) return null;
  try {
    const { files } = JSON.parse(readFileSync(await gitPath(run, projectDir, MERGE_REVIEW_FILE), 'utf-8')) as { files?: unknown };
    return Array.isArray(files) && files.every((file) => typeof file === 'string') ? { files } : null;
  } catch {
    return null;
  }
}

const NOTHING_TO_REVIEW = 'No merge is waiting for review. It may have been finished or dropped outside the app.';

/** The user confirmed: the merge commit, with the files as they are now, the user's edits included. */
export async function commitMergeReview(options: MergeReviewOptions & { message: string }): Promise<MergeTaskBranchResult> {
  const { projectDir, branch, message, git = 'git', env = process.env } = options;
  const review = await getMergeReview(options);
  if (!review) return refused(NOTHING_TO_REVIEW);
  const run = gitRunner(projectDir, git, env);
  const added = await run(['--literal-pathspecs', 'add', '--', ...review.files]);
  if (!added.ok) return refused(added.output);
  const body = `\n\nConflicts resolved by the model, then confirmed:\n${review.files.map((file) => `- ${file}`).join('\n')}`;
  const committed = await run(['commit', '-m', `${message}${body}`]);
  if (!committed.ok) return refused(committed.output);
  rmSync(await gitPath(run, projectDir, MERGE_REVIEW_FILE), { force: true });
  // Only a branch that is really in the history may be deleted afterwards
  if (!(await run(['merge-base', '--is-ancestor', branch, 'HEAD'])).ok) {
    return refused(`"${branch}" is not in the history after the merge commit. The branch was kept.`);
  }
  return { status: 'merged' };
}

/** The user declined: the project goes back to how it was before the merge. */
export async function cancelMergeReview(options: MergeReviewOptions): Promise<MergeTaskBranchResult> {
  const { projectDir, git = 'git', env = process.env } = options;
  if (!(await getMergeReview(options))) return refused(NOTHING_TO_REVIEW);
  return (await rollBackMerge(gitRunner(projectDir, git, env), projectDir)) ? { status: 'cancelled' } : refused(STILL_OPEN);
}

const MAX_DIFF_CHARS = 256 * 1024;

/**
 * A reviewed file against the project's branch (what the merge changes there) or
 * the task (what the model changed in its version), with the user's edits. Only
 * files in the review. Plain diff: a branch's .gitattributes can't pick a driver
 * or call the file binary to hide its text.
 */
export async function getMergeReviewDiff(
  options: MergeReviewOptions & { file: string; against: 'project' | 'task' },
): Promise<{ diff: string; truncated: boolean } | null> {
  const { projectDir, file, against, git = 'git', env = process.env } = options;
  const review = await getMergeReview(options);
  if (!review?.files.includes(file)) return null;
  const run = gitRunner(projectDir, git, env);
  const result = await run([
    '--literal-pathspecs', 'diff', '--text', '--no-color', '--no-ext-diff', '--no-textconv',
    against === 'project' ? 'HEAD' : 'MERGE_HEAD', '--', file,
  ]);
  if (!result.ok) return null;
  const truncated = result.raw.length > MAX_DIFF_CHARS;
  return { diff: truncated ? result.raw.slice(0, MAX_DIFF_CHARS) : result.raw, truncated };
}

export async function mergeTaskBranch(options: MergeTaskBranchOptions): Promise<MergeTaskBranchResult> {
  const { projectDir, branch, worktreePath, stageOnly, git = 'git' } = options;
  const env = options.env ?? process.env;
  const baseBranch = options.baseBranch.replace(/^origin\//, '');

  const run = gitRunner(projectDir, git, env);
  /** Undo the merge and report `result`, unless the merge is still open: then that is what the user must hear. */
  const undoThen = async (result: MergeTaskBranchResult) => ((await rollBackMerge(run, projectDir)) ? result : refused(STILL_OPEN));

  const isPlainFileInProject = (file: string) => {
    const target = join(projectDir, file);
    const root = realpathSync(projectDir);
    const parent = realpathSync(dirname(target));
    return (parent === root || parent.startsWith(`${root}${sep}`)) && !lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink();
  };

  /** Only text files both sides still have reach the resolver; the rest stay for the user. */
  const resolveOne = async (file: string, versions: Map<string, { mode: string; blob: string }>): Promise<{ merged: string } | { why: string }> => {
    const ours = versions.get('2');
    const theirs = versions.get('3');
    if (!ours || !theirs || [...versions.values()].some(({ mode }) => !REGULAR_FILE.has(mode))) return { why: ONLY_A_PERSON };
    const read = async (blob?: string) => (blob ? (await run(['cat-file', 'blob', blob])).raw : '');
    const conflict = { file, base: await read(versions.get('1')?.blob), ours: await read(ours.blob), theirs: await read(theirs.blob) };
    if (isBinary(conflict.base) || isBinary(conflict.ours) || isBinary(conflict.theirs)) return { why: ONLY_A_PERSON };
    try {
      if (!isPlainFileInProject(file)) return { why: ONLY_A_PERSON };
      const answer = await options.resolveConflict(conflict);
      const resolved = answer && withoutOuterFence(answer, conflict);
      const why = whyUnusable(resolved, conflict);
      if (why || !resolved) return { why: why ?? 'the model returned nothing' };
      return { merged: conflict.ours.endsWith('\n') && !resolved.endsWith('\n') ? `${resolved}\n` : resolved };
    } catch (error) {
      return { why: (error instanceof Error ? error.message : String(error)).slice(0, MAX_REASON_CHARS) };
    }
  };

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
  // No merge is open, so a review mark is left from one dropped outside the app: it must not vouch for this one
  rmSync(await gitPath(run, projectDir, MERGE_REVIEW_FILE), { force: true });

  if (worktreePath && (await run(['status', '--porcelain', '--untracked-files=no'], worktreePath)).stdout) {
    if (!(await options.uncommittedApproved?.())) {
      const files = (await run(['diff', '--name-only', 'HEAD'], worktreePath)).stdout.split('\n').filter(Boolean);
      const shown = files.slice(0, 10).join(', ') + (files.length > 10 ? ` and ${files.length - 10} more` : '');
      return refused(`The task's folder has uncommitted changes QA did not review: ${shown}. Nothing was changed. Commit them on the task branch if you want them, or discard them, then merge again.`);
    }
    await run(['add', '-u'], worktreePath);
    const saved = await run(['commit', '-m', 'Changes left uncommitted at merge'], worktreePath);
    if (!saved.ok) return refused(saved.output);
  }

  let resolvedByModel: string[] = [];
  const merge = await run(['merge', '--no-commit', ...(stageOnly ? ['--squash'] : ['--no-ff']), branch]);
  if (!merge.ok) {
    // Stage 1 is the base, 2 the project's branch, 3 the task
    const stages = new Map<string, Map<string, { mode: string; blob: string }>>();
    for (const entry of (await run(['ls-files', '--unmerged', '-z'])).raw.split('\0').filter(Boolean)) {
      // Only the first tab separates: a file name can hold one
      const tab = entry.indexOf('\t');
      const info = entry.slice(0, tab);
      const file = entry.slice(tab + 1);
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
      if ('why' in resolved) return undoThen({ status: 'conflicts', conflictFiles, message: `${file}: ${resolved.why.replace(/\.$/, '')}` });
      merged.set(file, resolved.merged);
    }
    try {
      for (const [file, content] of merged) writeFileSync(join(projectDir, file), content, 'utf-8');
    } catch (error) {
      return undoThen(refused(error instanceof Error ? error.message : String(error)));
    }
    resolvedByModel = conflictFiles;
    const added = await run(['--literal-pathspecs', 'add', '--', ...conflictFiles]);
    if (!added.ok) return undoThen(refused(added.output));
  }

  if (stageOnly) {
    const staged = (await run(['diff', '--cached', '--name-only'])).stdout;
    return { status: staged ? 'staged' : 'up_to_date' };
  }
  if (!(await run(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])).ok) return { status: 'up_to_date' };

  // No one has read what the model wrote: the commit waits for the user
  if (resolvedByModel.length) {
    try {
      writeFileSync(await gitPath(run, projectDir, MERGE_REVIEW_FILE), JSON.stringify({ files: resolvedByModel }), 'utf-8');
    } catch (error) {
      return undoThen(refused(error instanceof Error ? error.message : String(error)));
    }
    return { status: 'needs_review', conflictFiles: resolvedByModel };
  }

  const committed = await run(['commit', '-m', options.message]);
  if (!committed.ok) return undoThen(refused(committed.output));
  // Only a branch that is really in the history may be deleted afterwards
  if (!(await run(['merge-base', '--is-ancestor', branch, 'HEAD'])).ok) {
    return refused(`"${branch}" is not in "${baseBranch}" after the merge commit. The branch was kept.`);
  }
  return { status: 'merged' };
}
