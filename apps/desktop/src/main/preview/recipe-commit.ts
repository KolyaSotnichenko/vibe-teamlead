/**
 * The app writes a recipe into a project's main branch itself: one commit of `preview.json`,
 * with no task and no model call. The commit is built with git's plumbing on an index of its
 * own, on top of main, so no checkout is touched until it is taken in; taking it in is a
 * fast-forward (`git merge --ff-only`), which either moves main and the owner's folder to
 * that one commit or does nothing at all. It is refused, with the project exactly as it was,
 * while the owner's folder is on another branch or on none, in the middle of a merge, or has a
 * preview.json or other changes in the way. When main's file is no longer the one the recipe
 * was made against, a task changed it first, and main is left alone. The owner's git signs
 * the commit when it signs commits. Nothing is pushed. No hooks run. No Electron imports.
 */

import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { gitRunner, type GitRun } from '../ai/merge/git-merge';
import { say } from '../say';
import { RECIPE_FILE, recipeHash } from './recipe';

/** Where the recipe's commit sits until it is taken in; removed afterwards, whatever happened */
export const RECIPE_BRANCH = 'vibe-teamlead/preview-recipe';
/** One name, so what an attempt that died left is found and cleared by the next */
const INDEX_FILE = 'vibe-teamlead-recipe-index';
const DEFAULT_MESSAGE = `Preview recipe: ${RECIPE_FILE}`;
/** For an owner whose git has no name or address yet: a commit can't be made without one */
const FALLBACK_IDENTITY = { name: 'Vibe Teamlead', email: 'vibe-teamlead@localhost' };
const REASON_CHARS = 600;

export interface RecipeCommitOptions {
  projectDir: string;
  mainBranch: string;
  /** The text of preview.json */
  text: string;
  /**
   * recipeHash() of the preview.json the recipe was made against ('none': there was none). When
   * main has another by now, nothing is written and the answer is `replaced`.
   */
  expectedBase?: string;
  message?: string;
  git?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RecipeCommitResult {
  status: 'merged' | 'up_to_date' | 'refused' | 'replaced';
  /** Why it was refused, in the app's words or git's */
  message?: string;
}

/** main's preview.json as text, null when main has none (or no such branch) */
export async function mainRecipeText(projectDir: string, mainBranch: string, options: { git?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string | null> {
  const run = gitRunner(projectDir, options.git ?? 'git', options.env ?? process.env);
  const shown = await run(['show', `${mainBranch}:${RECIPE_FILE}`]);
  return shown.ok ? shown.raw : null;
}

/** Whether the project is a repository that has its main branch: only then is main's recipe the one that counts */
export async function mainBranchExists(projectDir: string, mainBranch: string, options: { git?: string; env?: NodeJS.ProcessEnv } = {}): Promise<boolean> {
  const run = gitRunner(projectDir, options.git ?? 'git', options.env ?? process.env);
  return (await run(['rev-parse', '--verify', '--quiet', `${mainBranch}^{commit}`])).ok;
}

/** The name and address commits are made with: the owner's, or the app's own where git has none */
async function identityEnv(run: GitRun, env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
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
  const env = options.env ?? process.env;
  const run = gitRunner(projectDir, git, env);
  const refused = (why: string): RecipeCommitResult => ({ status: 'refused', message: why });

  const gitDir = (await run(['rev-parse', '--absolute-git-dir'])).stdout;
  const top = (await run(['rev-parse', '--show-toplevel'])).stdout;
  if (!gitDir || !top) return refused(say('recipeNoRepo', 'The project is not a git repository.'));
  const main = (await run(['rev-parse', '--verify', '--quiet', `${mainBranch}^{commit}`])).stdout;
  if (!main) return refused(say('recipeNoMain', `The branch "${mainBranch}" was not found in the project.`, { main: mainBranch }));
  const shown = await run(['show', `${mainBranch}:${RECIPE_FILE}`]);
  const current = shown.ok ? shown.raw : null;
  if (current === text) return { status: 'up_to_date' };
  // A task changed main's recipe since this one was made: main wins, and nothing is written
  if (options.expectedBase !== undefined && recipeHash(current) !== options.expectedBase) return { status: 'replaced' };

  // Said before anything is made: the owner's folder has to be on main, with nothing of its own in the way
  const branch = (await run(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout;
  if (branch === 'HEAD' || branch === '') {
    return refused(say('recipeDetached', `The project's folder is not on a branch. The recipe goes into "${mainBranch}" once the folder is back on it.`, { main: mainBranch }));
  }
  if (branch !== mainBranch) {
    return refused(say('recipeOtherBranch', `The project's folder is on "${branch}". The recipe goes into "${mainBranch}" once the folder is back on it.`, { current: branch, main: mainBranch }));
  }
  if ((await run(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])).ok || (await run(['ls-files', '--unmerged'])).stdout) {
    return refused(say('recipeMidMerge', 'The project is in the middle of a merge. The recipe goes in once the merge is finished or dropped.'));
  }
  // A preview.json of the owner's that main does not have: git overwrites one it ignores without a word
  if (current === null && existsSync(join(top, RECIPE_FILE))) {
    return refused(say('recipeFileInTheWay', `The project's folder has a ${RECIPE_FILE} of its own that is not committed. The recipe goes in once that file is committed or removed.`));
  }

  // An index of its own: the owner's index and working tree are not read or written until the fast-forward
  const index = { GIT_INDEX_FILE: join(gitDir, INDEX_FILE) };
  const identity = await identityEnv(run, env);
  const clear = async () => {
    rmSync(index.GIT_INDEX_FILE, { force: true });
    rmSync(`${index.GIT_INDEX_FILE}.lock`, { force: true });
    await run(['update-ref', '-d', `refs/heads/${RECIPE_BRANCH}`]);
  };
  // What an attempt that died left behind
  await clear();
  try {
    const failed = (step: { output: string }) => refused(step.output.slice(0, REASON_CHARS));
    const blob = await run(['hash-object', '-w', '--stdin'], projectDir, { input: text });
    if (!blob.ok || !blob.stdout) return failed(blob);
    const read = await run(['read-tree', main], projectDir, { env: index });
    if (!read.ok) return failed(read);
    const added = await run(['update-index', '--add', '--cacheinfo', `100644,${blob.stdout},${RECIPE_FILE}`], projectDir, { env: index });
    if (!added.ok) return failed(added);
    const tree = await run(['write-tree'], projectDir, { env: index });
    if (!tree.ok || !tree.stdout) return failed(tree);
    // Plumbing does not sign by itself: an owner whose git signs commits gets this one signed too
    const signs = (await run(['config', '--bool', 'commit.gpgsign'])).stdout === 'true';
    const commit = await run(['commit-tree', tree.stdout, '-p', main, ...(signs ? ['-S'] : []), '-m', message], projectDir, { env: identity });
    if (!commit.ok || !commit.stdout) return failed(commit);
    const branched = await run(['update-ref', `refs/heads/${RECIPE_BRANCH}`, commit.stdout]);
    if (!branched.ok) return failed(branched);
    // One commit on top of main: main and the owner's folder move to it, or git changes nothing and says why
    const taken = await run(['merge', '--ff-only', '--no-edit', RECIPE_BRANCH]);
    return taken.ok ? { status: 'merged' } : failed(taken);
  } finally {
    await clear();
  }
}
