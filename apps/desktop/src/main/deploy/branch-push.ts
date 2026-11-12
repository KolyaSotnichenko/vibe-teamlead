/**
 * Push a task's branch to GitHub after each finished subtask, so Vercel builds a preview.
 *
 * Per task, one push runs at a time; requests made meanwhile share ONE follow-up push
 * (which carries the newest commit). Nothing here throws into the caller: the outcome is
 * recorded per task and announced through `emit`.
 */
import type { Project, Task } from '../../shared/types';
import { TASK_BRANCH_PREFIX } from '../../shared/constants/config';
import { GitHubWriteError, pushWithAppToken } from './github-write';
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
}

export type PreviewPushAllowed =
  | { allowed: true }
  | { allowed: false; reason: 'not-set-up' | 'public-repo' | 'push-off' };

export function previewPushAllowed(project: Project, task: Task): PreviewPushAllowed {
  const deploy = project.settings?.deploy;
  if (!deploy?.enabled || !deploy.repo) return { allowed: false, reason: 'not-set-up' };
  // Only a repository known to be private gets pushes; unknown visibility fails closed
  if (deploy.repo.public !== false) return { allowed: false, reason: 'public-repo' };
  if (project.settings?.pushNewBranches === false || task.metadata?.pushNewBranches === false) {
    return { allowed: false, reason: 'push-off' };
  }
  return { allowed: true };
}

interface TaskState {
  running: boolean;
  queued?: { project: Project; task: Task; promise: Promise<BranchPushRecord>; resolve: (r: BranchPushRecord) => void };
}

const states = new Map<string, TaskState>();
const records = new Map<string, BranchPushRecord>();

/** The last push of a task's branch in this app session. */
export function lastBranchPush(taskId: string): BranchPushRecord | undefined {
  return records.get(taskId);
}

async function pushOnce(project: Project, task: Task, deps: BranchPushDeps): Promise<BranchPushRecord> {
  const branch = `${TASK_BRANCH_PREFIX}${task.specId}`;
  const deploy = project.settings?.deploy;
  let at = '';
  let record: BranchPushRecord;
  try {
    at = (deps.now?.() ?? new Date()).toISOString();
    if (!deploy?.repo) throw new GitHubWriteError('unavailable', 'No repository');
    // Read before the push: the recorded sha is what was pushed
    const sha = await deps.head(project.path, branch).catch(() => undefined);
    await deps.push(project.path, `https://github.com/${deploy.repo.owner}/${deploy.repo.repo}.git`, `${branch}:${branch}`);
    record = sha ? { sha, at } : { at };
  } catch (e) {
    // The last successful push stays: its preview is still valid
    const prev = records.get(task.id);
    record = {
      ...(prev?.sha ? { sha: prev.sha, ...(prev.at ? { at: prev.at } : {}) } : at ? { at } : {}),
      error: { kind: e instanceof GitHubWriteError ? e.kind : 'unavailable' },
    };
  }
  records.set(task.id, record);
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
          : (records.get(task.id) ?? {}),
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
