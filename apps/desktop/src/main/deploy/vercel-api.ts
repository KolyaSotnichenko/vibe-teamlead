/**
 * Vercel REST client for the Deploy view: project setup, env vars, production URL.
 * The fetcher and the token provider are injected so tests never touch the network
 * or Electron. Failures are thrown as VercelError; messages never contain the token
 * or an env value. A 401 is retried once after asking the provider for a fresh token
 * (the CLI refreshes only after expiry, so a token can expire mid-call).
 */
import type { VercelEnvTarget, VercelError } from '../../shared/types/deploy';

const API = 'https://api.vercel.com';
/** Vercel's own GitHub App (not the Vibe Teamlead App): what Vercel needs to read the repo. */
const VERCEL_GITHUB_APP_INSTALL_URL = 'https://github.com/apps/vercel/installations/new';
/** Pages of 100 read at most by listProjectsForRepo. */
const MAX_PROJECT_PAGES = 5;

export interface VercelResponse {
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}
export type VercelFetcher = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<VercelResponse>;
export type VercelTokenProvider = () => Promise<string | null>;

export interface VercelClient {
  /** By id or name. `createdAt` in ms since the epoch. */
  findProject(idOrName: string): Promise<{ id: string; name: string; createdAt?: number; link?: { repo: string } } | null>;
  /** Projects linked to the GitHub repo `owner/name` (any project name). */
  listProjectsForRepo(repo: string): Promise<Array<{ id: string; name: string; createdAt?: number }>>;
  createProject(input: { name: string; repo: string; framework?: string | null; rootDirectory?: string | null }): Promise<{ id: string; name: string }>;
  upsertEnv(projectId: string, input: { key: string; value: string; targets: VercelEnvTarget[]; sensitive: boolean }): Promise<void>;
  listEnvNames(projectId: string): Promise<Array<{ key: string; targets: string[] }>>;
  latestProductionUrl(projectId: string): Promise<string | null>;
}

export const defaultVercelFetcher: VercelFetcher = (url, init) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });

export function isVercelError(e: unknown): e is VercelError {
  return typeof e === 'object' && e !== null && typeof (e as VercelError).kind === 'string' && typeof (e as VercelError).message === 'string';
}

/** Only links to GitHub or Vercel over https are offered as an action. */
function safeActionUrl(link: unknown): string {
  if (typeof link === 'string') {
    try {
      const u = new URL(link);
      if (u.protocol === 'https:' && ['github.com', 'vercel.com'].some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))) return u.toString();
    } catch {
      /* fall through */
    }
  }
  return VERCEL_GITHUB_APP_INSTALL_URL;
}

const defaultTokenProvider: VercelTokenProvider = async () => {
  // Lazy: keeps Electron out of tests that inject their own provider.
  const { getVercelToken } = await import('./vercel-credential');
  return getVercelToken();
};

/**
 * Error codes / messages that mean the Vercel GitHub App cannot reach the repo.
 * Vercel documents the project-create 400 only as `bad_request` with a human message;
 * the message patterns ("install the GitHub integration", "Make sure the repository
 * exists and the Vercel GitHub App has access", "Login Connection") are what the API
 * returns in practice, and the codes below are best-effort (unverified against a live
 * account, by rule). A wrong guess degrades to the generic error, never a wrong action.
 */
const GIT_CODES = new Set(['repo_not_found', 'repository_not_found', 'incorrect_git_source_info', 'install_github_app', 'github_app_not_installed']);
const GIT_MESSAGE =
  /install the github (integration|app)|login connection|github app\b[^.]*\b(access|install|grant|permission)|\b(access|install|grant)\b[^.]*github app|repository (does not exist|not found)|make sure the repository exists/i;

function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('***');
  return out;
}

function fail(kind: VercelError['kind'], message: string, extra: Partial<VercelError> = {}): never {
  throw { kind, message, ...extra } satisfies VercelError;
}

interface RawProject {
  id: string;
  name: string;
  createdAt?: number;
  link?: { type?: string; org?: string; repo?: string };
}

function linkedRepo(p: RawProject): string | undefined {
  return p.link?.type === 'github' && p.link.repo ? (p.link.org ? `${p.link.org}/${p.link.repo}` : p.link.repo) : undefined;
}

export function createVercelClient(
  fetcher: VercelFetcher,
  scope: { teamId?: string },
  getToken: VercelTokenProvider = defaultTokenProvider,
): VercelClient {
  function url(path: string, query: Record<string, string> = {}): string {
    const params = new URLSearchParams(query);
    if (scope.teamId) params.set('teamId', scope.teamId);
    const qs = params.toString();
    return `${API}${path}${qs ? `?${qs}` : ''}`;
  }

  async function request(
    method: string,
    target: string,
    body?: unknown,
    secrets: string[] = [],
    opts: { git?: boolean } = {},
  ): Promise<unknown> {
    let retried = false;
    for (;;) {
      const token = await getToken();
      if (!token) fail('no-connection', 'Vercel is not connected');
      const all = [token, ...secrets];
      let res: VercelResponse;
      try {
        res = await fetcher(target, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch {
        fail('unavailable', 'Could not reach Vercel');
      }
      if (res.status === 401) {
        if (!retried) {
          retried = true;
          continue;
        }
        fail('no-connection', 'Vercel rejected the sign-in');
      }
      if (res.status >= 200 && res.status < 300) {
        try {
          return await res.json();
        } catch {
          return {};
        }
      }
      let payload: { error?: { code?: string; message?: string; link?: string } } = {};
      try {
        payload = ((await res.json()) ?? {}) as typeof payload;
      } catch {
        /* no body */
      }
      const code = payload.error?.code ?? '';
      const message = redact(payload.error?.message ?? `Vercel answered ${res.status}`, all);
      if (res.status === 429) {
        const reset = Number(res.headers.get('x-ratelimit-reset'));
        fail('rate-limit', message, Number.isFinite(reset) && reset > 0 ? { resetAt: new Date(reset * 1000).toISOString() } : {});
      }
      if (res.status === 403) fail('forbidden', message);
      if (res.status === 409) fail('conflict', message);
      if (opts.git && res.status < 500 && (GIT_CODES.has(code) || GIT_MESSAGE.test(message))) {
        fail('git-not-connected', message, { actionUrl: safeActionUrl(payload.error?.link) });
      }
      if (res.status === 404) fail('not-found', message);
      if (res.status < 500) fail('bad-request', message);
      fail('unavailable', message);
    }
  }

  return {
    async findProject(name) {
      try {
        const p = (await request('GET', url(`/v9/projects/${encodeURIComponent(name)}`))) as RawProject;
        const repo = linkedRepo(p);
        return { id: p.id, name: p.name, ...(typeof p.createdAt === 'number' ? { createdAt: p.createdAt } : {}), ...(repo ? { link: { repo } } : {}) };
      } catch (e) {
        if ((e as VercelError).kind === 'not-found') return null;
        throw e;
      }
    },

    async listProjectsForRepo(repo) {
      // Vercel's `repoUrl` filter narrows the list; the link is checked again here (unverified against a live account).
      const want = repo.toLowerCase();
      const out: Array<{ id: string; name: string; createdAt?: number }> = [];
      let from: string | undefined;
      for (let page = 0; page < MAX_PROJECT_PAGES; page++) {
        const r = (await request(
          'GET',
          url('/v10/projects', { repoUrl: `https://github.com/${repo}`, limit: '100', ...(from ? { from } : {}) }),
        )) as { projects?: RawProject[]; pagination?: { next?: number | string | null } };
        for (const p of r.projects ?? []) {
          if (linkedRepo(p)?.toLowerCase() === want) {
            out.push({ id: p.id, name: p.name, ...(typeof p.createdAt === 'number' ? { createdAt: p.createdAt } : {}) });
          }
        }
        const next = r.pagination?.next;
        if (next === null || next === undefined || next === '') break;
        from = String(next);
      }
      return out;
    },

    async createProject({ name, repo, framework, rootDirectory }) {
      const body: Record<string, unknown> = { name, gitRepository: { type: 'github', repo } };
      if (framework) body.framework = framework;
      if (rootDirectory) body.rootDirectory = rootDirectory;
      const p = (await request('POST', url('/v11/projects'), body, [], { git: true })) as { id?: string; name?: string };
      if (!p.id) fail('unavailable', 'Vercel answered without a project id');
      return { id: p.id, name: p.name ?? name };
    },

    async upsertEnv(projectId, { key, value, targets, sensitive }) {
      await request(
        'POST',
        url(`/v10/projects/${encodeURIComponent(projectId)}/env`, { upsert: 'true' }),
        { key, value, target: targets, type: sensitive ? 'sensitive' : 'encrypted' },
        [value],
      );
    },

    async listEnvNames(projectId) {
      const r = (await request('GET', url(`/v10/projects/${encodeURIComponent(projectId)}/env`))) as {
        envs?: Array<{ key: string; target?: string | string[] }>;
      };
      // Only key and target are copied: the API may include value/decrypted.
      return (r.envs ?? []).map((e) => ({
        key: e.key,
        targets: Array.isArray(e.target) ? [...e.target] : e.target ? [e.target] : [],
      }));
    },

    async latestProductionUrl(projectId) {
      const r = (await request(
        'GET',
        url('/v6/deployments', { projectId, target: 'production', state: 'READY', limit: '1' }),
      )) as { deployments?: Array<{ url?: string | null }> };
      const host = r.deployments?.[0]?.url;
      return host ? `https://${host}` : null;
    },
  };
}
