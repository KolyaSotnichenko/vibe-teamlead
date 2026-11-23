/**
 * The app writes a recipe into a project's main branch itself: one commit of `preview.json`,
 * with no task and no model call. The commit is built with git's plumbing on an index of its
 * own, on top of main, so no checkout is touched until it is taken in; taking it in is a
 * fast-forward (`git merge --ff-only`), which either moves main and the owner's folder to
 * that one commit or does nothing at all. It is refused, with the project exactly as it was,
 * while the owner's folder is on another branch, in the middle of a merge, or has changes in
 * the way. Nothing is pushed. No hooks run. No Electron imports.
 */

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { withoutGitHooks } from '../ai/merge/git-merge';
import { say } from '../say';
import { RECIPE_FILE } from './recipe';

/** Where the recipe's commit sits until it is merged; removed afterwards, whatever happened */
export const RECIPE_BRANCH = 'vibe-teamlead/preview-recipe';
const DEFAULT_MESSAGE = `Preview recipe: ${RECIPE_FILE}`;
/** For an owner whose git has no name or address yet: a commit can't be made without one */
const FALLBACK_IDENTITY = { name: 'Vibe Teamlead', email: 'vibe-teamlead@localhost' };

export interface RecipeCommitOptions {
  projectDir: string;
  mainBranch: string;
  /** The text of preview.json */
  text: string;
  message?: string;
  git?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RecipeCommitResult {
  status: 'merged' | 'up_to_date' | 'refused';
  /** Why it was refused, in git's words or the app's */
  message?: string;
}

interface GitOutput {
  ok: boolean;
  /** As git printed it, for file contents */
  raw: string;
  stdout: string;
  output: string;
}

function runner(projectDir: string, git: string, env: NodeJS.ProcessEnv) {
  return (args: string[], options: { input?: string; env?: NodeJS.ProcessEnv } = {}) =>
    new Promise<GitOutput>((resolve) => {
      const child = execFile(git, args, { cwd: projectDir, env: { ...env, ...options.env }, encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        resolve({ ok: !error, raw: stdout, stdout: stdout.trim(), output: `${stderr}\n${stdout}`.trim() });
      });
      if (options.input !== undefined) child.stdin?.end(options.input);
    });
}

/** main's preview.json as text, null when main has none (or no such branch) */
export async function mainRecipeText(projectDir: string, mainBranch: string, options: { git?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string | null> {
  const run = runner(projectDir, options.git ?? 'git', withoutGitHooks(options.env ?? process.env));
  const shown = await run(['show', `${mainBranch}:${RECIPE_FILE}`]);
  return shown.ok ? shown.raw : null;
}

/** The name and address commits are made with: the owner's, or the app's own where git has none */
async function identityEnv(run: ReturnType<typeof runner>, env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const has = async (key: string, ...variables: string[]) => variables.some((name) => env[name]) || (await run(['config', key])).stdout !== '';
  const out: NodeJS.ProcessEnv = {};
  if (!(await has('user.name', 'GIT_AUTHOR_NAME', 'GIT_COMMITTER_NAME'))) {
    out.GIT_AUTHOR_NAME = FALLBACK_IDENTITY.name;
    out.GIT_COMMITTER_NAME = FALLBACK_IDENTITY.name;
  }
  if (!(await has('user.email', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL', 'EMAIL'))) {
    out.GIT_AUTHOR_EMAIL = FALLBACK_IDENTITY.email;
    out.GIT_COMMITTER_EMAIL = FALLBACK_IDENTITY.email;
  }
  return out;
}

export async function commitRecipeToMain(options: RecipeCommitOptions): Promise<RecipeCommitResult> {
  const { projectDir, mainBranch, text, message = DEFAULT_MESSAGE, git = 'git' } = options;
  const baseEnv = withoutGitHooks(options.env ?? process.env);
  const probe = runner(projectDir, git, baseEnv);
  const refused = (why: string): RecipeCommitResult => ({ status: 'refused', message: why });

  const main = (await probe(['rev-parse', '--verify', '--quiet', `${mainBranch}^{commit}`])).stdout;
  if (!main) return refused(say('recipeNoMain', `The branch "${mainBranch}" was not found in the project.`, { main: mainBranch }));
  const current = await probe(['show', `${mainBranch}:${RECIPE_FILE}`]);
  if (current.ok && current.raw === text) return { status: 'up_to_date' };
  // Said before anything is made: the owner's folder has to be on main, and not in the middle of a merge
  const branch = (await probe(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout;
  if (branch !== mainBranch) {
    return refused(say('recipeOtherBranch', `The project's folder is on "${branch}". The recipe goes into "${mainBranch}" once the folder is back on it.`, { current: branch, main: mainBranch }));
  }
  if ((await probe(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])).ok || (await probe(['ls-files', '--unmerged'])).stdout) {
    return refused(say('recipeMidMerge', 'The project is in the middle of a merge. The recipe goes in once the merge is finished or dropped.'));
  }

  const env = { ...baseEnv, ...(await identityEnv(probe, baseEnv)) };
  const run = runner(projectDir, git, env);
  const gitDir = (await run(['rev-parse', '--absolute-git-dir'])).stdout;
  if (!gitDir) return refused(say('recipeNoRepo', 'The project is not a git repository.'));
  // An index of its own: the owner's index and working tree are not read or written here
  const index = { GIT_INDEX_FILE: join(gitDir, `vibe-teamlead-recipe-index-${randomBytes(6).toString('hex')}`) };
  try {
    const blob = await run(['hash-object', '-w', '--stdin'], { input: text });
    if (!blob.ok || !blob.stdout) return refused(blob.output);
    const read = await run(['read-tree', main], { env: index });
    if (!read.ok) return refused(read.output);
    const added = await run(['update-index', '--add', '--cacheinfo', `100644,${blob.stdout},${RECIPE_FILE}`], { env: index });
    if (!added.ok) return refused(added.output);
    const tree = await run(['write-tree'], { env: index });
    if (!tree.ok || !tree.stdout) return refused(tree.output);
    const commit = await run(['commit-tree', tree.stdout, '-p', main, '-m', message]);
    if (!commit.ok || !commit.stdout) return refused(commit.output);
    const branched = await run(['update-ref', `refs/heads/${RECIPE_BRANCH}`, commit.stdout]);
    if (!branched.ok) return refused(branched.output);

    // One commit on top of main: main and the owner's folder move to it, or git changes nothing and says why
    const taken = await run(['merge', '--ff-only', '--no-edit', RECIPE_BRANCH]);
    return taken.ok ? { status: 'merged' } : refused(taken.output.slice(0, 600));
  } finally {
    rmSync(index.GIT_INDEX_FILE, { force: true });
    rmSync(`${index.GIT_INDEX_FILE}.lock`, { force: true });
    await run(['update-ref', '-d', `refs/heads/${RECIPE_BRANCH}`]);
  }
}
