import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../../shared/types';
import type { DeployProjectSettings, VercelError } from '../../../shared/types/deploy';
import type { VercelClient } from '../vercel-api';
import { GitHubWriteError } from '../github-write';
import { classifyRemote, readGitInfo, setUpDeploy, type GitInfo, type SetupDeps } from '../setup';

const NOW = new Date('2026-11-11T10:00:00.000Z');

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

/** A fake GitHub + Vercel + local git: records what was created so re-runs can be checked. */
function world(opts: { origin?: string | null; git?: GitInfo | null; visibility?: 'private' | 'public' } = {}) {
  const state = {
    origin: opts.origin ?? null,
    repos: [] as string[],
    pushes: [] as Array<{ url: string; refspec: string }>,
    projects: new Map<string, { id: string; name: string; link?: { repo: string } }>(),
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
      for (const p of state.projects.values()) if (p.id === idOrName || p.name === idOrName) return { ...p };
      return null;
    }),
    createProject: vi.fn(async ({ name, repo }: { name: string; repo: string }) => {
      crash('createProject:before');
      if (state.crash.has('git-not-connected')) {
        throw { kind: 'git-not-connected', message: 'Install the GitHub integration', actionUrl: 'https://github.com/apps/vercel/installations/new' } satisfies VercelError;
      }
      const p = { id: `prj_${++projectSeq}`, name, link: { repo } };
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
    appAccess: vi.fn(async (repo?: { owner: string; repo: string }) =>
      repo ? { installed: true, repositorySelection: 'all' as const, repoReachable: true } : { installed: true, repositorySelection: 'all' as const },
    ),
    readGit: vi.fn(async () =>
      opts.git !== undefined ? opts.git : { originUrl: state.origin ?? undefined, branches: ['main'], head: 'main' },
    ),
    createPrivateRepo: vi.fn(async (name: string) => {
      crash('createRepo:before');
      state.repos.push(name);
      crash('createRepo:after');
      return { owner: 'nick', repo: name, cloneUrl: `https://github.com/nick/${name}.git` };
    }),
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
    }),
    saveSettings: vi.fn(async (deploy: DeployProjectSettings) => {
      crash(`save#${++saves}`);
      state.saved = structuredClone(deploy);
    }),
    onProgress: vi.fn(),
    now: () => NOW,
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
    expect(deps.onProgress).toHaveBeenCalledWith('repo');
    expect(deps.onProgress).toHaveBeenCalledWith('push');
    expect(deps.onProgress).toHaveBeenCalledWith('vercel');
    expect(deps.onProgress).toHaveBeenCalledWith('done');
  });

  it('records each step before the next: the repo is saved before the push', async () => {
    const { state, deps } = world();
    state.crash.add('push');
    const result = await setUpDeploy(project(), deps);
    expect(result.error).toBeDefined();
    expect(result.step).toBe('push');
    expect(state.saved?.repo).toEqual({ owner: 'nick', repo: 'my-app', createdByApp: true, public: false });
    expect(state.saved?.enabled).toBe(false);
  });

  it.each(['addOrigin', 'push', 'findProject', 'createProject:before', 'createProject:after', 'save#2', 'save#3'])(
    're-running after a crash at %s creates nothing twice',
    async (point) => {
      const { state, deps } = world();
      state.crash.add(point);
      const first = await setUpDeploy(project(), deps);
      expect(first.error).toBeDefined();
      expect(first.settings.enabled).toBe(false);
      state.crash.clear();

      const second = await setUpDeploy(project({ deploy: state.saved }), deps);
      expect(second.error).toBeUndefined();
      expect(second.step).toBe('done');
      expect(second.settings.enabled).toBe(true);
      expect(state.repos).toEqual(['my-app']);
      expect(state.projects.size).toBe(1);
      expect(second.settings.vercel?.projectId).toBe([...state.projects.values()][0].id);
      expect(state.origin).toBe('https://github.com/nick/my-app.git');
      expect(state.pushes.at(-1)).toEqual({ url: 'https://github.com/nick/my-app.git', refspec: 'main' });
    },
  );

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
    deps.vercelStatus = vi.fn(async () => ({ connected: false, error: 'Vercel answered 503' }));
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

  it('pushes the configured main branch, else main/master from refs', async () => {
    const a = world();
    await setUpDeploy(project({ mainBranch: 'trunk' }), a.deps);
    expect(a.state.pushes[0].refspec).toBe('trunk');

    const b = world({ git: { branches: ['master', 'feature'], head: 'feature' } });
    await setUpDeploy(project(), b.deps);
    expect(b.state.pushes[0].refspec).toBe('master');

    const c = world({ git: { branches: ['dev'], head: 'dev' } });
    await setUpDeploy(project(), c.deps);
    expect(c.state.pushes[0].refspec).toBe('dev');
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

  it('adopts an existing Vercel project linked to the same repo', async () => {
    const { state, deps, client } = world({ origin: 'https://github.com/acme/shop.git' });
    state.projects.set('prj_x', { id: 'prj_x', name: 'shop', link: { repo: 'acme/shop' } });
    const result = await setUpDeploy(project(), deps);
    expect(client.createProject).not.toHaveBeenCalled();
    expect(result.settings.vercel).toEqual({ projectId: 'prj_x', projectName: 'shop' });
  });

  it('a project name taken by another repo: picks the next free name', async () => {
    const { state, deps, client } = world({ origin: 'https://github.com/acme/shop.git' });
    state.projects.set('prj_x', { id: 'prj_x', name: 'shop', link: { repo: 'someone/else' } });
    const result = await setUpDeploy(project(), deps);
    expect(client.createProject).toHaveBeenCalledWith({ name: 'shop-2', repo: 'acme/shop' });
    expect(result.settings.vercel?.projectName).toBe('shop-2');
  });

  it('a recorded Vercel project that was deleted is created again', async () => {
    const { state, deps, client } = world();
    const first = await setUpDeploy(project(), deps);
    state.projects.clear();
    const second = await setUpDeploy(project({ deploy: first.settings }), deps);
    expect(client.createProject).toHaveBeenCalledTimes(2);
    expect(second.settings.vercel?.projectId).toBe('prj_2');
  });

  it('never throws: GitHub and Vercel errors become state.error with their kind', async () => {
    const a = world();
    a.deps.createPrivateRepo = vi.fn(async () => {
      throw new GitHubWriteError('permissions', 'Resource not accessible by integration');
    });
    const ra = await setUpDeploy(project(), a.deps);
    expect(ra.error).toEqual({ kind: 'permissions', message: 'Resource not accessible by integration' });

    const b = world();
    b.client.findProject = vi.fn(async () => {
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

  it('not a git repository → null', async () => {
    const p = await repo({ 'README.md': 'hi' });
    expect(await readGitInfo(p)).toBeNull();
  });
});
