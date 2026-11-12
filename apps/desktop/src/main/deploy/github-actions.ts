/**
 * Read-only GitHub Actions client for the Deploy view.
 * The fetcher is injected so the client is testable without the network.
 */
import { execFile } from 'child_process';
import type { Project } from '../../shared/types';
import type {
  DeployJob,
  DeployRun,
  DeployStatus,
  GitHubError,
} from '../../shared/types/deploy';
import { getGitHubConfigAsync, normalizeRepoReference } from '../ipc-handlers/github/utils';
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
  return { kind: 'unavailable', status, message: `GitHub API error ${status}${message ? `: ${message}` : ''}` };
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
    number: typeof r.run_number === 'number' ? r.run_number : 0,
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
  const headRepo = optStr((r.head_repository as Obj | null | undefined)?.full_name);
  if (headRepo) run.headRepo = headRepo;
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
      const started = optStr(s.started_at);
      if (started) step.startedAt = started;
      const completed = optStr(s.completed_at);
      if (completed) step.completedAt = completed;
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

  return {
    async runs(owner: string, repo: string, perPage = 20, branch?: string): Promise<DeployRun[]> {
      const filter = branch ? `&branch=${encodeURIComponent(branch)}` : '';
      const body = (await get(`/repos/${owner}/${repo}/actions/runs?per_page=${perPage}${filter}`)) as Obj;
      return arr(body?.workflow_runs).map(mapRun);
    },

    /** One run by id (a run older than the newest listed ones) */
    async run(owner: string, repo: string, runId: number): Promise<DeployRun> {
      return mapRun((await get(`/repos/${owner}/${repo}/actions/runs/${runId}`)) as Obj);
    },

    async jobs(owner: string, repo: string, runId: number): Promise<DeployJob[]> {
      const body = (await get(`/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=100`)) as Obj;
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
  };
}

export type ActionsClient = ReturnType<typeof createActionsClient>;

function parseOwnerRepo(ref: string): { owner: string; repo: string } | null {
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(normalizeRepoReference(ref));
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** git's stdout, without blocking the main thread. */
function gitOutput(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(getToolPath('git'), args, getIsolatedGitSpawnOptions(cwd, { timeout: 10_000 }), (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });
}

/** Repo of a project: GITHUB_REPO from its config, else the git origin; null when not GitHub. */
export async function resolveRepo(project: Project): Promise<{ owner: string; repo: string } | null> {
  const config = await getGitHubConfigAsync(project);
  if (config?.repo) {
    const parsed = parseOwnerRepo(config.repo);
    if (parsed) return parsed;
  }
  try {
    const url = (await gitOutput(['remote', 'get-url', 'origin'], project.path)).trim();
    if (!/^(https?:\/\/github\.com\/|git@github\.com:)/.test(url)) return null;
    return parseOwnerRepo(url);
  } catch {
    return null;
  }
}
