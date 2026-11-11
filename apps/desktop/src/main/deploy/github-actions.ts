/**
 * Read-only GitHub Actions client for the Deploy view.
 * The fetcher is injected so the client is testable without the network.
 */
import { execFileSync } from 'child_process';
import type { Project } from '../../shared/types';
import type {
  DeployDeployment,
  DeployDeploymentState,
  DeployJob,
  DeployRun,
  DeployStatus,
  GitHubError,
} from '../../shared/types/deploy';
import { getGitHubConfig, normalizeRepoReference } from '../ipc-handlers/github/utils';
import { getToolPath } from '../cli-tool-manager';
import { getIsolatedGitSpawnOptions } from '../utils/git-isolation';

export type GitHubFetcher = (
  endpoint: string
) => Promise<{ status: number; headers: Headers; body: unknown }>;

type Obj = Record<string, unknown>;

function messageOf(body: unknown): string {
  if (body && typeof body === 'object' && typeof (body as Obj).message === 'string') {
    return (body as Obj).message as string;
  }
  return typeof body === 'string' ? body.slice(0, 200) : '';
}

export function classifyGitHubError(status: number, headers: Headers, body: unknown): GitHubError {
  const message = messageOf(body);
  if (status === 403 || status === 429) {
    const retryAfter = Number(headers.get('retry-after'));
    if (headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(headers.get('x-ratelimit-reset'));
      return {
        kind: 'rate-limit',
        resetAt: Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : undefined,
        message: message || 'GitHub rate limit reached',
      };
    }
    if (headers.get('retry-after') && Number.isFinite(retryAfter) && retryAfter >= 0) {
      return {
        kind: 'rate-limit',
        resetAt: new Date(Date.now() + retryAfter * 1000).toISOString(),
        message: message || 'GitHub rate limit reached',
      };
    }
  }
  if (status === 429) return { kind: 'rate-limit', message: message || 'GitHub rate limit reached' };
  if (status === 401) {
    return { kind: 'no-connection', message: message || 'GitHub token is invalid or expired' };
  }
  if (status === 403) return { kind: 'permissions', message: message || 'GitHub denied access' };
  if (status === 404) return { kind: 'not-found', message: message || 'Not found' };
  return { kind: 'unavailable', message: `GitHub API error ${status}${message ? `: ${message}` : ''}` };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const optStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const STATUSES: readonly string[] = ['queued', 'in_progress', 'completed', 'waiting'];
/** Unknown statuses (requested, pending) count as queued. */
const toStatus = (v: unknown): DeployStatus =>
  (typeof v === 'string' && STATUSES.includes(v) ? v : 'queued') as DeployStatus;
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : []);

function mapRun(r: Obj): DeployRun {
  const run: DeployRun = {
    id: r.id as number,
    name: str(r.name),
    title: str(r.display_title) || str(r.name),
    branch: str(r.head_branch),
    sha: str(r.head_sha),
    event: str(r.event),
    status: toStatus(r.status),
    startedAt: str(r.run_started_at) || str(r.created_at),
    updatedAt: str(r.updated_at),
    htmlUrl: str(r.html_url),
    workflowPath: str(r.path).split('@')[0],
  };
  const conclusion = optStr(r.conclusion);
  if (conclusion) run.conclusion = conclusion;
  return run;
}

function mapJob(j: Obj): DeployJob {
  const job: DeployJob = {
    id: j.id as number,
    name: str(j.name),
    status: toStatus(j.status),
    steps: arr(j.steps).map((s) => {
      const step: DeployJob['steps'][number] = {
        name: str(s.name),
        status: toStatus(s.status),
        number: s.number as number,
      };
      const c = optStr(s.conclusion);
      if (c) step.conclusion = c;
      return step;
    }),
  };
  const conclusion = optStr(j.conclusion);
  if (conclusion) job.conclusion = conclusion;
  const startedAt = optStr(j.started_at);
  if (startedAt) job.startedAt = startedAt;
  const completedAt = optStr(j.completed_at);
  if (completedAt) job.completedAt = completedAt;
  return job;
}

const enc = (p: string): string => p.split('/').map(encodeURIComponent).join('/');

export function createActionsClient(fetcher: GitHubFetcher) {
  async function get(endpoint: string): Promise<unknown> {
    const res = await fetcher(endpoint);
    if (res.status >= 200 && res.status < 300) return res.body;
    throw classifyGitHubError(res.status, res.headers, res.body);
  }

  async function latestStatus(owner: string, repo: string, id: unknown): Promise<Obj | null> {
    const statuses = arr(await get(`/repos/${owner}/${repo}/deployments/${id}/statuses?per_page=1`));
    return statuses[0] ?? null;
  }

  function mapDeployment(d: Obj, status: Obj | null): DeployDeployment {
    const out: DeployDeployment = {
      environment: str(d.environment),
      state: (str(status?.state) || 'pending') as DeployDeploymentState,
      createdAt: str(d.created_at),
    };
    const url = optStr(status?.environment_url);
    if (url) out.url = url;
    const logUrl = optStr(status?.log_url);
    if (logUrl) out.logUrl = logUrl;
    return out;
  }

  return {
    async runs(owner: string, repo: string, perPage = 20): Promise<DeployRun[]> {
      const body = (await get(`/repos/${owner}/${repo}/actions/runs?per_page=${perPage}`)) as Obj;
      return arr(body?.workflow_runs).map(mapRun);
    },

    async jobs(owner: string, repo: string, runId: number): Promise<DeployJob[]> {
      const body = (await get(`/repos/${owner}/${repo}/actions/runs/${runId}/jobs`)) as Obj;
      return arr(body?.jobs).map(mapJob);
    },

    async workflowFile(owner: string, repo: string, path: string, sha: string): Promise<string | null> {
      try {
        const body = (await get(
          `/repos/${owner}/${repo}/contents/${enc(path)}?ref=${encodeURIComponent(sha)}`
        )) as Obj;
        if (typeof body?.content !== 'string') return null;
        return Buffer.from(body.content.replace(/\n/g, ''), 'base64').toString('utf-8');
      } catch (e) {
        if ((e as GitHubError).kind === 'not-found') return null;
        throw e;
      }
    },

    async jobLog(owner: string, repo: string, jobId: number): Promise<string | null> {
      try {
        const body = await get(`/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`);
        return typeof body === 'string' ? body : null;
      } catch (e) {
        if ((e as GitHubError).kind === 'not-found') return null;
        throw e;
      }
    },

    async deployments(owner: string, repo: string, sha: string): Promise<DeployDeployment[]> {
      const list = arr(await get(`/repos/${owner}/${repo}/deployments?sha=${encodeURIComponent(sha)}`));
      return Promise.all(
        list.map(async (d) => mapDeployment(d, await latestStatus(owner, repo, d.id)))
      );
    },

    async productionUrl(owner: string, repo: string): Promise<string | null> {
      const list = arr(await get(`/repos/${owner}/${repo}/deployments?per_page=30`))
        .filter((d) => /^production$/i.test(str(d.environment)))
        .sort((a, b) => str(b.created_at).localeCompare(str(a.created_at)));
      for (const d of list) {
        const status = await latestStatus(owner, repo, d.id);
        const url = status?.state === 'success' ? optStr(status.environment_url) : undefined;
        if (url) return url;
      }
      return null;
    },
  };
}

export type ActionsClient = ReturnType<typeof createActionsClient>;

function parseOwnerRepo(ref: string): { owner: string; repo: string } | null {
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(normalizeRepoReference(ref));
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** Repo of a project: GITHUB_REPO from its config, else the git origin; null when not GitHub. */
export async function resolveRepo(project: Project): Promise<{ owner: string; repo: string } | null> {
  const config = getGitHubConfig(project);
  if (config?.repo) {
    const parsed = parseOwnerRepo(config.repo);
    if (parsed) return parsed;
  }
  try {
    const url = String(
      execFileSync(
        getToolPath('git'),
        ['remote', 'get-url', 'origin'],
        getIsolatedGitSpawnOptions(project.path)
      )
    ).trim();
    if (!/^(https?:\/\/github\.com\/|git@github\.com:)/.test(url)) return null;
    return parseOwnerRepo(url);
  } catch {
    return null;
  }
}
