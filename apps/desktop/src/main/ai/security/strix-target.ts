/**
 * The folder Strix attacks. Strix mounts its target into the sandbox writable and
 * works there as root in a Linux container: installs put Linux binaries into
 * node_modules, and config edits and stray tests land in the folder. So it gets a
 * throwaway copy of the task, with the same history for its diff, and the task's
 * own folder stays as QA approved it.
 *
 * Ignored files stay out: they never reach the task's commits, and they include
 * the project's .env.
 */

import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { findOnPath, runProcess } from '../../platform/exec';

export interface StrixTargetOptions {
  projectDir: string;
  specDir: string;
  /** The copy goes in here, replacing what a stopped run may have left */
  parentDir: string;
  /** Branch or commit to diff against */
  diffBase?: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface StrixTarget {
  path: string;
  /** The commit to diff against: the project's branch names may not exist in the copy */
  diffBase?: string;
}

/** Where the copy holds the spec and the architecture, relative to the copy */
export const TASK_DOCS_DIR = '.vibe-teamlead-task';

const GIT_TIMEOUT_MS = 10 * 60_000;

/** Throws when no faithful copy can be made: scanning something else would be a false result. */
export async function prepareStrixTarget(options: StrixTargetOptions): Promise<StrixTarget> {
  const { projectDir, specDir, parentDir, diffBase, signal } = options;
  const env: NodeJS.ProcessEnv = { ...options.env, GIT_TERMINAL_PROMPT: '0' };
  const gitBin = findOnPath('git', env.PATH) ?? 'git';
  const git = async (cwd: string, args: string[]) => {
    const run = await runProcess(gitBin, ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, env, signal, timeoutMs: GIT_TIMEOUT_MS });
    return { ok: run.code === 0, stdout: run.stdout, stderr: run.stderr };
  };

  removeStrixTarget(parentDir);
  const path = join(parentDir, 'target', basename(projectDir));
  mkdirSync(dirname(path), { recursive: true });

  if (!existsSync(projectDir)) throw new Error(`${projectDir} does not exist`);
  const cloned = await git(dirname(path), ['clone', '--quiet', '--no-hardlinks', projectDir, path]);
  if (!cloned.ok) throw new Error(cloned.stderr.trim() || 'git clone failed');

  // What the worktree has beyond its last commit is part of what QA approved
  const changed = await git(projectDir, ['diff', '--name-only', '--no-renames', '-z', 'HEAD']);
  const added = await git(projectDir, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.', ':(exclude).vibe-teamlead']);
  if (!changed.ok || !added.ok) throw new Error('git could not list the uncommitted changes');
  for (const file of [...changed.stdout.split('\0'), ...added.stdout.split('\0')].filter(Boolean)) {
    // A linked folder in the worktree could reach any file on this machine: that file isn't the task's
    const stat = linkedFolderOn(projectDir, file) ? undefined : lstatSync(join(projectDir, file), { throwIfNoEntry: false });
    if (stat && !stat.isFile()) continue;
    // The copy's links come from the branch, and could aim the write anywhere: the worktree has no link here
    let link = linkedFolderOn(path, file);
    while (link) {
      rmSync(link);
      link = linkedFolderOn(path, file);
    }
    rmSync(join(path, file), { force: true });
    if (stat) {
      mkdirSync(dirname(join(path, file)), { recursive: true });
      copyFileSync(join(projectDir, file), join(path, file));
    }
  }

  // Removed first: the branch may have put a link at this name
  const docs = join(path, TASK_DOCS_DIR);
  rmSync(docs, { recursive: true, force: true });
  mkdirSync(docs);
  // Agents can write in the spec folder: a link there could reach any file on this machine
  const notALink = (from: string) => !lstatSync(from).isSymbolicLink();
  const spec = join(specDir, 'spec.md');
  if (existsSync(spec) && notALink(spec)) copyFileSync(spec, join(docs, 'spec.md'));
  const architecture = join(specDir, 'architecture');
  if (existsSync(architecture)) cpSync(architecture, join(docs, 'architecture'), { recursive: true, filter: notALink });

  return { path, diffBase: diffBase ? await baseCommit(git, projectDir, path, diffBase) : undefined };
}

/** The first folder on the way to `file` that is a symbolic link, if any. */
function linkedFolderOn(root: string, file: string): string | undefined {
  let current = root;
  for (const part of file.split('/').slice(0, -1)) {
    current = join(current, part);
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) return current;
  }
  return undefined;
}

type Git = (cwd: string, args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

async function baseCommit(git: Git, projectDir: string, copy: string, diffBase: string): Promise<string> {
  const resolved = await git(projectDir, ['rev-parse', '--verify', '--quiet', `${diffBase}^{commit}`]);
  const commit = resolved.stdout.trim();
  if (!resolved.ok || !commit) throw new Error(`the base "${diffBase}" was not found`);
  // A clone brings the project's branches, not its remote branches
  if (!(await git(copy, ['cat-file', '-e', `${commit}^{commit}`])).ok) {
    await git(copy, ['fetch', '--quiet', projectDir, '+refs/remotes/*:refs/source-remotes/*']);
    if (!(await git(copy, ['cat-file', '-e', `${commit}^{commit}`])).ok) throw new Error(`the base "${diffBase}" could not be copied`);
  }
  return commit;
}

/** Never throws: a copy left behind is replaced by the next scan. */
export function removeStrixTarget(parentDir: string): void {
  try {
    rmSync(join(parentDir, 'target'), { recursive: true, force: true });
  } catch {
    // Non-fatal
  }
}
