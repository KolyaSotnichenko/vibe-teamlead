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

/** What the working tree holds at a path: a content hash, a link target, or "deleted". */
function contentHash(file: string): string {
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return 'deleted';
  if (stat.isSymbolicLink()) return `link:${readlinkSync(file)}`;
  if (stat.isDirectory()) return 'directory';
  if (stat.size > MAX_HASHED_FILE) return `big:${stat.size}:${stat.mtimeMs}`;
  try {
    return createHash('sha1').update(readFileSync(file)).digest('hex');
  } catch {
    return 'unreadable';
  }
}

/** HEAD and the content of every path git status lists; an error when git can't say. */
export async function takeWorkTreeSnapshot(cwd: string): Promise<SnapshotResult> {
  const git = (args: string[]) => runProcess('git', readOnlyGitArgs(args), { cwd, timeoutMs: 60_000, maxOutput: 64 * 1024 * 1024 });
  const [head, status] = await Promise.all([git(['rev-parse', 'HEAD']), git(['status', '--porcelain=v1', '-z', '--untracked-files=all'])]);
  for (const [name, result] of [['git rev-parse', head], ['git status', status]] as const) {
    if (result.error) return { error: `${name} could not start: ${result.error}` };
    if (result.timedOut) return { error: `${name} timed out` };
    if (result.code !== 0) return { error: `${name} exited with code ${result.code}${result.stderr.trim() ? `: ${result.stderr.trim().split('\n').pop()}` : ''}` };
  }
  const files: Record<string, string> = {};
  for (const path of parsePorcelainZ(status.stdout)) files[path] = contentHash(join(cwd, path));
  return { head: head.stdout.trim(), files };
}

/**
 * The paths whose content differs between two snapshots, leaving out the
 * task's spec directory and the worktree's root `.vibe-teamlead/` folder, and
 * whether HEAD moved (the reviewer made a commit). Pure — tested directly.
 */
export function reviewerChangedFiles(
  before: WorkTreeSnapshot,
  after: WorkTreeSnapshot,
  dirs: { projectDir: string; specDir: string },
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
  return { files, headMoved: before.head !== after.head };
}
