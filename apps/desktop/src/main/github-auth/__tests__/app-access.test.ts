import { describe, expect, it, vi } from 'vitest';

vi.mock('../token-store', () => ({ getValidAccessToken: vi.fn(async () => 'ghu_default') }));

import { getGitHubAppAccess } from '../app-access';

type Reply = { status?: number; body: unknown; next?: string };

function fakeFetch(routes: Record<string, Reply | Reply[]>) {
  const calls: { url: string; auth: string | undefined }[] = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, auth: headers.Authorization });
    const path = url.replace('https://api.github.com', '');
    const route = routes[path];
    const reply = Array.isArray(route) ? route.shift() : route;
    if (!reply) return { ok: false, status: 404, json: async () => ({}), headers: new Headers() };
    const status = reply.status ?? 200;
    const headersOut = new Headers(reply.next ? { link: `<${reply.next}>; rel="next"` } : {});
    return { ok: status < 400, status, json: async () => reply.body, headers: headersOut };
  });
  return Object.assign(impl, { calls });
}

const install = (id: number, login: string, selection: 'all' | 'selected', slug = 'vibe-teamlead-app') => ({
  id,
  app_slug: slug,
  account: { login },
  repository_selection: selection,
});

const getToken = async () => 'ghu_x';

describe('getGitHubAppAccess', () => {
  it('reports installed with the selection, using the app user token', async () => {
    const fetchImpl = fakeFetch({
      '/user/installations?per_page=100': { body: { total_count: 1, installations: [install(1, 'octocat', 'all')] } },
    });
    const access = await getGitHubAppAccess(undefined, { fetchImpl, getToken });
    expect(access).toEqual({ installed: true, repositorySelection: 'all' });
    expect(fetchImpl.calls[0].auth).toBe('Bearer ghu_x');
  });

  it('reports not installed when no installation is of this app', async () => {
    const fetchImpl = fakeFetch({
      '/user/installations?per_page=100': { body: { total_count: 1, installations: [install(1, 'octocat', 'all', 'other-app')] } },
    });
    expect(await getGitHubAppAccess(undefined, { fetchImpl, getToken })).toEqual({ installed: false });
  });

  it('a repository is reachable on an installation for all repositories', async () => {
    const fetchImpl = fakeFetch({
      '/user/installations?per_page=100': { body: { installations: [install(1, 'octocat', 'all')] } },
    });
    expect(await getGitHubAppAccess({ owner: 'octocat', repo: 'app' }, { fetchImpl, getToken })).toEqual({
      installed: true,
      repositorySelection: 'all',
      repoReachable: true,
    });
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it('selected repositories without the repo: not reachable', async () => {
    const fetchImpl = fakeFetch({
      '/user/installations?per_page=100': { body: { installations: [install(7, 'octocat', 'selected')] } },
      '/user/installations/7/repositories?per_page=100': { body: { repositories: [{ full_name: 'octocat/other' }] } },
    });
    expect(await getGitHubAppAccess({ owner: 'octocat', repo: 'app' }, { fetchImpl, getToken })).toEqual({
      installed: true,
      repositorySelection: 'selected',
      repoReachable: false,
    });
  });

  it('selected repositories with the repo (on a later page, any case): reachable', async () => {
    const fetchImpl = fakeFetch({
      '/user/installations?per_page=100': { body: { installations: [install(7, 'Octocat', 'selected')] } },
      '/user/installations/7/repositories?per_page=100': {
        body: { repositories: [{ full_name: 'octocat/other' }] },
        next: 'https://api.github.com/user/installations/7/repositories?per_page=100&page=2',
      },
      '/user/installations/7/repositories?per_page=100&page=2': { body: { repositories: [{ full_name: 'octocat/App' }] } },
    });
    expect(await getGitHubAppAccess({ owner: 'octocat', repo: 'app' }, { fetchImpl, getToken })).toEqual({
      installed: true,
      repositorySelection: 'selected',
      repoReachable: true,
    });
  });

  it('installed on another account only: not installed for this repository', async () => {
    const fetchImpl = fakeFetch({
      '/user/installations?per_page=100': { body: { installations: [install(1, 'octocat', 'all')] } },
    });
    expect(await getGitHubAppAccess({ owner: 'acme', repo: 'app' }, { fetchImpl, getToken })).toEqual({
      installed: false,
      repoReachable: false,
    });
  });

  it('returns an error (not "not installed") when GitHub fails', async () => {
    const fetchImpl = fakeFetch({ '/user/installations?per_page=100': { status: 500, body: {} } });
    const access = await getGitHubAppAccess(undefined, { fetchImpl, getToken });
    expect(access).toEqual({ error: expect.stringContaining('500') });
    expect('installed' in access).toBe(false);
  });

  it('returns an error when the network fails', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    });
    expect(await getGitHubAppAccess(undefined, { fetchImpl, getToken })).toEqual({ error: 'offline' });
  });

  it('returns an error when not signed in', async () => {
    const fetchImpl = fakeFetch({});
    const access = await getGitHubAppAccess(undefined, { fetchImpl, getToken: async () => null });
    expect(access).toHaveProperty('error');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses the stored token by default', async () => {
    const fetchImpl = fakeFetch({
      '/user/installations?per_page=100': { body: { installations: [] } },
    });
    await getGitHubAppAccess(undefined, { fetchImpl });
    expect(fetchImpl.calls[0].auth).toBe('Bearer ghu_default');
  });
});
