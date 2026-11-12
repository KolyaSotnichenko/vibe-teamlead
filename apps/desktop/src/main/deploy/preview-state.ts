/**
 * A task's preview state. GitHub Deployments and Vercel statuses are gone; until the CI-based
 * rebuild (plan 5, Task 5) a pushed branch is `failed` when its Actions run of the pushed commit
 * has a failed job, else `building`. Nothing here pushes; the branch push is `branch-push.ts`.
 * GitHub errors give `building` and are never cached. `failed` stays cached until the next push;
 * `building` for 30 s. Concurrent asks for one task share one read.
 */
import { TASK_BRANCH_PREFIX } from '../../shared/constants/config';
import type { Project, Task } from '../../shared/types';
import type { TaskPreview } from '../../shared/types/deploy';
import { lastBranchPush, previewPushAllowed } from './branch-push';
import type { ActionsClient } from './github-actions';

export interface PreviewDeps {
  actions: Pick<ActionsClient, 'runs' | 'jobs'>;
  resolveRepo(project: Project): Promise<{ owner: string; repo: string } | null>;
  now?(): number;
}

const PREVIEW_STATUSES = new Set(['in_progress', 'ai_review', 'human_review', 'error']);
const BUILDING_TTL_MS = 30_000;

type Core = Exclude<TaskPreview, { state: 'not-set-up' | 'unavailable' | 'not-pushed' }>;
const cache = new Map<string, { key: string; at: number; core: Core }>();
const inFlight = new Map<string, { key: string; promise: Promise<Core | null> }>();

/** Drops a task's cached preview (a new push makes it stale). */
export function invalidatePreview(taskId: string): void {
  cache.delete(taskId);
  inFlight.delete(taskId);
}

/** The failed Actions run of that commit (with its failed job), when there is one. */
async function failedLink(
  deps: PreviewDeps,
  owner: string,
  repo: string,
  branch: string,
  sha: string | undefined,
): Promise<{ runId: number; jobId: number } | null> {
  if (!sha) return null;
  const runs = await deps.actions.runs(owner, repo, 20, branch);
  for (const run of runs.filter((r) => r.sha === sha)) {
    const jobs = await deps.actions.jobs(owner, repo, run.id);
    const job = jobs.find((j) => j.conclusion === 'failure');
    if (job) return { runId: run.id, jobId: job.id };
  }
  return null;
}

async function compute(project: Project, branch: string, deps: PreviewDeps, pushedSha?: string): Promise<Core | null> {
  const repo = await deps.resolveRepo(project);
  if (!repo) return null;
  const failed = await failedLink(deps, repo.owner, repo.repo, branch, pushedSha);
  return failed ? { state: 'failed', ...failed } : { state: 'building' };
}

export async function previewState(project: Project, task: Task, deps: PreviewDeps): Promise<TaskPreview> {
  const allowed = previewPushAllowed(project, task);
  if (!allowed.allowed) {
    return allowed.reason === 'not-set-up' ? { state: 'not-set-up' } : { state: 'unavailable', reason: allowed.reason };
  }
  const push = lastBranchPush(task.id);
  const pushError = push?.error?.kind;
  const withError = <T extends TaskPreview>(s: T): T => (pushError ? { ...s, pushError } : s);
  const pushed = !!push?.sha;
  if (!PREVIEW_STATUSES.has(task.status) || !pushed) return withError({ state: 'not-pushed' });

  const key = `${push.sha ?? ''}|${push.at ?? ''}`;
  const now = (deps.now ?? Date.now)();
  const hit = cache.get(task.id);
  if (hit && hit.key === key && (hit.core.state !== 'building' || now - hit.at < BUILDING_TTL_MS)) {
    return withError({ ...hit.core });
  }

  let flight = inFlight.get(task.id);
  if (!flight || flight.key !== key) {
    const promise = compute(project, `${TASK_BRANCH_PREFIX}${task.specId}`, deps, push.sha).catch(() => null);
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
  return withError(core ? { ...core } : { state: 'building' });
}
