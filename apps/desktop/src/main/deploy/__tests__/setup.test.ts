import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../../shared/types';
import type { DeployProjectSettings, VercelError } from '../../../shared/types/deploy';
import type { VercelClient } from '../vercel-api';
import { GitHubWriteError } from '../github-write';
import { classifyRemote, readGitInfo, saveDeployPatch, setUpDeploy, type GitInfo, type SetupDeps } from '../setup';

const NOW = new Date('2026-11-11T10:00:00.000Z');
const DAY = 24 * 3600 * 1000;

function project(settings: Partial<Project['settings']> = {}): Project {
  return {
    id: 'p1',
    name: 'My App',
    path: '/projects/my-app',
    autoBuildPath: '.auto-claude',
    settings: {
      model: 'opus',
      memoryBackend: 'file',
      linearSync: false,
      notifications: { onTaskComplete: true, onTaskFailed: true, onReviewNeeded: true, sound: false },
      ...settings,
    },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

type FakeProject = { id: string; name: string; createdAt: number; link?: { repo: string } };

/** A fake GitHub + Vercel + local git: records what was created so re-runs can be checked. */
function world(opts: { origin?: string | null; git?: GitInfo | null; visibility?: 'private' | 'public' } = {}) {
  const state = {
    now: NOW,
    origin: opts.origin ?? null,
    /** Repos created by createPrivateRepo, by name. */
    repos: [] as string[],
    /** Every repo on the fake GitHub, by `owner/name`. */
    github: new Map<string, { private: boolean; createdAt: string; empty: boolean }>(),
    pushes: [] as Array<{ url: string; refspec: string }>,
    projects: new Map<string, FakeProject>(),
    saved: undefined as DeployProjectSettings | undefined,
    crash: new Set<string>(),
  };
  const crash = (point: string) => {
    if (state.crash.has(point)) throw new Error(`crash at ${point}`);
  };
  let projectSeq = 0;
  let saves = 0;
  const client: VercelClient = {
    findProject: vi.fn(async (idOrName: string) => {
      crash('findProject');
      for (const p of state.projects.values()) if (p.id === idOrName || p.name === idOrName) return structuredClone(p);
      return null;
    }),
    listProjectsForRepo: vi.fn(async (repo: string) =>
      [...state.projects.values()]
        .filter((p) => p.link?.repo.toLowerCase() === repo.toLowerCase())
        .map((p) => ({ id: p.id, name: p.name, createdAt: p.createdAt })),
    ),
    createProject: vi.fn(async ({ name, repo }: { name: string; repo: string }) => {
      crash('createProject:before');
      if (state.crash.has('git-not-connected')) {
        throw { kind: 'git-not-connected', message: 'Install the GitHub integration', actionUrl: 'https://github.com/apps/vercel/installations/new' } satisfies VercelError;
      }
      if ([...state.projects.values()].some((p) => p.name === name)) {
        throw { kind: 'conflict', message: `The project name ${name} already exists` } satisfies VercelError;
      }
      const p = { id: `prj_${++projectSeq}`, name, createdAt: state.now.getTime(), link: { repo } };
      state.projects.set(p.id, p);
      crash('createProject:after');
      return { id: p.id, name: p.name };
    }),
    upsertEnv: vi.fn(),
    listEnvNames: vi.fn(),
    latestProductionUrl: vi.fn(),
  };
  const deps: SetupDeps = {
    vercelStatus: vi.fn(async () => ({ connected: true, source: 'browser' as const, user: { username: 'nick' } })),
    vercelClient: vi.fn(() => client),
    isGitHubSignedIn: vi.fn(async () => true),
    githubLogin: vi.fn(async () => 'nick'),
    appAccess: vi.fn(async (repo?: { owner: string; repo: string }) =>
      repo ? { installed: true, repositorySelection: 'all' as const, repoReachable: true } : { installed: true, repositorySelection: 'all' as const },
    ),
    readGit: vi.fn(async () =>
      opts.git !== undefined ? opts.git : { originUrl: state.origin ?? undefined, branches: ['main'], head: 'main' },
    ),
    createPrivateRepo: vi.fn(async (name: string) => {
      crash('createRepo:before');
      for (let attempt = 1; attempt <= 5; attempt++) {
        const candidate = attempt === 1 ? name : `${name}-${attempt}`;
        if (state.github.has(`nick/${candidate}`)) continue;
        state.github.set(`nick/${candidate}`, { private: true, createdAt: state.now.toISOString(), empty: true });
        state.repos.push(candidate);
        crash('createRepo:after');
        return { owner: 'nick', repo: candidate, cloneUrl: `https://github.com/nick/${candidate}.git` };
      }
      throw new GitHubWriteError('conflict', 'taken');
    }),
    inspectRepo: vi.fn(async (owner: string, name: string) => state.github.get(`${owner}/${name}`) ?? null),
    repoVisibility: vi.fn(async () => opts.visibility ?? 'private'),
    addOriginIfMissing: vi.fn(async (_p: string, url: string) => {
      crash('addOrigin');
      if (state.origin) return false;
      state.origin = url;
      return true;
    }),
    pushWithAppToken: vi.fn(async (_p: string, url: string, refspec: string) => {
      crash('push');
      state.pushes.push({ url, refspec });
      const key = url.replace('https://github.com/', '').replace(/\.git$/, '');
      const repo = state.github.get(key);
      if (repo) repo.empty = false;
    }),
    saveSettings: vi.fn(async (patch: Partial<DeployProjectSettings>) => {
      crash(`save#${++saves}`);
      state.saved = structuredClone({ enabled: false, ...state.saved, ...patch });
    }),
    onProgress: vi.fn(),
    now: () => state.now,
  };
  return { state, deps, client };
}

describe('setUpDeploy', () => {
  it('with no remote: creates a private repo, adds origin, pushes main, creates the Vercel project, enables', async () => {
    const { state, deps, client } = world();
    const result = await setUpDeploy(project(), deps);

    expect(result.error).toBeUndefined();
    expect(result.needed).toEqual([]);
    expect(result.step).toBe('done');
    expect(state.repos).toEqual(['my-app']);
    expect(deps.addOriginIfMissing).toHaveBeenCalledWith('/projects/my-app', 'https://github.com/nick/my-app.git');
    expect(state.pushes).toEqual([{ url: 'https://github.com/nick/my-app.git', refspec: 'main' }]);
    expect(client.createProject).toHaveBeenCalledWith({ name: 'my-app', repo: 'nick/my-app' });
    expect(result.settings).toEqual({
      enabled: true,
      repo: { owner: 'nick', repo: 'my-app', createdByApp: true, public: false },
      vercel: { projectId: 'prj_1', projectName: 'my-app' },
      setUpAt: NOW.toISOString(),
    });
    expect(state.saved).toEqual(result.settings);
    expect(state.saved?.pendingRepo).toBeUndefined();
    expect(state.saved?.pendingVercel).toBeUndefined();
    for (const s of ['repo', 'push', 'vercel', 'done']) expect(deps.onProgress).toHaveBeenCalledWith(s);
  });

  it('records the pending repo (owner = token user) before creating it, and the repo before the push', async () => {
    const { state, deps } = world();
    state.crash.add('createRepo:before');
    await setUpDeploy(project(), deps);
    expect(state.saved?.pendingRepo).toEqual({ base: 'my-app', owner: 'nick', at: NOW.toISOString() });

    const b = world();
    b.state.crash.add('push');
    const result = await setUpDeploy(project(), b.deps);
    expect(result.error).toBeDefined();
    expect(result.step).toBe('push');
    expect(b.state.saved?.repo).toEqual({ owner: 'nick', repo: 'my-app', createdByApp: true, public: false });
    expect(b.state.saved?.pendingRepo).toBeUndefined();
    expect(b.state.saved?.enabled).toBe(false);
  });

  it.each([
    'createRepo:before',
    'createRepo:after',
    'save#1',
    'save#2',
    'addOrigin',
    'push',
    'findProject',
    'createProject:before',
    'createProject:after',
    'save#3',
    'save#4',
    'save#5',
  ])('re-running after a crash at %s creates nothing twice', async (point) => {
    const { state, deps } = world();
    state.crash.add(point);
    const first = await setUpDeploy(project(), deps);
    expect(first.error).toBeDefined();
    expect(first.settings.enabled).toBe(false);
    state.crash.clear();
    state.now = new Date(NOW.getTime() + 60_000);

    const second = await setUpDeploy(project({ deploy: state.saved }), deps);
    expect(second.error).toBeUndefined();
    expect(second.needed).toEqual([]);
    expect(second.step).toBe('done');
    expect(second.settings.enabled).toBe(true);
    expect(state.repos).toEqual(['my-app']);
    expect(state.projects.size).toBe(1);
    expect(second.settings.vercel?.projectId).toBe([...state.projects.values()][0].id);
    expect(state.origin).toBe('https://github.com/nick/my-app.git');
    expect(state.pushes.at(-1)).toEqual({ url: 'https://github.com/nick/my-app.git', refspec: 'main' });
  });

  it('an older empty private repo with the same name is not adopted: a new one is created', async () => {
    const { state, deps } = world();
    state.github.set('nick/my-app', { private: true, createdAt: new Date(NOW.getTime() - DAY).toISOString(), empty: true });
    state.crash.add('createRepo:before');
    await setUpDeploy(project(), deps);
    state.crash.clear();

    const result = await setUpDeploy(project({ deploy: state.saved }), deps);
    expect(result.step).toBe('done');
    expect(state.repos).toEqual(['my-app-2']);
    expect(result.settings.repo?.repo).toBe('my-app-2');
  });

  it('a recent repo with the pending name is not adopted when it is public or has branches', async () => {
    for (const meta of [
      { private: false, createdAt: NOW.toISOString(), empty: true },
      { private: true, createdAt: NOW.toISOString(), empty: false },
    ]) {
      const { state, deps } = world();
      state.crash.add('createRepo:before');
      await setUpDeploy(project(), deps);
      state.crash.clear();
      state.github.set('nick/my-app', meta);
      const result = await setUpDeploy(project({ deploy: state.saved }), deps);
      expect(result.settings.repo?.repo).toBe('my-app-2');
    }
  });

  it('a full re-run after success creates and pushes nothing', async () => {
    const { state, deps, client } = world();
    const first = await setUpDeploy(project(), deps);
    const pushes = state.pushes.length;
    const second = await setUpDeploy(project({ deploy: first.settings }), deps);
    expect(second.step).toBe('done');
    expect(second.settings.vercel).toEqual(first.settings.vercel);
    expect(deps.createPrivateRepo).toHaveBeenCalledTimes(1);
    expect(client.createProject).toHaveBeenCalledTimes(1);
    expect(state.pushes.length).toBe(pushes);
  });

  it('GitLab origin: non-github-remote, nothing created, nothing saved', async () => {
    const { state, deps, client } = world({ origin: 'git@gitlab.com:nick/my-app.git' });
    const result = await setUpDeploy(project(), deps);
    expect(result.needed.map((n) => n.kind)).toEqual(['non-github-remote']);
    expect(result.settings.enabled).toBe(false);
    expect(result.step).toBe('repo');
    expect(deps.createPrivateRepo).not.toHaveBeenCalled();
    expect(deps.pushWithAppToken).not.toHaveBeenCalled();
    expect(client.createProject).not.toHaveBeenCalled();
    expect(state.saved).toBeUndefined();
  });

  it('origin rewritten (pushurl / insteadOf): treated as non-GitHub', async () => {
    const { deps } = world({ git: { originUrl: 'https://github.com/acme/shop.git', originRewritten: true, branches: ['main'] } });
    const result = await setUpDeploy(project(), deps);
    expect(result.needed.map((n) => n.kind)).toEqual(['non-github-remote']);
    expect(deps.createPrivateRepo).not.toHaveBeenCalled();
  });

  it('config with include: stops with invalid, nothing created', async () => {
    const { deps } = world({ git: { originUnclear: true, branches: ['main'] } });
    const result = await setUpDeploy(project(), deps);
    expect(result.error?.kind).toBe('invalid');
    expect(deps.createPrivateRepo).not.toHaveBeenCalled();
  });

  it('existing GitHub origin: uses it, no repo created, no push', async () => {
    const { state, deps, client } = world({ origin: 'git@github.com:acme/shop.git' });
    const result = await setUpDeploy(project(), deps);
    expect(result.step).toBe('done');
    expect(result.needed).toEqual([]);
    expect(deps.createPrivateRepo).not.toHaveBeenCalled();
    expect(state.pushes).toEqual([]);
    expect(deps.appAccess).toHaveBeenCalledWith({ owner: 'acme', repo: 'shop' });
    expect(client.createProject).toHaveBeenCalledWith({ name: 'shop', repo: 'acme/shop' });
    expect(result.settings.repo).toEqual({ owner: 'acme', repo: 'shop', createdByApp: false, public: false });
  });

  it('public repo: a warning item, and setup continues', async () => {
    const { deps } = world({ origin: 'https://github.com/acme/shop.git', visibility: 'public' });
    const result = await setUpDeploy(project(), deps);
    expect(result.needed.map((n) => n.kind)).toEqual(['public-repo-warning']);
    expect(result.step).toBe('done');
    expect(result.settings.enabled).toBe(true);
    expect(result.settings.repo?.public).toBe(true);

    // Once: a re-run with the repo recorded doesn't warn again.
    const again = await setUpDeploy(project({ deploy: result.settings }), deps);
    expect(again.needed).toEqual([]);
  });

  it('Vercel git access missing: item with actionUrl, enabled stays false, repo kept', async () => {
    const { state, deps } = world();
    state.crash.add('git-not-connected');
    const result = await setUpDeploy(project(), deps);
    expect(result.error).toBeUndefined();
    expect(result.step).toBe('vercel');
    expect(result.needed).toEqual([
      expect.objectContaining({ kind: 'vercel-git-access', actionUrl: 'https://github.com/apps/vercel/installations/new' }),
    ]);
    expect(result.settings.enabled).toBe(false);
    expect(result.settings.vercel).toBeUndefined();
    expect(state.saved?.repo?.repo).toBe('my-app');
  });

  it('Vercel signed out: only the sign-in item, nothing else touched', async () => {
    const { deps } = world();
    deps.vercelStatus = vi.fn(async () => ({ connected: false }));
    const result = await setUpDeploy(project(), deps);
    expect(result.needed.map((n) => n.kind)).toEqual(['vercel-sign-in']);
    expect(result.settings.enabled).toBe(false);
    expect(deps.readGit).not.toHaveBeenCalled();
    expect(deps.createPrivateRepo).not.toHaveBeenCalled();
    expect(deps.saveSettings).not.toHaveBeenCalled();
  });

  it('Vercel unreachable: an error, not a sign-in item', async () => {
    const { deps } = world();
    deps.vercelStatus = vi.fn(async () => ({ connected: false, error: 'unavailable' as const }));
    const result = await setUpDeploy(project(), deps);
    expect(result.needed).toEqual([]);
    expect(result.error?.kind).toBe('unavailable');
  });

  it('GitHub signed out: github-sign-in', async () => {
    const { deps } = world();
    deps.isGitHubSignedIn = vi.fn(async () => false);
    const result = await setUpDeploy(project(), deps);
    expect(result.needed.map((n) => n.kind)).toEqual(['github-sign-in']);
    expect(deps.createPrivateRepo).not.toHaveBeenCalled();
  });

  it('GitHub App not reaching the existing repo: github-app-install with the install link', async () => {
    const { deps, client } = world({ origin: 'https://github.com/acme/shop' });
    deps.appAccess = vi.fn(async () => ({ installed: true, repositorySelection: 'selected' as const, repoReachable: false }));
    const result = await setUpDeploy(project(), deps);
    expect(result.needed).toEqual([expect.objectContaining({ kind: 'github-app-install', actionUrl: expect.stringContaining('https://github.com/apps/') })]);
    expect(client.createProject).not.toHaveBeenCalled();
  });

  it('GitHub App not installed and no remote: github-app-install, no repo created', async () => {
    const { deps } = world();
    deps.appAccess = vi.fn(async () => ({ installed: false }));
    const result = await setUpDeploy(project(), deps);
    expect(result.needed.map((n) => n.kind)).toEqual(['github-app-install']);
    expect(deps.createPrivateRepo).not.toHaveBeenCalled();
  });

  it('created repo not reachable by the App: github-app-install after the repo is recorded; a re-run does not create another', async () => {
    const { state, deps } = world();
    deps.appAccess = vi.fn(async (repo?: { owner: string; repo: string }) =>
      repo ? { installed: true, repositorySelection: 'selected' as const, repoReachable: false } : { installed: true, repositorySelection: 'selected' as const },
    );
    const result = await setUpDeploy(project(), deps);
    expect(result.needed.map((n) => n.kind)).toEqual(['github-app-install']);
    expect(state.pushes).toEqual([]);
    expect(state.saved?.repo?.createdByApp).toBe(true);

    deps.appAccess = vi.fn(async () => ({ installed: true, repositorySelection: 'all' as const, repoReachable: true }));
    const again = await setUpDeploy(project({ deploy: state.saved }), deps);
    expect(again.step).toBe('done');
    expect(state.repos).toEqual(['my-app']);
  });

  it('App access check failing: an error, never a guessed install item', async () => {
    const { deps } = world({ origin: 'https://github.com/acme/shop.git' });
    deps.appAccess = vi.fn(async () => ({ error: 'GitHub returned HTTP 502' }));
    const result = await setUpDeploy(project(), deps);
    expect(result.needed).toEqual([]);
    expect(result.error?.kind).toBe('unavailable');
  });

  it('not a git repository: an error, nothing created', async () => {
    const { deps } = world({ git: null });
    const result = await setUpDeploy(project(), deps);
    expect(result.error?.kind).toBe('invalid');
    expect(deps.createPrivateRepo).not.toHaveBeenCalled();
  });

  it('a project with no commits: a clear error before any repo is created', async () => {
    const { deps } = world({ git: { branches: [], head: 'main' } });
    const result = await setUpDeploy(project(), deps);
    expect(result.error).toEqual({ kind: 'invalid', message: expect.stringMatching(/no commits/i) });
    expect(deps.createPrivateRepo).not.toHaveBeenCalled();
    expect(deps.saveSettings).not.toHaveBeenCalled();
  });

  it('pushes the configured main branch, else main/master from refs', async () => {
    const a = world({ git: { branches: ['main', 'trunk'], head: 'main' } });
    await setUpDeploy(project({ mainBranch: 'trunk' }), a.deps);
    expect(a.state.pushes[0].refspec).toBe('trunk');

    const b = world({ git: { branches: ['master', 'feature'], head: 'feature' } });
    await setUpDeploy(project(), b.deps);
    expect(b.state.pushes[0].refspec).toBe('master');

    const c = world({ git: { branches: ['dev'], head: 'dev' } });
    await setUpDeploy(project(), c.deps);
    expect(c.state.pushes[0].refspec).toBe('dev');
  });

  it('the configured main branch missing locally: a clear error, nothing pushed', async () => {
    const { state, deps } = world();
    const result = await setUpDeploy(project({ mainBranch: 'trunk' }), deps);
    expect(result.error).toEqual({ kind: 'invalid', message: expect.stringContaining('trunk') });
    expect(state.pushes).toEqual([]);
  });

  it('uses the picked Vercel team and records it', async () => {
    const { deps } = world();
    const result = await setUpDeploy(project(), { ...deps, vercelTeamId: 'team_9' });
    expect(deps.vercelClient).toHaveBeenCalledWith({ teamId: 'team_9' });
    expect(result.settings.vercel?.teamId).toBe('team_9');
  });

  it('uses the recorded Vercel team over the picked one', async () => {
    const { deps } = world();
    const first = await setUpDeploy(project(), { ...deps, vercelTeamId: 'team_9' });
    await setUpDeploy(project({ deploy: first.settings }), { ...deps, vercelTeamId: 'team_other' });
    expect(deps.vercelClient).toHaveBeenLastCalledWith({ teamId: 'team_9' });
  });

  it('personal scope when no team is picked', async () => {
    const { deps } = world();
    const result = await setUpDeploy(project(), deps);
    expect(deps.vercelClient).toHaveBeenCalledWith({});
    expect(result.settings.vercel).not.toHaveProperty('teamId');
  });

  it('a pre-existing Vercel project linked to the same repo: vercel-existing-project with its names, setup stops', async () => {
    const { state, deps, client } = world({ origin: 'https://github.com/acme/shop.git' });
    state.projects.set('prj_x', { id: 'prj_x', name: 'shop-web', createdAt: NOW.getTime() - DAY, link: { repo: 'acme/shop' } });
    const result = await setUpDeploy(project(), deps);
    expect(client.createProject).not.toHaveBeenCalled();
    expect(result.step).toBe('vercel');
    expect(result.settings.enabled).toBe(false);
    expect(result.needed).toEqual([
      expect.objectContaining({ kind: 'vercel-existing-project', projects: [{ id: 'prj_x', name: 'shop-web' }] }),
    ]);
    expect(result.needed[0].message).toContain('shop-web');
  });

  it('a recent project with the same name linked to the same repo but not recorded as pending is not adopted', async () => {
    const { state, deps, client } = world({ origin: 'https://github.com/acme/shop.git' });
    state.projects.set('prj_x', { id: 'prj_x', name: 'shop', createdAt: NOW.getTime(), link: { repo: 'acme/shop' } });
    const result = await setUpDeploy(project(), deps);
    expect(client.createProject).not.toHaveBeenCalled();
    expect(result.needed.map((n) => n.kind)).toEqual(['vercel-existing-project']);
    expect(result.settings.vercel).toBeUndefined();
  });

  it("vercelChoice.useProjectId: adopts the owner's project", async () => {
    const { state, deps, client } = world({ origin: 'https://github.com/acme/shop.git' });
    state.projects.set('prj_x', { id: 'prj_x', name: 'shop-web', createdAt: NOW.getTime() - DAY, link: { repo: 'acme/shop' } });
    const result = await setUpDeploy(project({ deploy: { enabled: false, vercelChoice: { useProjectId: 'prj_x' } } }), deps);
    expect(client.createProject).not.toHaveBeenCalled();
    expect(result.step).toBe('done');
    expect(result.settings.vercel).toEqual({ projectId: 'prj_x', projectName: 'shop-web' });
    expect(state.saved?.vercelChoice).toBeUndefined();
  });

  it('vercelChoice.createNew: skips the existing-project check and creates a new one', async () => {
    const { state, deps, client } = world({ origin: 'https://github.com/acme/shop.git' });
    state.projects.set('prj_x', { id: 'prj_x', name: 'shop', createdAt: NOW.getTime() - DAY, link: { repo: 'acme/shop' } });
    const result = await setUpDeploy(project({ deploy: { enabled: false, vercelChoice: { createNew: true } } }), deps);
    expect(client.createProject).toHaveBeenLastCalledWith({ name: 'shop-2', repo: 'acme/shop' });
    expect(result.settings.vercel?.projectName).toBe('shop-2');
    expect(result.step).toBe('done');
  });

  it('a project name taken by another repo: picks the next free name', async () => {
    const { state, deps, client } = world({ origin: 'https://github.com/acme/shop.git' });
    state.projects.set('prj_x', { id: 'prj_x', name: 'shop', createdAt: NOW.getTime() - DAY, link: { repo: 'someone/else' } });
    const result = await setUpDeploy(project(), deps);
    expect(client.createProject).toHaveBeenCalledWith({ name: 'shop-2', repo: 'acme/shop' });
    expect(result.settings.vercel?.projectName).toBe('shop-2');
  });

  it('409 on create: re-finds by name and adopts only our own just-created project', async () => {
    // The name check misses (race), create says 409, the project is ours (created just now, same repo).
    const a = world({ origin: 'https://github.com/acme/shop.git' });
    a.client.createProject = vi.fn(async ({ name, repo }: { name: string; repo: string }) => {
      a.state.projects.set('prj_r', { id: 'prj_r', name, createdAt: a.state.now.getTime(), link: { repo } });
      throw { kind: 'conflict', message: 'exists' } satisfies VercelError;
    });
    const ra = await setUpDeploy(project(), a.deps);
    expect(ra.settings.vercel).toEqual({ projectId: 'prj_r', projectName: 'shop' });

    // 409 for an old project of the same repo: not adopted, next name.
    const b = world({ origin: 'https://github.com/acme/shop.git' });
    const create = b.client.createProject;
    let first = true;
    b.client.createProject = vi.fn(async (input: { name: string; repo: string }) => {
      if (first) {
        first = false;
        b.state.projects.set('prj_old', { id: 'prj_old', name: input.name, createdAt: NOW.getTime() - DAY, link: { repo: 'other/repo' } });
        throw { kind: 'conflict', message: 'exists' } satisfies VercelError;
      }
      return create(input);
    });
    const rb = await setUpDeploy(project(), b.deps);
    expect(rb.settings.vercel?.projectName).toBe('shop-2');
  });

  it('a recorded Vercel project that is gone (or its team): a clear not-found error, nothing created', async () => {
    const { state, deps, client } = world();
    const result = await setUpDeploy(
      project({
        deploy: {
          enabled: true,
          repo: { owner: 'nick', repo: 'my-app', createdByApp: true, public: false },
          vercel: { projectId: 'prj_gone', projectName: 'my-app', teamId: 'team_gone' },
        },
      }),
      deps,
    );
    expect(result.error?.kind).toBe('not-found');
    expect(result.error?.message).toContain('my-app');
    expect(client.createProject).not.toHaveBeenCalled();
    expect(state.pushes).toEqual([]);
    expect(deps.vercelClient).toHaveBeenCalledWith({ teamId: 'team_gone' });
  });

  it('a recorded Vercel project that is gone + vercelChoice.createNew: creates a new one', async () => {
    const { deps, client } = world();
    const result = await setUpDeploy(
      project({
        deploy: {
          enabled: false,
          repo: { owner: 'nick', repo: 'my-app', createdByApp: true, public: false },
          vercel: { projectId: 'prj_gone', projectName: 'my-app', teamId: 'team_gone' },
          vercelChoice: { createNew: true },
        },
      }),
      deps,
    );
    expect(client.createProject).toHaveBeenCalledTimes(1);
    expect(result.step).toBe('done');
    expect(result.settings.vercel).toEqual({ projectId: 'prj_1', projectName: 'my-app' });
  });

  it('never throws: GitHub and Vercel errors become state.error with their kind', async () => {
    const a = world();
    a.deps.createPrivateRepo = vi.fn(async () => {
      throw new GitHubWriteError('permissions', 'Resource not accessible by integration');
    });
    const ra = await setUpDeploy(project(), a.deps);
    expect(ra.error).toEqual({ kind: 'permissions', message: 'Resource not accessible by integration' });

    const b = world();
    b.client.listProjectsForRepo = vi.fn(async () => {
      throw { kind: 'rate-limit', message: 'Too many requests' } satisfies VercelError;
    });
    const rb = await setUpDeploy(project(), b.deps);
    expect(rb.error).toEqual({ kind: 'rate-limit', message: 'Too many requests' });

    const c = world();
    c.deps.readGit = vi.fn(async () => {
      throw new Error('token ghs_SECRET leaked');
    });
    const rc = await setUpDeploy(project(), c.deps);
    expect(rc.error?.kind).toBe('unknown');
    expect(rc.error?.message).not.toContain('ghs_SECRET');
  });
});

describe('saveDeployPatch', () => {
  it('merges the patch into the latest stored deploy, clears undefined fields', () => {
    const p = project({ deploy: { enabled: false, database: { provider: 'neon', addedAt: 'x' }, pendingRepo: { base: 'a', owner: 'o', at: 't' } } });
    const store = {
      getProject: vi.fn(() => p),
      updateProjectSettings: vi.fn((_id: string, s: Partial<Project['settings']>) => {
        p.settings = { ...p.settings, ...s };
        return p;
      }),
    };
    saveDeployPatch(store, 'p1', { repo: { owner: 'o', repo: 'a', createdByApp: true }, pendingRepo: undefined });
    expect(p.settings.deploy).toEqual({ enabled: false, database: { provider: 'neon', addedAt: 'x' }, repo: { owner: 'o', repo: 'a', createdByApp: true } });
    expect(p.settings.deploy).not.toHaveProperty('pendingRepo');
  });

  it('clears pendingDatabase, vercelChoice and vercelTeamId set to undefined (database and setup patches)', () => {
    const p = project({
      deploy: {
        enabled: true,
        pendingDatabase: { name: 'app-db', at: 't' },
        vercelChoice: { useProjectId: 'prj_1' },
        vercelTeamId: 'team_1',
      },
    });
    const store = {
      getProject: vi.fn(() => p),
      updateProjectSettings: vi.fn((_id: string, s: Partial<Project['settings']>) => {
        p.settings = { ...p.settings, ...s };
        return p;
      }),
    };
    saveDeployPatch(store, 'p1', { database: { provider: 'neon', addedAt: 'x' }, pendingDatabase: undefined });
    saveDeployPatch(store, 'p1', { vercelChoice: undefined, vercelTeamId: undefined });
    expect(p.settings.deploy).toEqual({ enabled: true, database: { provider: 'neon', addedAt: 'x' } });
    expect(Object.keys(p.settings.deploy ?? {})).not.toContain('pendingDatabase');
    expect(JSON.parse(JSON.stringify(p.settings.deploy))).toEqual({ enabled: true, database: { provider: 'neon', addedAt: 'x' } });
  });

  it('throws when the project is gone', () => {
    const store = { getProject: vi.fn(() => undefined), updateProjectSettings: vi.fn(() => undefined) };
    expect(() => saveDeployPatch(store, 'gone', { enabled: true })).toThrow();
  });
});

describe('classifyRemote', () => {
  it.each([
    ['https://github.com/acme/shop.git', { owner: 'acme', repo: 'shop' }],
    ['https://github.com/acme/shop', { owner: 'acme', repo: 'shop' }],
    ['https://github.com/acme/shop/', { owner: 'acme', repo: 'shop' }],
    ['https://user:tok@github.com/acme/shop.git', { owner: 'acme', repo: 'shop' }],
    ['git@github.com:acme/shop.git', { owner: 'acme', repo: 'shop' }],
    ['ssh://git@github.com/acme/my.repo.git', { owner: 'acme', repo: 'my.repo' }],
  ])('%s is GitHub', (url, expected) => {
    expect(classifyRemote(url)).toEqual(expected);
  });

  it.each([
    'git@gitlab.com:acme/shop.git',
    'https://gitlab.com/acme/shop.git',
    'https://github.com.evil.com/acme/shop.git',
    'https://github.com/acme',
    'https://github.com/acme/../shop',
    '/srv/git/shop.git',
  ])('%s is not GitHub', (url) => {
    expect(classifyRemote(url)).toBeNull();
  });
});

describe('readGitInfo', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function repo(files: Record<string, string>): Promise<string> {
    dir = await mkdtemp(path.join(tmpdir(), 'vt-setup-'));
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await writeFile(path.join(dir, rel), text);
    }
    return dir;
  }

  it('reads origin url and branches from files, without running git', async () => {
    const p = await repo({
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.git/config': '[core]\n\tbare = false\n[remote "upstream"]\n\turl = https://github.com/x/y.git\n[remote "origin"]\n\turl = git@github.com:acme/shop.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
      '.git/refs/heads/main': 'a'.repeat(40) + '\n',
      '.git/packed-refs': `# pack-refs\n${'b'.repeat(40)} refs/heads/master\n${'c'.repeat(40)} refs/tags/v1\n`,
    });
    const info = await readGitInfo(p);
    expect(info?.originUrl).toBe('git@github.com:acme/shop.git');
    expect(info?.head).toBe('main');
    expect(info?.branches.sort()).toEqual(['main', 'master']);
  });

  it('no origin section → no originUrl', async () => {
    const p = await repo({ '.git/HEAD': 'ref: refs/heads/main\n', '.git/config': '[core]\n\tbare = false\n' });
    expect((await readGitInfo(p))?.originUrl).toBeUndefined();
  });

  it('follows a linked worktree to the common dir', async () => {
    const p = await repo({
      'main/.git/config': '[remote "origin"]\n  url = https://github.com/acme/shop\n',
      'main/.git/refs/heads/main': 'a'.repeat(40),
      'main/.git/worktrees/wt/HEAD': 'ref: refs/heads/feature\n',
      'main/.git/worktrees/wt/commondir': '../..\n',
      'wt/.git': 'gitdir: ../main/.git/worktrees/wt\n',
    });
    const info = await readGitInfo(path.join(p, 'wt'));
    expect(info?.originUrl).toBe('https://github.com/acme/shop');
    expect(info?.head).toBe('feature');
    expect(info?.branches).toEqual(['main']);
  });

  it('include / includeIf anywhere: origin unclear', async () => {
    for (const extra of ['[include]\n\tpath = other.cfg\n', '[includeIf "gitdir:~/x/"]\n\tpath = other.cfg\n']) {
      const p = await repo({ '.git/HEAD': 'ref: refs/heads/main\n', '.git/config': `[remote "origin"]\n\turl = https://github.com/acme/shop\n${extra}` });
      expect((await readGitInfo(p))?.originUnclear).toBe(true);
      await rm(p, { recursive: true, force: true });
    }
  });

  it('pushurl on origin or any insteadOf rule: origin rewritten', async () => {
    for (const cfg of [
      '[remote "origin"]\n\turl = https://github.com/acme/shop\n\tpushurl = https://evil.example/x\n',
      '[remote "origin"]\n\turl = https://github.com/acme/shop\n[url "https://evil.example/"]\n\tinsteadOf = https://github.com/\n',
      '[remote "origin"]\n\turl = https://github.com/acme/shop\n[url "https://evil.example/"]\n\tpushInsteadOf = https://github.com/\n',
    ]) {
      const p = await repo({ '.git/HEAD': 'ref: refs/heads/main\n', '.git/config': cfg });
      const info = await readGitInfo(p);
      expect(info?.originRewritten).toBe(true);
      expect(info?.originUnclear).toBeUndefined();
      await rm(p, { recursive: true, force: true });
    }
  });

  it('not a git repository → null', async () => {
    const p = await repo({ 'README.md': 'hi' });
    expect(await readGitInfo(p)).toBeNull();
  });
});
