/**
 * Did the QA reviewer change project files? The PreToolUse hook keeps its
 * Write/Edit tools in the spec directory, but Bash can write anywhere, so the
 * QA loop takes a snapshot of the worktree before and after each reviewer
 * session and compares content: HEAD plus, for every path git status lists,
 * a hash of the working-tree file. Nothing is reverted; the files are
 * reported. No Electron imports.
 */

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { devNull } from 'node:os';
import { join, relative } from 'node:path';

import { runProcess } from '../../platform/exec';

export interface WorkTreeSnapshot {
  /** HEAD commit */
  head: string;
  /** Every path git status lists → hash of its working-tree content ("deleted" when gone) */
  files: Record<string, string>;
}

export type SnapshotResult = WorkTreeSnapshot | { error: string };

/** A file this big is hashed by size and time instead of content. */
const MAX_HASHED_FILE = 64 * 1024 * 1024;

/**
 * Git arguments for a read-only query of a worktree agents are working in:
 * no file system monitor or untracked cache (they can lag), no hooks, and no
 * index refresh that would take the lock from a concurrent git.
 */
export function readOnlyGitArgs(args: string[]): string[] {
  return ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', `core.hooksPath=${devNull}`, '--no-optional-locks', ...args];
}

/** The paths in `git status --porcelain=v1 -z` output; a rename entry carries two. Pure. */
export function parsePorcelainZ(output: string): string[] {
  const entries = output.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    // Renames and copies: the original path follows as its own NUL-terminated field
    if (/[RC]/.test(entry.slice(0, 2))) {
      const original = entries[++i];
      if (original) paths.push(original);
    }
  }
  return paths;
}

/** git's stdout is kept up to this many characters; output that long is not a complete listing. */
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;

/**
 * What the working tree holds at a path: a content hash, a link target,
 * "deleted", or the mode of a FIFO, socket or device, which is never read (a
 * synchronous read of a FIFO blocks until something writes to it). A
 * directory (a nested repository or submodule) has no content to hash.
 */
function contentHash(file: string): string | { directory: true } {
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return 'deleted';
  if (stat.isSymbolicLink()) return `link:${readlinkSync(file)}`;
  if (stat.isDirectory()) return { directory: true };
  if (!stat.isFile()) return `special:${stat.mode}`;
  if (stat.size > MAX_HASHED_FILE) return `big:${stat.size}:${stat.mtimeMs}`;
  try {
    return createHash('sha1').update(readFileSync(file)).digest('hex');
  } catch {
    return 'unreadable';
  }
}

/** The error of a git query that did not complete, or undefined. */
function gitFailure(name: string, result: Awaited<ReturnType<typeof runProcess>>): string | undefined {
  if (result.error) return `${name} could not start: ${result.error}`;
  if (result.timedOut) return `${name} timed out`;
  if (result.code !== 0) return `${name} exited with code ${result.code}${result.stderr.trim() ? `: ${result.stderr.trim().split('\n').pop()}` : ''}`;
  // runProcess keeps the first maxOutput characters silently; a listing that long is cut off
  if (result.stdout.length >= MAX_GIT_OUTPUT) return `${name} output was truncated`;
  return undefined;
}

const gitQuery = (cwd: string, args: string[]) => runProcess('git', readOnlyGitArgs(args), { cwd, timeoutMs: 60_000, maxOutput: MAX_GIT_OUTPUT });

/** HEAD and the content of every path git status lists; an error when git can't say. */
export async function takeWorkTreeSnapshot(cwd: string): Promise<SnapshotResult> {
  const [head, status] = await Promise.all([gitQuery(cwd, ['rev-parse', 'HEAD']), gitQuery(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])]);
  for (const [name, result] of [['git rev-parse', head], ['git status', status]] as const) {
    const error = gitFailure(name, result);
    if (error) return { error };
  }
  const files: Record<string, string> = Object.create(null);
  for (const path of parsePorcelainZ(status.stdout)) {
    const hash = contentHash(join(cwd, path));
    if (typeof hash !== 'string') return { error: `submodule or directory entry: ${path}` };
    files[path] = hash;
  }
  return { head: head.stdout.trim(), files };
}

/**
 * The files a commit range touched: what a reviewer commit took out of git
 * status. undefined when git can't say (then the loop reports "unknown").
 */
export async function listCommittedFiles(cwd: string, from: string, to: string): Promise<string[] | undefined> {
  const diff = await gitQuery(cwd, ['diff', '--name-only', '--no-ext-diff', '--no-textconv', '-z', from, to]);
  if (gitFailure('git diff', diff)) return undefined;
  return diff.stdout.split('\0').filter(Boolean);
}

/**
 * The paths whose content differs between two snapshots, plus the files of
 * the commit the reviewer made when HEAD moved (they no longer show in git
 * status), leaving out the task's spec directory and the worktree's root
 * `.vibe-teamlead/` folder. Pure — tested directly.
 */
export function reviewerChangedFiles(
  before: WorkTreeSnapshot,
  after: WorkTreeSnapshot,
  dirs: { projectDir: string; specDir: string },
  committed: string[] = [],
): { files: string[]; headMoved: boolean } {
  const specRel = relative(dirs.projectDir, dirs.specDir).replace(/\\/g, '/');
  const excluded = (file: string) => {
    const path = file.replace(/\\/g, '/');
    return /^\.vibe-teamlead\//.test(path) || (!specRel.startsWith('..') && (path === specRel || path.startsWith(`${specRel}/`)));
  };
  const files: string[] = [];
  for (const file of new Set([...Object.keys(before.files), ...Object.keys(after.files)])) {
    if (before.files[file] !== after.files[file] && !excluded(file)) files.push(file);
  }
  for (const file of committed) if (!excluded(file) && !files.includes(file)) files.push(file);
  return { files, headMoved: before.head !== after.head };
}
