/**
 * A task's preview, from the GitHub Deployments of its branch (Vercel reports them).
 * Nothing here pushes; the branch push is `branch-push.ts`. GitHub errors give `building`
 * (the preview may still arrive) and are never cached.
 */
import { TASK_BRANCH_PREFIX } from '../../shared/constants/config';
import type { Project, Task } from '../../shared/types';
import type { DeployDeployment, TaskPreview } from '../../shared/types/deploy';
import { lastBranchPush, previewPushAllowed } from './branch-push';
import type { ActionsClient } from './github-actions';

export interface PreviewDeps {
  actions: Pick<ActionsClient, 'deploymentsForRef' | 'runs' | 'jobs'>;
  resolveRepo(project: Project): Promise<{ owner: string; repo: string } | null>;
  now?(): number;
}

const PREVIEW_STATUSES = new Set(['in_progress', 'ai_review', 'human_review', 'error']);
const TTL_MS = 30_000;

type Core = Exclude<TaskPreview, { state: 'not-set-up' | 'unavailable' | 'not-pushed' }>;
const cache = new Map<string, { key: string; at: number; core: Core }>();

/** Drops a task's cached preview (a new push makes it stale). */
export function invalidatePreview(taskId: string): void {
  cache.delete(taskId);
}

async function failedLink(
  deps: PreviewDeps,
  owner: string,
  repo: string,
  branch: string,
  sha: string | undefined,
): Promise<{ runId?: number; jobId?: number }> {
  try {
    const runs = await deps.actions.runs(owner, repo, 20, branch);
    const run = (sha ? runs.find((r) => r.sha === sha) : undefined) ?? runs[0];
    if (!run) return {};
    const jobs = await deps.actions.jobs(owner, repo, run.id);
    const job = jobs.find((j) => j.conclusion === 'failure');
    return job ? { runId: run.id, jobId: job.id } : { runId: run.id };
  } catch {
    return {};
  }
}

async function compute(project: Project, branch: string, deps: PreviewDeps): Promise<Core | null> {
  const repo = await deps.resolveRepo(project);
  if (!repo) return null;
  const all = await deps.actions.deploymentsForRef(repo.owner, repo.repo, branch);
  const list = all
    .filter((d: DeployDeployment) => !/^production$/i.test(d.environment))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const newest = list[0];
  if (!newest) return { state: 'building' };
  if (newest.state === 'success' && newest.url) {
    return { state: 'ready', url: newest.url, builtAt: newest.createdAt };
  }
  if (newest.state === 'failure' || newest.state === 'error') {
    return { state: 'failed', ...(await failedLink(deps, repo.owner, repo.repo, branch, newest.sha)) };
  }
  const previous = list.slice(1).find((d) => d.state === 'success' && d.url);
  return previous?.url ? { state: 'building', previousUrl: previous.url } : { state: 'building' };
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
  if (hit && hit.key === key && now - hit.at < TTL_MS) return withError({ ...hit.core });

  try {
    const core = await compute(project, `${TASK_BRANCH_PREFIX}${task.specId}`, deps);
    if (!core) return withError({ state: 'building' });
    cache.set(task.id, { key, at: now, core });
    return withError({ ...core });
  } catch {
    return withError({ state: 'building' });
  }
}
