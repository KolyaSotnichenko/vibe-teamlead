/**
 * Bring the latest main branch into a task, in the task's own folder, before the
 * task merges. The project is never in the middle of anything, and an agent that
 * can read the whole project solves the conflicts and checks the result, so what
 * merges next has nothing left to conflict with. The agent's word only goes so far:
 * the checks here are on what git actually holds. No Electron imports.
 */

import { lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { MergeState } from '../../../shared/types/task';
import { gitPath, type GitRun, gitRunner, mergeBlocker, mergeTaskBranch, type MergeTaskBranchOptions, type MergeTaskBranchResult, saveApprovedChanges } from './git-merge';

export interface IntegrationAgentRequest {
  baseBranch: string;
  /** Empty when git merged it all: the agent then only checks the result */
  conflictFiles: string[];
}

export interface IntegrationAgentAnswer {
  ok: boolean;
  /** What it checked and how that went, or why it gave up */
  summary: string;
}

/** The agent was told to stop and hasn't: what it does in the folder from now on can't be trusted or undone yet. */
export class AgentStillRunningError extends Error {}

export interface IntegrateTaskOptions {
  worktreePath: string;
  baseBranch: string;
  runAgent: (request: IntegrationAgentRequest) => Promise<IntegrationAgentAnswer>;
  git?: string;
  env?: NodeJS.ProcessEnv;
}

export type IntegrateTaskResult =
  /** The task already has the latest main */
  | { status: 'up_to_date' }
  /** Git merged it, and the agent found nothing to change */
  | { status: 'verified'; summary: string }
  /** The agent changed code: nobody has read that yet */
  | { status: 'needs_review'; files: string[]; summary: string }
  /** The task is back as it was */
  | { status: 'failed'; message: string };

/** In the task's git directory: agents can't reach it, and git never commits it */
export const INTEGRATION_FILE = 'vibe-teamlead-integration.json';
const MERGE_FAILURE_FILE = 'vibe-teamlead-merge-failure.json';

interface IntegrationMark {
  state: 'running' | 'review';
  /** The task before the merge: where to go back to */
  before: string;
  /** The task after it. A review holds only while the task is still here */
  tip?: string;
  /** The branch it merged with: what the review compares against */
  baseBranch?: string;
  files?: string[];
  summary?: string;
}

const MAX_REASON_CHARS = 300;
const MAX_DIFF_CHARS = 256 * 1024;
const ROLLBACK_ATTEMPTS = 5;
const ROLLBACK_WAIT_MS = 200;

const stripRemote = (branch: string) => branch.replace(/^origin\//, '');

function readMark(file: string): IntegrationMark | null {
  try {
    const mark = JSON.parse(readFileSync(file, 'utf-8')) as IntegrationMark;
    return typeof mark.before === 'string' ? mark : null;
  } catch {
    return null;
  }
}

async function goBack(run: GitRun, markFile: string, before: string): Promise<boolean> {
  for (let attempt = 0; attempt < ROLLBACK_ATTEMPTS; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, ROLLBACK_WAIT_MS));
    if ((await run(['reset', '--hard', before])).ok) {
      rmSync(markFile, { force: true });
      return true;
    }
  }
  return false;
}

const isAncestor = async (run: GitRun, ancestor: string, of: string) => (await run(['merge-base', '--is-ancestor', ancestor, of])).ok;

/** Conflict markers left in the file. Not for links and folders: git holds those, not their text. */
function hasMarkers(worktreePath: string, file: string): boolean {
  const path = join(worktreePath, file);
  if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) return false;
  return /^(<{7}|>{7}) /m.test(readFileSync(path, 'utf-8'));
}

export async function integrateTask(options: IntegrateTaskOptions): Promise<IntegrateTaskResult> {
  const { worktreePath, runAgent, git = 'git' } = options;
  const baseBranch = stripRemote(options.baseBranch);
  const run = gitRunner(worktreePath, git, options.env ?? process.env);
  const markFile = await gitPath(run, worktreePath, INTEGRATION_FILE);

  const stale = readMark(markFile);
  if (stale?.state === 'running') {
    // The app stopped in the middle of this
    if (!(await goBack(run, markFile, stale.before))) return { status: 'failed', message: stillOpen(worktreePath, stale.before) };
  } else if ((await run(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])).ok) {
    return { status: 'failed', message: "The task's folder is in the middle of a merge the app didn't start. Finish or drop it there, then merge again." };
  }

  const base = (await run(['rev-parse', '--verify', '--quiet', `${baseBranch}^{commit}`])).stdout;
  const before = (await run(['rev-parse', '--verify', 'HEAD'])).stdout;
  if (!base || !before) return { status: 'failed', message: `"${baseBranch}" or the task's branch was not found.` };
  if (await isAncestor(run, base, before)) return { status: 'up_to_date' };

  writeFileSync(markFile, JSON.stringify({ state: 'running', before } satisfies IntegrationMark), 'utf-8');
  const fail = async (message: string): Promise<IntegrateTaskResult> => ({
    status: 'failed',
    message: (await goBack(run, markFile, before)) ? message.slice(0, MAX_REASON_CHARS) : stillOpen(worktreePath, before),
  });

  const merge = await run(['merge', '--no-edit', '-m', `Merge ${baseBranch} into the task`, base]);
  const conflictFiles = (await run(['diff', '--name-only', '--diff-filter=U', '-z'])).raw.split('\0').filter(Boolean);
  // No conflicts means git declined to start
  if (!merge.ok && !conflictFiles.length) return fail(merge.output);

  let answer: IntegrationAgentAnswer;
  try {
    answer = await runAgent({ baseBranch, conflictFiles });
  } catch (error) {
    // The mark stays 'running', so the next try goes back to before the merge, whatever the agent added by then
    if (error instanceof AgentStillRunningError) return { status: 'failed', message: error.message };
    return fail(error instanceof Error ? error.message : String(error));
  }
  if (!answer.ok) return fail(answer.summary);

  const withMarkers = conflictFiles.find((file) => hasMarkers(worktreePath, file));
  if (withMarkers) return fail(`${withMarkers}: the agent left conflict markers in the file`);

  if (conflictFiles.length) await run(['--literal-pathspecs', 'add', '-A', '--', ...conflictFiles]);
  // Tracked files only: what else the agent left around (logs, reports) isn't the task's. A new file it needs, it stages.
  await run(['add', '-u']);
  const open = (await run(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])).ok;
  if (open || !(await run(['diff', '--cached', '--quiet'])).ok) {
    const committed = await run(open ? ['commit', '--no-edit'] : ['commit', '-m', `Fix what merging ${baseBranch} broke`]);
    if (!committed.ok) return fail(committed.output);
  }

  const tip = (await run(['rev-parse', 'HEAD'])).stdout;
  if (!(await isAncestor(run, base, tip)) || !(await isAncestor(run, before, tip))) {
    return fail(`The agent left the task without "${baseBranch}" or without its own history.`);
  }

  const mergeCommit = (await run(['rev-list', '--first-parent', '--merges', '--reverse', `${before}..${tip}`])).stdout.split('\n')[0];
  const fixed = mergeCommit ? (await run(['diff', '--name-only', '-z', mergeCommit, tip])).raw.split('\0').filter(Boolean) : [];
  // Files that differ from both sides of the merge: what the agent changed while the merge was open
  const inMerge = conflictFiles.length && mergeCommit
    ? (await run(['diff-tree', '--cc', '--name-only', '-z', '--no-commit-id', mergeCommit])).raw.split('\0').filter(Boolean)
    : [];
  const files = [...new Set([...conflictFiles, ...inMerge, ...fixed])];
  if (!files.length) {
    rmSync(markFile, { force: true });
    return { status: 'verified', summary: answer.summary };
  }

  writeFileSync(markFile, JSON.stringify({ state: 'review', before, tip, baseBranch, files, summary: answer.summary } satisfies IntegrationMark), 'utf-8');
  return { status: 'needs_review', files, summary: answer.summary };
}

function stillOpen(worktreePath: string, before: string): string {
  return `The task's folder could not be put back. Nothing reached the project. Run "git reset --hard ${before}" in ${worktreePath}, then try again.`;
}

export interface IntegrationReviewOptions {
  worktreePath: string;
  git?: string;
  env?: NodeJS.ProcessEnv;
}

async function currentReview(run: GitRun, worktreePath: string): Promise<(IntegrationMark & { files: string[]; markFile: string }) | null> {
  const markFile = await gitPath(run, worktreePath, INTEGRATION_FILE);
  const mark = readMark(markFile);
  if (mark?.state !== 'review' || !Array.isArray(mark.files)) return null;
  if ((await run(['rev-parse', 'HEAD'])).stdout !== mark.tip) return null;
  return { ...mark, files: mark.files, markFile };
}

/** The agent's work waiting for the user's decision, if any. It survives a restart, and ends if the task moves on. */
export async function getIntegrationReview(options: IntegrationReviewOptions): Promise<{ files: string[]; summary: string } | null> {
  const { worktreePath, git = 'git' } = options;
  const review = await currentReview(gitRunner(worktreePath, git, options.env ?? process.env), worktreePath);
  return review ? { files: review.files, summary: review.summary ?? '' } : null;
}

/** The user declined: the task goes back to how it was before the merge. False when there was nothing to cancel, or git couldn't. */
export async function cancelIntegrationReview(options: IntegrationReviewOptions): Promise<boolean> {
  const { worktreePath, git = 'git' } = options;
  const run = gitRunner(worktreePath, git, options.env ?? process.env);
  const review = await currentReview(run, worktreePath);
  return review ? goBack(run, review.markFile, review.before) : false;
}

/**
 * A reviewed file against the project's branch (what the merge changes there) or
 * the task (what the agent changed in its version), with the user's edits. Only
 * files in the review. Plain diff: a branch's .gitattributes can't pick a driver
 * or call the file binary to hide its text.
 */
export async function getIntegrationReviewDiff(
  options: IntegrationReviewOptions & { file: string; against: 'project' | 'task' },
): Promise<{ diff: string; truncated: boolean } | null> {
  const { worktreePath, file, against, git = 'git' } = options;
  const run = gitRunner(worktreePath, git, options.env ?? process.env);
  const review = await currentReview(run, worktreePath);
  if (!review?.files.includes(file)) return null;
  const result = await run([
    '--literal-pathspecs', 'diff', '--text', '--no-color', '--no-ext-diff', '--no-textconv',
    against === 'project' ? (review.baseBranch ?? 'HEAD') : review.before, '--', file,
  ]);
  if (!result.ok) return null;
  const truncated = result.raw.length > MAX_DIFF_CHARS;
  return { diff: truncated ? result.raw.slice(0, MAX_DIFF_CHARS) : result.raw, truncated };
}

export interface IntegrateAndMergeOptions extends MergeTaskBranchOptions {
  /** The user read the agent's work and said yes */
  confirmed: boolean;
  runAgent: IntegrateTaskOptions['runAgent'];
  onProgress?: (stage: 'integrating' | 'merging') => void;
}

type MergeOutcome = MergeTaskBranchResult | { status: 'needs_review'; files: string[]; summary: string };

/** The whole merge of a task. Call it through the merge queue. Never throws: nobody may be there to catch it. */
export async function integrateAndMerge(options: IntegrateAndMergeOptions): Promise<MergeOutcome> {
  let result: MergeOutcome;
  try {
    result = await mergeSteps(options);
  } catch (error) {
    result = { status: 'refused', message: error instanceof Error ? error.message : String(error) };
  }
  if (options.worktreePath) await noteOutcome(options, options.worktreePath, result);
  return result;
}

/** The window that started the merge may be closed by the time it fails, so the reason goes on disk. */
async function noteOutcome(options: IntegrateAndMergeOptions, worktreePath: string, result: MergeOutcome): Promise<void> {
  try {
    const run = gitRunner(worktreePath, options.git ?? 'git', options.env ?? process.env);
    const tip = (await run(['rev-parse', 'HEAD'])).stdout;
    if (!tip) return;
    const file = await gitPath(run, worktreePath, MERGE_FAILURE_FILE);
    if (result.status === 'refused' || result.status === 'conflicts') {
      const reason = [result.conflictFiles?.join(', '), result.message].filter(Boolean).join(': ') || 'The merge failed.';
      writeFileSync(file, JSON.stringify({ reason, tip }), 'utf-8');
    } else {
      rmSync(file, { force: true });
    }
  } catch {
    // Non-fatal: the result still reaches whoever is waiting for it
  }
}

export interface MergeStateOptions {
  worktreePath?: string | null;
  merging: boolean;
  git?: string;
  env?: NodeJS.ProcessEnv;
}

/** Where a task's merge stands, for whoever looks at it later. A failure holds only while the task is where it failed. */
export async function getMergeState(options: MergeStateOptions): Promise<MergeState | null> {
  const { worktreePath, merging, git = 'git' } = options;
  if (merging) return { state: 'merging' };
  if (!worktreePath) return null;
  const run = gitRunner(worktreePath, git, options.env ?? process.env);
  if (await currentReview(run, worktreePath)) return { state: 'review' };
  try {
    const failure = JSON.parse(readFileSync(await gitPath(run, worktreePath, MERGE_FAILURE_FILE), 'utf-8')) as { reason?: unknown; tip?: unknown };
    const stillThere = failure.tip === (await run(['rev-parse', 'HEAD'])).stdout;
    return stillThere && typeof failure.reason === 'string' ? { state: 'failed', reason: failure.reason } : null;
  } catch {
    return null;
  }
}

async function mergeSteps(options: IntegrateAndMergeOptions): Promise<MergeOutcome> {
  const { worktreePath, confirmed, runAgent, onProgress } = options;
  // Before anything saves the folder's edits: that would move the task off the work under review
  if (worktreePath && !confirmed) {
    const pending = await getIntegrationReview({ worktreePath, git: options.git, env: options.env });
    if (pending) return { status: 'needs_review', ...pending };
  }
  // Their edits on top of what they just confirmed are theirs to include
  const mergeOptions: MergeTaskBranchOptions = confirmed ? { ...options, uncommittedApproved: async () => true } : options;
  const blocked = (await mergeBlocker(mergeOptions)) ?? (await saveApprovedChanges(mergeOptions));
  if (blocked) return blocked;

  if (worktreePath) {
    onProgress?.('integrating');
    const integration = await integrateTask({ worktreePath, baseBranch: options.baseBranch, runAgent, git: options.git, env: options.env });
    if (integration.status === 'failed') return { status: 'refused', message: `Could not merge: ${integration.message} Nothing reached the project.` };
    if (integration.status === 'needs_review') return integration;
  }
  onProgress?.('merging');
  return mergeTaskBranch(mergeOptions);
}
