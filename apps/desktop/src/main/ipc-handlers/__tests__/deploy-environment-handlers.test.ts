import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ipcMain } from 'electron';

import { IPC_CHANNELS } from '../../../shared/constants';
import type { DeploySetupState } from '../../../shared/types/deploy';

// Fakes only: no GitHub calls, no file system cleanup.

const store = vi.hoisted(() => {
  const projects = new Map<string, { id: string; path: string; name: string; settings: Record<string, unknown> }>();
  return {
    projects,
    projectStore: {
      getProject: vi.fn((id: string) => projects.get(id)),
      updateProjectSettings: vi.fn((id: string, s: Record<string, unknown>) => {
        const p = projects.get(id);
        if (p) p.settings = { ...p.settings, ...s };
        return p;
      }),
    },
  };
});
vi.mock('../../project-store', () => ({ projectStore: store.projectStore }));

const setup = vi.hoisted(() => ({
  setUpDeploy: vi.fn(),
  createSetupDeps: vi.fn(async (_p: unknown, extra: Record<string, unknown>) => ({ extra })),
}));
vi.mock('../../deploy/setup', async (orig) => ({ ...(await orig<typeof import('../../deploy/setup')>()), ...setup }));

const cleanup = vi.hoisted(() => ({ cleanupVercelLeftovers: vi.fn(async (_userData: string) => undefined) }));
vi.mock('../../deploy/ci-setup', async (orig) => ({ ...(await orig<typeof import('../../deploy/ci-setup')>()), ...cleanup }));

const readiness = vi.hoisted(() => ({ deps: undefined as undefined | { secretNames: (p: unknown) => Promise<string[]> } & Record<string, unknown> }));
vi.mock('../../deploy/readiness', () => ({
  createReadiness: (deps: typeof readiness.deps) => {
    readiness.deps = deps;
    return { state: () => ({ scanning: false, tasks: {} }), scan: vi.fn(async () => undefined) };
  },
}));

const gh = vi.hoisted(() => ({ setRepoSecret: vi.fn(), listRepoSecretNames: vi.fn() }));
vi.mock('../../deploy/github-write', async (orig) => ({ ...(await orig<typeof import('../../deploy/github-write')>()), ...gh }));

const push = vi.hoisted(() => ({ lastPushResult: vi.fn(() => undefined as unknown) }));
vi.mock('../../deploy/push-after-merge', () => push);

vi.mock('../../deploy/github-actions', () => ({ createActionsClient: () => ({}), resolveRepo: vi.fn() }));
vi.mock('../../deploy/github-fetcher', () => ({ githubFetcher: vi.fn() }));

import { registerDeployHandlers } from '../deploy-handlers';

type Invoke = (channel: string, event: unknown, ...args: unknown[]) => Promise<unknown>;
const invoke = (channel: string, ...args: unknown[]) =>
  (ipcMain as unknown as { invokeHandler: Invoke }).invokeHandler(channel, {}, ...args);

function p1() {
  const p = store.projects.get('p1');
  if (!p) throw new Error('no p1');
  return p;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const done = (settings: Record<string, unknown> = { enabled: true }): DeploySetupState => ({ settings: settings as never, needed: [], step: 'done' });

describe('deploy environment IPC', () => {
  const window = { isDestroyed: () => false, webContents: { send: vi.fn(), on: vi.fn(), once: vi.fn(), isDestroyed: () => false } };

  beforeEach(() => {
    vi.clearAllMocks();
    store.projects.clear();
    store.projects.set('p1', { id: 'p1', path: '/p1', name: 'App', settings: {} });
    (ipcMain as unknown as { removeAllListeners: () => void }).removeAllListeners();
    registerDeployHandlers(() => window as never);
  });

  describe('setUp', () => {
    it('one run per project: a second call joins the running one', async () => {
      const gate = deferred<DeploySetupState>();
      setup.setUpDeploy.mockReturnValueOnce(gate.promise);
      const a = invoke(IPC_CHANNELS.DEPLOY_SETUP, 'p1');
      const b = invoke(IPC_CHANNELS.DEPLOY_SETUP, 'p1');
      await vi.waitFor(() => expect(setup.setUpDeploy).toHaveBeenCalledTimes(1));
      expect(await invoke(IPC_CHANNELS.DEPLOY_STATE, 'p1')).toMatchObject({ success: true, data: { setupRunning: true } });
      gate.resolve(done());
      expect(await a).toEqual({ success: true, data: done() });
      expect(await b).toEqual({ success: true, data: done() });
      expect(setup.setUpDeploy).toHaveBeenCalledTimes(1);

      // finished: the next call runs again
      setup.setUpDeploy.mockResolvedValueOnce(done());
      await invoke(IPC_CHANNELS.DEPLOY_SETUP, 'p1');
      expect(setup.setUpDeploy).toHaveBeenCalledTimes(2);
    });

    it('takes no options: setup is GitHub only', async () => {
      setup.setUpDeploy.mockResolvedValue(done());
      await invoke(IPC_CHANNELS.DEPLOY_SETUP, 'p1', { vercelTeamId: 'team_1' });
      expect(Object.keys(setup.createSetupDeps.mock.calls[0][1])).toEqual(['onProgress']);
      expect(store.projects.get('p1')?.settings.deploy).toBeUndefined();
    });

    it('sends each step to the window', async () => {
      setup.setUpDeploy.mockImplementation(async (_p: unknown, deps: { extra: { onProgress: (s: string) => void } }) => {
        deps.extra.onProgress('repo');
        return done();
      });
      await invoke(IPC_CHANNELS.DEPLOY_SETUP, 'p1');
      expect(window.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.DEPLOY_SETUP_PROGRESS, { projectId: 'p1', step: 'repo' });
    });

    it('a crash in the wiring becomes an unknown error, and the lock is released', async () => {
      setup.createSetupDeps.mockRejectedValueOnce(new Error('/secret/path broke'));
      const r = (await invoke(IPC_CHANNELS.DEPLOY_SETUP, 'p1')) as { success: boolean; data: DeploySetupState };
      expect(r.success).toBe(true);
      expect(r.data.error).toEqual({ kind: 'unknown', message: 'Setup stopped unexpectedly. Try again.' });
      expect(await invoke(IPC_CHANNELS.DEPLOY_STATE, 'p1')).toMatchObject({ data: { setupRunning: false, lastSetup: r.data } });
    });

    it('an unknown project fails', async () => {
      expect(await invoke(IPC_CHANNELS.DEPLOY_SETUP, 'nope')).toMatchObject({ success: false });
    });
  });

  describe('state', () => {
    it('returns the stored settings, the last setup and the last push', async () => {
      p1().settings.deploy = { enabled: true, repo: { owner: 'o', repo: 'r', createdByApp: true } };
      push.lastPushResult.mockReturnValueOnce({ projectId: 'p1', ok: true, at: 't' });
      expect(await invoke(IPC_CHANNELS.DEPLOY_STATE, 'p1')).toEqual({
        success: true,
        data: {
          settings: { enabled: true, repo: { owner: 'o', repo: 'r', createdByApp: true } },
          setupRunning: false,
          lastPush: { projectId: 'p1', ok: true, at: 't' },
        },
      });
    });

    it('settings is null when deploy was never started', async () => {
      expect(await invoke(IPC_CHANNELS.DEPLOY_STATE, 'p1')).toMatchObject({ data: { settings: null } });
    });
  });

  describe('no Vercel', () => {
    it('the Vercel, database, services and variables channels are gone', async () => {
      for (const channel of [
        'deploy:chooseVercelProject',
        'deploy:addDatabase',
        'deploy:cancelDatabase',
        'deploy:addService',
        'deploy:cancelService',
        'deploy:setVariable',
        'deploy:listVariables',
        'vercel:status',
        'vercel:connect',
      ]) {
        await expect(invoke(channel, 'p1')).rejects.toThrow(/No handler/);
      }
      expect(Object.values(IPC_CHANNELS).filter((c) => c.startsWith('vercel:') || /^deploy:.*(Vercel|Database|Service|Variable)/.test(c))).toEqual([]);
    });

    it('removes the old Vercel leftovers in userData once, at start', () => {
      expect(cleanup.cleanupVercelLeftovers).toHaveBeenCalledTimes(1);
      expect(cleanup.cleanupVercelLeftovers).toHaveBeenCalledWith('/tmp/test-app-data');
    });

    it('a failing cleanup does not stop the handlers from registering', async () => {
      cleanup.cleanupVercelLeftovers.mockRejectedValueOnce(new Error('EACCES'));
      (ipcMain as unknown as { removeAllListeners: () => void }).removeAllListeners();
      expect(() => registerDeployHandlers(() => window as never)).not.toThrow();
      expect(await invoke(IPC_CHANNELS.DEPLOY_STATE, 'p1')).toMatchObject({ success: true });
    });
  });

  describe('readiness names', () => {
    it('are the GitHub secret names of the recorded repository; none before setup', async () => {
      gh.listRepoSecretNames.mockResolvedValue(['API_KEY']);
      expect(readiness.deps).not.toHaveProperty('setUp');
      expect(readiness.deps).not.toHaveProperty('canAutoSetUp');
      expect(readiness.deps).not.toHaveProperty('variableNames');
      expect(await readiness.deps?.secretNames({ settings: {} })).toEqual([]);
      expect(gh.listRepoSecretNames).not.toHaveBeenCalled();
      expect(await readiness.deps?.secretNames({ settings: { deploy: { repo: { owner: 'o', repo: 'r', createdByApp: true } } } })).toEqual(['API_KEY']);
      expect(gh.listRepoSecretNames).toHaveBeenCalledWith('o', 'r');
    });
  });

  describe('secrets', () => {
    const setUp = () => {
      p1().settings.deploy = { enabled: true, repo: { owner: 'o', repo: 'r', createdByApp: true } };
    };

    it('setSecret saves the value as a GitHub Actions secret of the recorded repository and returns no value', async () => {
      setUp();
      gh.setRepoSecret.mockResolvedValueOnce(undefined);
      const r = await invoke(IPC_CHANNELS.DEPLOY_SET_SECRET, 'p1', 'API_KEY', 's3cr3t-value');
      expect(r).toEqual({ success: true, data: { ok: true } });
      expect(gh.setRepoSecret).toHaveBeenCalledWith('o', 'r', 'API_KEY', 's3cr3t-value');
      expect(JSON.stringify(r)).not.toContain('s3cr3t-value');
    });

    it('setSecret checks the name by GitHub\'s rules and the value before any call', async () => {
      setUp();
      for (const [name, value] of [
        ['GITHUB_TOKEN', 'v'],
        ['lower', 'v'],
        ['1ABC', 'v'],
        ['A-B', 'v'],
        [42, 'v'],
        ['API_KEY', ''],
        ['API_KEY', 7],
        ['API_KEY', 'x'.repeat(64 * 1024 + 1)],
      ] as const) {
        expect(await invoke(IPC_CHANNELS.DEPLOY_SET_SECRET, 'p1', name, value)).toEqual({ success: true, data: { ok: false, kind: 'invalid' } });
      }
      expect(gh.setRepoSecret).not.toHaveBeenCalled();
    });

    it('setSecret before CI is set up says so and calls nothing', async () => {
      expect(await invoke(IPC_CHANNELS.DEPLOY_SET_SECRET, 'p1', 'API_KEY', 'v')).toEqual({ success: true, data: { ok: false, kind: 'not-set-up' } });
      expect(gh.setRepoSecret).not.toHaveBeenCalled();
    });

    it('a GitHub failure travels as its kind only, never the message (it could echo the value)', async () => {
      setUp();
      const err = Object.assign(new Error('boom v4lue'), { name: 'GitHubWriteError', kind: 'permissions' });
      gh.setRepoSecret.mockRejectedValueOnce(err);
      const r = await invoke(IPC_CHANNELS.DEPLOY_SET_SECRET, 'p1', 'API_KEY', 'v4lue');
      expect(r).toEqual({ success: true, data: { ok: false, kind: 'permissions' } });
      gh.setRepoSecret.mockRejectedValueOnce(new Error('v4lue'));
      expect(await invoke(IPC_CHANNELS.DEPLOY_SET_SECRET, 'p1', 'API_KEY', 'v4lue')).toEqual({ success: true, data: { ok: false, kind: 'unavailable' } });
    });

    it('listSecrets lists names only; not set up and failures are kinds', async () => {
      expect(await invoke(IPC_CHANNELS.DEPLOY_LIST_SECRETS, 'p1')).toEqual({ success: true, data: { ok: false, kind: 'not-set-up' } });
      setUp();
      gh.listRepoSecretNames.mockResolvedValueOnce(['API_KEY', 'NPM_TOKEN']);
      expect(await invoke(IPC_CHANNELS.DEPLOY_LIST_SECRETS, 'p1')).toEqual({ success: true, data: { ok: true, names: ['API_KEY', 'NPM_TOKEN'] } });
      expect(gh.listRepoSecretNames).toHaveBeenCalledWith('o', 'r');
      gh.listRepoSecretNames.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'GitHubWriteError', kind: 'rate-limit' }));
      expect(await invoke(IPC_CHANNELS.DEPLOY_LIST_SECRETS, 'p1')).toEqual({ success: true, data: { ok: false, kind: 'rate-limit' } });
    });

    it('an unknown project fails', async () => {
      expect(await invoke(IPC_CHANNELS.DEPLOY_SET_SECRET, 'nope', 'API_KEY', 'v')).toMatchObject({ success: false });
      expect(await invoke(IPC_CHANNELS.DEPLOY_LIST_SECRETS, 'nope')).toMatchObject({ success: false });
    });
  });
});
