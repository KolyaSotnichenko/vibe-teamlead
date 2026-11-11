import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ipcMain } from 'electron';

import { IPC_CHANNELS } from '../../../shared/constants';
import type { DeploySetupState } from '../../../shared/types/deploy';

// Fakes only: no GitHub, no Vercel API, no Vercel CLI.

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

const vars = vi.hoisted(() => ({ setDeployVariable: vi.fn(), listDeployVariables: vi.fn() }));
vi.mock('../../deploy/variables', () => vars);

const db = vi.hoisted(() => ({ addDatabase: vi.fn() }));
vi.mock('../../deploy/database', () => db);

const cred = vi.hoisted(() => ({
  vercelStatus: vi.fn(async () => ({ connected: true, user: { id: 'u1', username: 'ada' }, teams: [] })),
  vercelCliPaths: vi.fn(async () => ({ binary: '/fake/vercel', configDir: '/fake/config' })),
  getVercelToken: vi.fn(async () => 'tok'),
}));
vi.mock('../../deploy/vercel-credential', () => cred);

const api = vi.hoisted(() => ({
  createVercelClient: vi.fn(() => ({ upsertEnv: vi.fn(), listEnvNames: vi.fn() })),
  defaultVercelFetcher: vi.fn(),
  isVercelError: () => false,
}));
vi.mock('../../deploy/vercel-api', () => api);

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

    it('stores the picked Vercel team and passes it as vercelTeamId; null means the personal account', async () => {
      setup.setUpDeploy.mockResolvedValue(done());
      await invoke(IPC_CHANNELS.DEPLOY_SETUP, 'p1', { vercelTeamId: 'team_1' });
      expect(store.projects.get('p1')?.settings.deploy).toMatchObject({ vercelTeamId: 'team_1' });
      expect(setup.createSetupDeps.mock.calls[0][1]).toMatchObject({ vercelTeamId: 'team_1' });

      await invoke(IPC_CHANNELS.DEPLOY_SETUP, 'p1', { vercelTeamId: null });
      expect(store.projects.get('p1')?.settings.deploy).not.toHaveProperty('vercelTeamId');
      expect(setup.createSetupDeps.mock.calls[1][1].vercelTeamId).toBeUndefined();

      // omitted: the stored choice stays
      p1().settings.deploy = { enabled: false, vercelTeamId: 'team_2' };
      await invoke(IPC_CHANNELS.DEPLOY_SETUP, 'p1');
      expect(setup.createSetupDeps.mock.calls[2][1]).toMatchObject({ vercelTeamId: 'team_2' });
    });

    it('rejects a malformed team id without running', async () => {
      expect(await invoke(IPC_CHANNELS.DEPLOY_SETUP, 'p1', { vercelTeamId: '../x y' })).toMatchObject({ success: false });
      expect(setup.setUpDeploy).not.toHaveBeenCalled();
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
          databaseRunning: false,
          lastPush: { projectId: 'p1', ok: true, at: 't' },
        },
      });
    });

    it('settings is null when deploy was never started', async () => {
      expect(await invoke(IPC_CHANNELS.DEPLOY_STATE, 'p1')).toMatchObject({ data: { settings: null } });
    });
  });

  describe('chooseVercelProject', () => {
    it('records the choice and runs setup again', async () => {
      setup.setUpDeploy.mockResolvedValue(done());
      await invoke(IPC_CHANNELS.DEPLOY_CHOOSE_VERCEL_PROJECT, 'p1', { useProjectId: 'prj_1' });
      expect(store.projects.get('p1')?.settings.deploy).toMatchObject({ vercelChoice: { useProjectId: 'prj_1' } });
      expect(setup.setUpDeploy).toHaveBeenCalledTimes(1);
      await invoke(IPC_CHANNELS.DEPLOY_CHOOSE_VERCEL_PROJECT, 'p1', { createNew: true });
      expect(store.projects.get('p1')?.settings.deploy).toMatchObject({ vercelChoice: { createNew: true } });
    });

    it('rejects anything else, and refuses while setup runs', async () => {
      expect(await invoke(IPC_CHANNELS.DEPLOY_CHOOSE_VERCEL_PROJECT, 'p1', { useProjectId: '' })).toMatchObject({ success: false });
      expect(await invoke(IPC_CHANNELS.DEPLOY_CHOOSE_VERCEL_PROJECT, 'p1', { createNew: 'yes' })).toMatchObject({ success: false });
      const gate = deferred<DeploySetupState>();
      setup.setUpDeploy.mockReturnValueOnce(gate.promise);
      const running = invoke(IPC_CHANNELS.DEPLOY_SETUP, 'p1');
      await vi.waitFor(() => expect(setup.setUpDeploy).toHaveBeenCalledTimes(1));
      expect(await invoke(IPC_CHANNELS.DEPLOY_CHOOSE_VERCEL_PROJECT, 'p1', { createNew: true })).toEqual({ success: false, error: 'busy' });
      gate.resolve(done());
      await running;
      expect(store.projects.get('p1')?.settings.deploy).toBeUndefined();
    });
  });

  describe('addDatabase', () => {
    beforeEach(() => {
      p1().settings.deploy = { enabled: true, vercel: { projectId: 'prj', projectName: 'app' } };
    });

    it('wires the CLI paths, the token, the personal user id, the fresh project and the settings store', async () => {
      db.addDatabase.mockResolvedValue({ ok: true });
      expect(await invoke(IPC_CHANNELS.DEPLOY_ADD_DATABASE, 'p1', { acceptTerms: true })).toEqual({ success: true, data: { ok: true } });
      const [project, deps, opts] = db.addDatabase.mock.calls[0];
      expect(project.id).toBe('p1');
      expect(opts).toEqual({ acceptTerms: true });
      expect(deps).toMatchObject({ binary: '/fake/vercel', configDir: '/fake/config', userId: 'u1' });
      expect(await deps.getToken()).toBe('tok');
      p1().settings.deploy = { enabled: true, vercel: { projectId: 'prj', projectName: 'app' }, pendingDatabase: { name: 'x', at: 't' } };
      expect((await deps.loadProject()).settings.deploy.pendingDatabase).toEqual({ name: 'x', at: 't' });
      await deps.saveSettings({ database: { provider: 'neon', addedAt: 'a' }, pendingDatabase: undefined });
      expect(store.projects.get('p1')?.settings.deploy).toEqual({ enabled: true, vercel: { projectId: 'prj', projectName: 'app' }, database: { provider: 'neon', addedAt: 'a' } });
    });

    it('accepts the terms only on an explicit true; a team project does not need the user id', async () => {
      db.addDatabase.mockResolvedValue({ ok: true });
      await invoke(IPC_CHANNELS.DEPLOY_ADD_DATABASE, 'p1', { acceptTerms: 'yes' });
      expect(db.addDatabase.mock.calls[0][2]).toEqual({ acceptTerms: false });
      p1().settings.deploy = { enabled: true, vercel: { projectId: 'prj', projectName: 'app', teamId: 'team_1' } };
      cred.vercelStatus.mockClear();
      await invoke(IPC_CHANNELS.DEPLOY_ADD_DATABASE, 'p1');
      expect(cred.vercelStatus).not.toHaveBeenCalled();
    });

    it('one run per project: a second call joins; state reports it running and keeps the last result', async () => {
      const gate = deferred<unknown>();
      db.addDatabase.mockReturnValueOnce(gate.promise);
      const a = invoke(IPC_CHANNELS.DEPLOY_ADD_DATABASE, 'p1');
      const b = invoke(IPC_CHANNELS.DEPLOY_ADD_DATABASE, 'p1', { acceptTerms: true });
      await vi.waitFor(() => expect(db.addDatabase).toHaveBeenCalledTimes(1));
      expect(await invoke(IPC_CHANNELS.DEPLOY_STATE, 'p1')).toMatchObject({ data: { databaseRunning: true } });
      const needed = { ok: false, needed: { id: 'database-dashboard', kind: 'database-dashboard', message: 'm' } };
      gate.resolve(needed);
      expect(await a).toEqual({ success: true, data: needed });
      expect(await b).toEqual({ success: true, data: needed });
      expect(db.addDatabase).toHaveBeenCalledTimes(1);
      expect(await invoke(IPC_CHANNELS.DEPLOY_STATE, 'p1')).toMatchObject({ data: { databaseRunning: false, lastDatabase: needed } });
    });

    it('a CLI that cannot be prepared is a cli error, never a throw', async () => {
      cred.vercelCliPaths.mockRejectedValueOnce(new Error('download failed /Users/x'));
      expect(await invoke(IPC_CHANNELS.DEPLOY_ADD_DATABASE, 'p1')).toEqual({
        success: true,
        data: { ok: false, error: { kind: 'cli', message: 'The Vercel CLI could not be prepared.' } },
      });
      expect(db.addDatabase).not.toHaveBeenCalled();
    });

    it('a CLI download shows progress to the window and in the state, then clears it', async () => {
      const gate = deferred<{ binary: string; configDir: string }>();
      let progress: ((r: number, t: number) => void) | undefined;
      cred.vercelCliPaths.mockImplementationOnce(async (opts?: { onProgress?: (r: number, t: number) => void }) => {
        progress = opts?.onProgress;
        return gate.promise;
      });
      db.addDatabase.mockResolvedValue({ ok: true });
      const run = invoke(IPC_CHANNELS.DEPLOY_ADD_DATABASE, 'p1');
      await vi.waitFor(() => expect(progress).toBeDefined());
      progress?.(50, 100);
      progress?.(50, 100);
      expect(window.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.DEPLOY_DATABASE_PROGRESS, { projectId: 'p1', download: { percent: 50 } });
      expect(window.webContents.send).toHaveBeenCalledTimes(1);
      expect(await invoke(IPC_CHANNELS.DEPLOY_STATE, 'p1')).toMatchObject({ data: { databaseRunning: true, databaseDownload: { percent: 50 } } });
      gate.resolve({ binary: '/fake/vercel', configDir: '/fake/config' });
      expect(await run).toEqual({ success: true, data: { ok: true } });
      expect(window.webContents.send).toHaveBeenLastCalledWith(IPC_CHANNELS.DEPLOY_DATABASE_PROGRESS, { projectId: 'p1' });
      expect((await invoke(IPC_CHANNELS.DEPLOY_STATE, 'p1')) as { data: Record<string, unknown> }).not.toHaveProperty('data.databaseDownload');
    });

    it('cancel aborts the CLI download: kind cancelled, nothing added', async () => {
      cred.vercelCliPaths.mockImplementationOnce(
        (opts?: { signal?: AbortSignal }) =>
          new Promise((_, reject) => opts?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('x'), { kind: 'cancelled' })))),
      );
      const run = invoke(IPC_CHANNELS.DEPLOY_ADD_DATABASE, 'p1');
      await vi.waitFor(() => expect(cred.vercelCliPaths).toHaveBeenCalled());
      expect(await invoke(IPC_CHANNELS.DEPLOY_CANCEL_DATABASE, 'p1')).toEqual({ success: true });
      expect(await run).toMatchObject({ success: true, data: { ok: false, error: { kind: 'cancelled' } } });
      expect(db.addDatabase).not.toHaveBeenCalled();
    });

    it('a stalled CLI download is a timeout', async () => {
      cred.vercelCliPaths.mockRejectedValueOnce(Object.assign(new Error('x'), { kind: 'timeout' }));
      expect(await invoke(IPC_CHANNELS.DEPLOY_ADD_DATABASE, 'p1')).toMatchObject({ success: true, data: { ok: false, error: { kind: 'timeout' } } });
    });
  });

  describe('variables', () => {
    const settings = { enabled: true, repo: { owner: 'o', repo: 'r', createdByApp: true }, vercel: { projectId: 'prj', projectName: 'app' } };
    beforeEach(() => {
      p1().settings.deploy = settings;
    });

    it('setVariable passes the stored settings, a clean input and the real deps', async () => {
      vars.setDeployVariable.mockResolvedValue({ ok: true, vercel: 'ok', github: 'ok' });
      const input = { name: 'API_KEY', value: 's3cret', targets: ['production'], alsoGitHubSecret: true, extra: 'x' };
      expect(await invoke(IPC_CHANNELS.DEPLOY_SET_VARIABLE, 'p1', input)).toEqual({ success: true, data: { ok: true, vercel: 'ok', github: 'ok' } });
      const [s, given, deps] = vars.setDeployVariable.mock.calls[0];
      expect(s).toEqual(settings);
      expect(given).toEqual({ name: 'API_KEY', value: 's3cret', targets: ['production'], alsoGitHubSecret: true });
      deps.vercelClient({ teamId: 't' });
      expect(api.createVercelClient).toHaveBeenCalledWith(api.defaultVercelFetcher, { teamId: 't' }, expect.any(Function));
      await deps.setRepoSecret('o', 'r', 'N', 'v');
      expect(gh.setRepoSecret).toHaveBeenCalledWith('o', 'r', 'N', 'v');
    });

    it('setVariable rejects a malformed input without calling anything', async () => {
      for (const bad of [null, { name: 'A', value: 1, targets: [], alsoGitHubSecret: false }, { name: 'A', value: 'v', targets: 'production', alsoGitHubSecret: false }]) {
        expect(await invoke(IPC_CHANNELS.DEPLOY_SET_VARIABLE, 'p1', bad)).toMatchObject({ success: false });
      }
      expect(vars.setDeployVariable).not.toHaveBeenCalled();
    });

    it('a failure never echoes the value', async () => {
      vars.setDeployVariable.mockRejectedValue(new Error('boom s3cret'));
      const r = await invoke(IPC_CHANNELS.DEPLOY_SET_VARIABLE, 'p1', { name: 'A', value: 's3cret', targets: ['preview'], alsoGitHubSecret: false });
      expect(JSON.stringify(r)).not.toContain('s3cret');
    });

    it('listVariables passes the stored settings', async () => {
      vars.listDeployVariables.mockResolvedValue({ ok: true, variables: [] });
      expect(await invoke(IPC_CHANNELS.DEPLOY_LIST_VARIABLES, 'p1')).toEqual({ success: true, data: { ok: true, variables: [] } });
      expect(vars.listDeployVariables.mock.calls[0][0]).toEqual(settings);
    });

    it('not set up when deploy was never started', async () => {
      p1().settings = {};
      vars.listDeployVariables.mockResolvedValue({ ok: false, kind: 'not-set-up', message: 'm' });
      await invoke(IPC_CHANNELS.DEPLOY_LIST_VARIABLES, 'p1');
      expect(vars.listDeployVariables.mock.calls[0][0]).toEqual({ enabled: false });
    });
  });
});
