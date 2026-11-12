/**
 * Push a task's branch to GitHub after each finished subtask, after each coder and QA fixer
 * session, and when the task goes to review, so CI runs on it.
 *
 * Per task, one push runs at a time; requests made meanwhile share ONE follow-up push
 * (which carries the newest commit). A branch whose head is already pushed is not pushed
 * again. Nothing here throws into the caller: the outcome is recorded per task (kept in a
 * small JSON file, so previews survive a restart) and announced through `emit`.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Project, Task } from '../../shared/types';
import type { DeployProjectSettings } from '../../shared/types/deploy';
import { writeFileReplacingSync } from '../ai/safe-write';
import { TASK_BRANCH_PREFIX } from '../../shared/constants/config';
import { GitHubWriteError, pushWithAppToken } from './github-write';
import { isCiSetUp } from './ci-setup';
import { branchHead } from './push-after-merge';

export interface BranchPushRecord {
  sha?: string;
  at?: string;
  error?: { kind: string };
}

export interface BranchPushDeps {
  push: typeof pushWithAppToken;
  head: typeof branchHead;
  emit(projectId: string, taskId: string): void;
  now?(): Date;
  /** The repository's visibility now (GitHub). Checked at most once an hour per project. */
  visibility?(owner: string, repo: string): Promise<'private' | 'public'>;
  /** Records that the repository is no longer private. */
  markPublic?(projectId: string, repo: NonNullable<DeployProjectSettings['repo']>): void;
}

const VISIBILITY_TTL_MS = 60 * 60_000;
const visibilityChecks = new Map<string, { at: number; visibility: 'private' | 'public' }>();

export type PreviewPushAllowed =
  | { allowed: true }
  | { allowed: false; reason: 'not-set-up' | 'public-repo' | 'push-off' };

/**
 * Whether the main branch has reached the CI repository: setup finished once, or the repository
 * is one the app didn't create (it already has the project's code). An app-created repository
 * recorded by a setup that stopped before its push is empty: a task branch pushed there could
 * become GitHub's default branch.
 */
export function mainReachedRepo(deploy: DeployProjectSettings | undefined): boolean {
  return !!deploy?.repo && (deploy.enabled === true || deploy.repo.createdByApp !== true);
}

export function previewPushAllowed(project: Project, task: Task): PreviewPushAllowed {
  const deploy = project.settings?.deploy;
  if (!isCiSetUp(project) || !deploy?.repo || !mainReachedRepo(deploy)) return { allowed: false, reason: 'not-set-up' };
  // Only a repository known to be private gets pushes; unknown visibility fails closed
  if (deploy.repo.public !== false) return { allowed: false, reason: 'public-repo' };
  if (project.settings?.pushNewBranches === false || task.metadata?.pushNewBranches === false) {
    return { allowed: false, reason: 'push-off' };
  }
  return { allowed: true };
}

/**
 * Whether a task's new branch is pushed when its worktree is made. A CI repository that
 * is not known to be private, or that main hasn't reached yet, gets no task branch at all.
 */
export function worktreePushNewBranches(
  settings: Project['settings'] | undefined,
  optionValue: boolean | undefined,
): boolean {
  const repo = settings?.deploy?.repo;
  if (isCiSetUp({ settings }) && repo && (repo.public !== false || !mainReachedRepo(settings?.deploy))) return false;
  return optionValue ?? settings?.pushNewBranches !== false;
}

interface TaskState {
  running: boolean;
  queued?: { project: Project; task: Task; promise: Promise<BranchPushRecord>; resolve: (r: BranchPushRecord) => void };
}

const states = new Map<string, TaskState>();
let records: Map<string, BranchPushRecord> | undefined;
let storeFile: string | undefined;

/** Where push records are kept (`<userData>/deploy/branch-pushes.json`); read lazily. Undefined: memory only. */
export function setBranchPushStore(file: string | undefined): void {
  storeFile = file;
  records = undefined;
}

function isRecord(v: unknown): v is BranchPushRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (r.sha !== undefined && typeof r.sha !== 'string') return false;
  if (r.at !== undefined && typeof r.at !== 'string') return false;
  if (r.error !== undefined && (typeof r.error !== 'object' || typeof (r.error as { kind?: unknown })?.kind !== 'string')) return false;
  return true;
}

function loadRecords(): Map<string, BranchPushRecord> {
  if (records) return records;
  records = new Map();
  if (!storeFile) return records;
  try {
    const raw = JSON.parse(readFileSync(storeFile, 'utf-8')) as unknown;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [taskId, v] of Object.entries(raw)) {
        if (!isRecord(v)) continue;
        records.set(taskId, {
          ...(v.sha ? { sha: v.sha } : {}),
          ...(v.at ? { at: v.at } : {}),
          ...(v.error ? { error: { kind: v.error.kind } } : {}),
        });
      }
    }
  } catch {
    // missing or unreadable: no pushes known
  }
  return records;
}

function saveRecord(taskId: string, record: BranchPushRecord): void {
  const all = loadRecords();
  all.set(taskId, record);
  if (!storeFile) return;
  try {
    mkdirSync(path.dirname(storeFile), { recursive: true });
    writeFileReplacingSync(storeFile, JSON.stringify(Object.fromEntries(all)));
  } catch {
    // kept in memory; the file catches up on the next push
  }
}

/** The last push of a task's branch (kept across restarts when a store file is set). */
export function lastBranchPush(taskId: string): BranchPushRecord | undefined {
  return loadRecords().get(taskId);
}

/** False when GitHub says the repository is no longer private (then recorded as public). */
async function stillPrivate(project: Project, deps: BranchPushDeps, now: number): Promise<boolean> {
  const repo = project.settings?.deploy?.repo;
  if (!repo || !deps.visibility) return true;
  const hit = visibilityChecks.get(project.id);
  let visibility = hit && now - hit.at < VISIBILITY_TTL_MS ? hit.visibility : undefined;
  if (!visibility) {
    try {
      visibility = await deps.visibility(repo.owner, repo.repo);
    } catch {
      // Unknown visibility fails closed (never push to a public repo); asked again on the next push
      return false;
    }
    visibilityChecks.set(project.id, { at: now, visibility });
  }
  if (visibility === 'private') return true;
  try {
    deps.markPublic?.(project.id, { ...repo, public: true });
  } catch {
    // the cached answer still stops pushes for an hour
  }
  return false;
}

async function pushOnce(project: Project, task: Task, deps: BranchPushDeps): Promise<BranchPushRecord> {
  const branch = `${TASK_BRANCH_PREFIX}${task.specId}`;
  const deploy = project.settings?.deploy;
  const prev = loadRecords().get(task.id);
  let at = '';
  let record: BranchPushRecord;
  try {
    const nowDate = deps.now?.() ?? new Date();
    at = nowDate.toISOString();
    if (!deploy?.repo) throw new GitHubWriteError('unavailable', 'No repository');
    if (!(await stillPrivate(project, deps, nowDate.getTime()))) {
      try {
        deps.emit(project.id, task.id);
      } catch {
        // informational
      }
      return prev ?? {};
    }
    // Read before the push: the recorded sha is what was pushed
    const sha = await deps.head(project.path, branch).catch(() => undefined);
    // Already on GitHub: nothing to push
    if (sha && prev?.sha === sha && !prev.error) return prev;
    await deps.push(project.path, `https://github.com/${deploy.repo.owner}/${deploy.repo.repo}.git`, `${branch}:${branch}`);
    // A failed read before the push: what the branch points at now is at least what was pushed
    const pushed = sha ?? (await deps.head(project.path, branch).catch(() => undefined));
    record = pushed ? { sha: pushed, at } : { at };
  } catch (e) {
    // The last successful push stays: its preview is still valid
    record = {
      ...(prev?.sha ? { sha: prev.sha, ...(prev.at ? { at: prev.at } : {}) } : at ? { at } : {}),
      error: { kind: e instanceof GitHubWriteError ? e.kind : 'unavailable' },
    };
  }
  saveRecord(task.id, record);
  try {
    deps.emit(project.id, task.id);
  } catch {
    // informational
  }
  return record;
}

/** Never rejects. */
export async function pushTaskBranch(project: Project, task: Task, deps: BranchPushDeps): Promise<BranchPushRecord> {
  let state = states.get(task.id);
  if (!state) {
    state = { running: false };
    states.set(task.id, state);
  }
  if (state.running) {
    if (state.queued) {
      // Newest settings win: they are re-checked before the follow-up push
      state.queued.project = project;
      state.queued.task = task;
      return state.queued.promise;
    }
    let resolve!: (r: BranchPushRecord) => void;
    const promise = new Promise<BranchPushRecord>((r) => { resolve = r; });
    state.queued = { project, task, promise, resolve };
    return promise;
  }
  state.running = true;
  try {
    const first = await pushOnce(project, task, deps);
    while (state.queued) {
      const q = state.queued;
      state.queued = undefined;
      q.resolve(
        previewPushAllowed(q.project, q.task).allowed
          ? await pushOnce(q.project, q.task, deps)
          : (loadRecords().get(task.id) ?? {}),
      );
    }
    return first;
  } finally {
    state.running = false;
    states.delete(task.id);
  }
}

// ---- progress-driven wiring ----

type Lookup = (taskId: string) => { project?: Project; task?: Task };

let wiring: { deps: BranchPushDeps; lookup: Lookup } | undefined;
const completedSeen = new Map<string, number>();

/** Production (and tests) set the push dependencies and the task/project lookup once. */
export function setBranchPushDeps(deps: BranchPushDeps, lookup: Lookup): void {
  wiring = { deps, lookup };
  completedSeen.clear();
  visibilityChecks.clear();
}

/**
 * Pushes the task's branch when allowed (a coder or QA fixer session ended, or the task went
 * to review). The commit of a subtask comes after it is marked completed, so the push on
 * `onSubtasksProgress` alone would miss it. Never throws.
 */
export function requestPreviewPush(taskId: string): void {
  try {
    if (!wiring) return;
    const { project, task } = wiring.lookup(taskId);
    if (!project || !task || !previewPushAllowed(project, task).allowed) return;
    void pushTaskBranch(project, task, wiring.deps).catch(() => undefined);
  } catch {
    // never into the caller
  }
}

/** Pushes when `completed` grew since the last call for that task. Never throws. */
export function onSubtasksProgress(taskId: string, completed: number): void {
  try {
    const prev = completedSeen.get(taskId) ?? 0;
    // The plan was rewritten with fewer finished subtasks: count again from there
    if (completed < prev) completedSeen.set(taskId, completed);
    if (completed <= prev) return;
    if (!wiring) return;
    const { project, task } = wiring.lookup(taskId);
    if (!project || !task || !previewPushAllowed(project, task).allowed) return;
    // Remembered only once a push starts, so a task that becomes allowed later still pushes
    completedSeen.set(taskId, completed);
    void pushTaskBranch(project, task, wiring.deps).catch(() => undefined);
  } catch {
    // never into the file-watcher handler
  }
}
