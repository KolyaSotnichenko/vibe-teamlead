/**
 * A task's CI status: the GitHub Actions runs of its branch for the last pushed commit (a run of
 * an older commit does not count). No run yet: `waiting`; one queued or in progress: `running`;
 * all finished and any not fine: `failed` (the newest failed run, with its failed job); else
 * `passed`. Nothing here pushes; the branch push is `branch-push.ts`. GitHub errors give `waiting`
 * and are never cached. `passed` and `failed` stay cached until the next push; `waiting` and
 * `running` for 30 s. Concurrent asks for one task share one read. One `runs` call per read, and
 * `jobs` only for the failed run. Only the 20 newest runs of the branch are read (a branch with
 * more newer runs than that for other commits would look run-less).
 *
 * No run of the pushed commit 10 minutes after the push means CI is not going to run for it (a
 * workflow not triggered by task branches, `[skip ci]`, path filters): `waiting` is then
 * `settled`, cached until the next push, and the renderer stops polling. The same age rule
 * settles a GitHub error. A GitHub re-run of a finished run on the same commit is not seen
 * until the next push: `passed` and `failed` stay cached.
 */
import { TASK_BRANCH_PREFIX } from '../../shared/constants/config';
import type { Project, Task } from '../../shared/types';
import type { TaskCiState } from '../../shared/types/deploy';
import { lastBranchPush, previewPushAllowed } from './branch-push';
import type { ActionsClient } from './github-actions';

export interface PreviewDeps {
  actions: Pick<ActionsClient, 'runs' | 'jobs'>;
  resolveRepo(project: Project): Promise<{ owner: string; repo: string } | null>;
  now?(): number;
}

const PREVIEW_STATUSES = new Set(['in_progress', 'ai_review', 'human_review', 'error']);
const LIVE_TTL_MS = 30_000;
const SETTLE_AFTER_MS = 10 * 60_000;
const FINE_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);

type Core = Exclude<TaskCiState, { state: 'not-set-up' | 'unavailable' | 'not-pushed' }>;
const cache = new Map<string, { key: string; at: number; core: Core }>();
const inFlight = new Map<string, { key: string; promise: Promise<Core | null> }>();

/** Drops a task's cached CI state (a new push makes it stale). */
export function invalidatePreview(taskId: string): void {
  cache.delete(taskId);
  inFlight.delete(taskId);
}

/** True when the push is older than the point after which a missing run is not expected any more. */
function pushIsOld(pushedAt: string | undefined, now: number): boolean {
  const at = Date.parse(pushedAt ?? '');
  // a push without a usable time can never be told young: settle rather than poll forever
  return Number.isNaN(at) || now - at > SETTLE_AFTER_MS;
}

async function compute(project: Project, branch: string, deps: PreviewDeps, pushedSha: string, old: boolean): Promise<Core | null> {
  const repo = await deps.resolveRepo(project);
  if (!repo) return null;
  const mine = (await deps.actions.runs(repo.owner, repo.repo, 20, branch)).filter((r) => r.sha === pushedSha);
  if (!mine.length) return old ? { state: 'waiting', settled: true } : { state: 'waiting' };
  if (mine.some((r) => r.status !== 'completed')) return { state: 'running' };
  const failedRun = mine.find((r) => !FINE_CONCLUSIONS.has(r.conclusion ?? ''));
  if (!failedRun) return { state: 'passed' };
  try {
    const jobs = await deps.actions.jobs(repo.owner, repo.repo, failedRun.id);
    const job = jobs.find((j) => !FINE_CONCLUSIONS.has(j.conclusion ?? ''));
    return job ? { state: 'failed', runId: failedRun.id, jobId: job.id } : { state: 'failed', runId: failedRun.id };
  } catch {
    return { state: 'failed', runId: failedRun.id };
  }
}

export async function previewState(project: Project, task: Task, deps: PreviewDeps): Promise<TaskCiState> {
  const allowed = previewPushAllowed(project, task);
  if (!allowed.allowed) {
    return allowed.reason === 'not-set-up' ? { state: 'not-set-up' } : { state: 'unavailable', reason: allowed.reason };
  }
  const push = lastBranchPush(task.id);
  const pushError = push?.error?.kind;
  const withError = <T extends TaskCiState>(s: T): T => (pushError ? { ...s, pushError } : s);
  const pushed = !!push?.sha;
  if (!PREVIEW_STATUSES.has(task.status) || !pushed) return withError({ state: 'not-pushed' });

  const key = `${push.sha ?? ''}|${push.at ?? ''}`;
  const now = (deps.now ?? Date.now)();
  const hit = cache.get(task.id);
  if (hit && hit.key === key && ((hit.core.state === 'waiting' ? !!hit.core.settled : hit.core.state !== 'running') || now - hit.at < LIVE_TTL_MS)) {
    return withError({ ...hit.core });
  }

  let flight = inFlight.get(task.id);
  if (!flight || flight.key !== key) {
    const promise = compute(project, `${TASK_BRANCH_PREFIX}${task.specId}`, deps, push.sha as string, pushIsOld(push.at, now)).catch(() => null);
    flight = { key, promise };
    inFlight.set(task.id, flight);
    const mine = flight;
    void promise.then((core) => {
      if (inFlight.get(task.id) !== mine) return;
      inFlight.delete(task.id);
      if (core) cache.set(task.id, { key, at: now, core });
    });
  }
  const core = await flight.promise;
  return withError(core ? { ...core } : pushIsOld(push.at, now) ? { state: 'waiting', settled: true } : { state: 'waiting' });
}
