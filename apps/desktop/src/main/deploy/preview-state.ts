/**
 * A task's preview, from the GitHub Deployments of its branch (Vercel reports them), else from
 * Vercel's commit status of the branch head (Vercel's Git integration may report only that).
 * Nothing here pushes; the branch push is `branch-push.ts`. GitHub errors give `building`
 * (the preview may still arrive) and are never cached.
 *
 * Cost: one list call (5 deployments), then statuses newest first, only until the answer is
 * known; with no deployment, one call for the commit statuses. `ready`, `built` and `failed` stay
 * cached until the next push; `building` for 30 s.
 * Concurrent asks for one task share one read.
 */
import { TASK_BRANCH_PREFIX } from '../../shared/constants/config';
import type { Project, Task } from '../../shared/types';
import type { DeployDeploymentStatus, TaskPreview } from '../../shared/types/deploy';
import { lastBranchPush, previewPushAllowed } from './branch-push';
import type { ActionsClient } from './github-actions';

export interface PreviewDeps {
  actions: Pick<ActionsClient, 'refDeployments' | 'deploymentStatus' | 'runs' | 'jobs' | 'commitStatuses'>;
  resolveRepo(project: Project): Promise<{ owner: string; repo: string } | null>;
  now?(): number;
}

const PREVIEW_STATUSES = new Set(['in_progress', 'ai_review', 'human_review', 'error']);
const BUILDING_TTL_MS = 30_000;
const PAGE = 5;

type Core = Exclude<TaskPreview, { state: 'not-set-up' | 'unavailable' | 'not-pushed' }>;
const cache = new Map<string, { key: string; at: number; core: Core }>();
const inFlight = new Map<string, { key: string; promise: Promise<Core | null> }>();

/** Drops a task's cached preview (a new push makes it stale). */
export function invalidatePreview(taskId: string): void {
  cache.delete(taskId);
  inFlight.delete(taskId);
}

const isHttps = (url: string | undefined): url is string => {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.username && !u.password;
  } catch {
    return false;
  }
};

/** Built and reachable: `inactive` too, as GitHub retires older deployments of the shared Preview environment. */
const isReady = (s: DeployDeploymentStatus): boolean => (s.state === 'success' || s.state === 'inactive') && isHttps(s.url);

/**
 * The failed Actions run of that commit (with its failed job), when there is one; else
 * Vercel's build log. Vercel's Git integration builds previews, so usually there is no run.
 */
async function failedLink(
  deps: PreviewDeps,
  owner: string,
  repo: string,
  branch: string,
  sha: string | undefined,
  logUrl: string | undefined,
): Promise<{ runId?: number; jobId?: number; logUrl?: string }> {
  const log = isHttps(logUrl) ? { logUrl } : {};
  if (!sha) return log;
  try {
    const runs = await deps.actions.runs(owner, repo, 20, branch);
    for (const run of runs.filter((r) => r.sha === sha)) {
      const jobs = await deps.actions.jobs(owner, repo, run.id);
      const job = jobs.find((j) => j.conclusion === 'failure');
      if (job) return { runId: run.id, jobId: job.id };
    }
  } catch {
    // the build log still says why
  }
  return log;
}

/**
 * Vercel's commit status of the branch head, for a repository where Vercel makes no GitHub
 * Deployment. A status has no preview address: `ready` only when one is known, else `built` with
 * Vercel's page for the deployment (no URL is guessed).
 */
async function fromCommitStatus(deps: PreviewDeps, owner: string, repo: string, branch: string, sha: string | undefined): Promise<Core> {
  // The pushed commit's statuses (the branch head may have moved on); one per Vercel context
  const statuses = await deps.actions.commitStatuses(owner, repo, sha ?? branch);
  // Several Vercel projects on one repository: a failure wins, then one still building
  const status =
    statuses.find((s) => s.state === 'failure' || s.state === 'error') ??
    statuses.find((s) => s.state !== 'success') ??
    statuses[0];
  if (!status) return { state: 'building' };
  const logUrl = onHost(status.logUrl, (host) => host === 'vercel.com');
  if (status.state === 'failure' || status.state === 'error') {
    return { state: 'failed', ...(await failedLink(deps, owner, repo, branch, sha, logUrl)) };
  }
  if (status.state === 'success') {
    const url = onHost(status.url, (host) => host.endsWith('.vercel.app'));
    if (url) return { state: 'ready', url, builtAt: status.createdAt };
    if (logUrl) return { state: 'built', logUrl, builtAt: status.createdAt };
  }
  return { state: 'building' };
}

/** An https link on an expected host (Vercel's own pages and preview addresses only), else undefined */
function onHost(url: string | undefined, allowed: (host: string) => boolean): string | undefined {
  return isHttps(url) && allowed(new URL(url).hostname.toLowerCase()) ? url : undefined;
}

async function compute(project: Project, branch: string, deps: PreviewDeps, pushedSha?: string): Promise<Core | null> {
  const repo = await deps.resolveRepo(project);
  if (!repo) return null;
  const list = (await deps.actions.refDeployments(repo.owner, repo.repo, branch, PAGE))
    .filter((d) => !/^production$/i.test(d.environment))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const newest = list[0];
  if (!newest) return fromCommitStatus(deps, repo.owner, repo.repo, branch, pushedSha);
  const status = await deps.actions.deploymentStatus(repo.owner, repo.repo, newest.id);
  if (isReady(status)) return { state: 'ready', url: status.url as string, builtAt: newest.createdAt };
  if (status.state === 'failure' || status.state === 'error') {
    return { state: 'failed', ...(await failedLink(deps, repo.owner, repo.repo, branch, newest.sha, status.logUrl)) };
  }
  // Building: the newest older preview that is ready, asked for one at a time
  for (const older of list.slice(1)) {
    const s = await deps.actions.deploymentStatus(repo.owner, repo.repo, older.id);
    if (isReady(s)) return { state: 'building', previousUrl: s.url as string };
  }
  return { state: 'building' };
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
