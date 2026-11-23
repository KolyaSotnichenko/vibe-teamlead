import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ipcMain } from 'electron';

import { IPC_CHANNELS } from '../../../shared/constants';
import type { PreviewEnvReport, Project } from '../../../shared/types';

const NO_DOCKER = async () => ({ ok: false, stdout: '' });
const dirs = vi.hoisted(() => ({ project: '', taskWorktree: null as string | null }));
const session = vi.hoisted(() => ({
  startPreview: vi.fn(async () => ({ projectId: 'p1', stage: 'ready', origins: [] })),
  stopPreview: vi.fn(async () => {}),
  currentPreview: vi.fn(() => null),
  previewLogs: vi.fn(() => []),
  previewMailPort: vi.fn(() => undefined),
  runningPreviewEnv: vi.fn((): PreviewEnvReport | null => null),
  restartPreviewServices: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock('../../preview/preview-session', () => session);
const SETTINGS: { previewServices: Array<{ name: string; dir: string; command: string; page?: boolean }>; previewPendingRecipe?: unknown } = { previewServices: [{ name: 'api', dir: 'api', command: 'x', page: true }] };
vi.mock('../../project-store', () => ({
  projectStore: {
    getProject: vi.fn((id: string) => (id === 'p1' ? { id: 'p1', path: dirs.project, settings: SETTINGS } : undefined)),
    getProjects: vi.fn(() => [{ id: 'p1', path: dirs.project, settings: SETTINGS }]),
    updateProjectSettings: vi.fn((_id: string, settings: Record<string, unknown>) => { Object.assign(SETTINGS, settings); }),
    getTasks: vi.fn(() => (dirs.taskWorktree ? [{ id: 't1', specId: '001-task' }] : [])),
  },
}));
vi.mock('../../worktree-paths', () => ({ findTaskWorktree: vi.fn(() => dirs.taskWorktree) }));
vi.mock('../../cli-tool-manager', () => ({ getToolPath: () => 'git' }));

import { previewEnvReport, registerPreviewHandlers } from '../preview-handlers';

type Invoke = (channel: string, event: unknown, ...args: unknown[]) => Promise<unknown>;
const invoke = (channel: string, ...args: unknown[]) => (ipcMain as unknown as { invokeHandler: Invoke }).invokeHandler(channel, {}, ...args);

describe('preview IPC: Environment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (ipcMain as unknown as { removeAllListeners: () => void }).removeAllListeners();
    dirs.project = mkdtempSync(join(tmpdir(), 'vt-env-'));
    dirs.taskWorktree = null;
    delete SETTINGS.previewPendingRecipe;
    mkdirSync(join(dirs.project, 'api'));
    writeFileSync(join(dirs.project, 'api', '.env.example'), 'AUTH_TEST_IDP_ENABLED=true\nSTRIPE_KEY=\n');
    writeFileSync(join(dirs.project, 'api', '.env'), 'REAL_SECRET=leak\n');
    writeFileSync(join(dirs.project, '.env.local'), 'REAL_SECRET=leak\n');
    registerPreviewHandlers(() => null, { onOverlayEvent: vi.fn(() => () => {}), setWorktree: vi.fn(), destroy: vi.fn(), show: vi.fn(), hide: vi.fn() } as never);
  });

  it('recipe: says what the preview runs and where that came from: preview.json before the saved services', async () => {
    expect(await invoke(IPC_CHANNELS.PREVIEW_RECIPE, 'p1')).toEqual({ success: true, data: { source: 'settings', servicesFrom: 'settings', services: SETTINGS.previewServices } });
    const site = { name: 'site', dir: '', command: 'make serve', port: 8080, page: true };
    writeFileSync(join(dirs.project, 'preview.json'), JSON.stringify({ version: 1, kind: 'web', services: [site] }));
    expect(await invoke(IPC_CHANNELS.PREVIEW_RECIPE, 'p1')).toEqual({ success: true, data: { source: 'file', servicesFrom: 'file', services: [site] } });
  });

  it('recipe: passes over a preview.json it cannot use and says why', async () => {
    writeFileSync(join(dirs.project, 'preview.json'), '{"version":2}');
    const result = (await invoke(IPC_CHANNELS.PREVIEW_RECIPE, 'p1')) as { success: boolean; data: { source: string; invalid?: string; services: unknown[] } };
    expect(result.data.source).toBe('settings');
    expect(result.data.invalid).toMatch(/version/);
    expect(result.data.services).toEqual(SETTINGS.previewServices);
  });

  it('recipe: accepts a real folder of the project, also when the project itself is reached through a link', async () => {
    // The temp folder is such a path on macOS (/var is a link)
    const site = { name: 'site', dir: 'api', command: 'make serve', page: true };
    writeFileSync(join(dirs.project, 'preview.json'), JSON.stringify({ version: 1, kind: 'web', services: [site] }));
    expect(await invoke(IPC_CHANNELS.PREVIEW_RECIPE, 'p1')).toEqual({ success: true, data: { source: 'file', servicesFrom: 'file', services: [site] } });
  });

  it('recipe: passes over a preview.json whose folder is a link out of the project', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'vt-outside-'));
    symlinkSync(outside, join(dirs.project, 'ext'));
    writeFileSync(join(dirs.project, 'preview.json'), JSON.stringify({ version: 1, kind: 'web', services: [{ name: 'site', dir: 'ext', command: 'make serve', page: true }] }));
    const result = (await invoke(IPC_CHANNELS.PREVIEW_RECIPE, 'p1')) as { data: { source: string; invalid?: string } };
    expect(result.data.source).toBe('settings');
    expect(result.data.invalid).toMatch(/ext leads out of the project/);
  });

  it("proposes services from the task's own folder for a task's preview, not from the project's", async () => {
    dirs.taskWorktree = mkdtempSync(join(tmpdir(), 'vt-task-'));
    writeFileSync(join(dirs.taskWorktree, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
    expect(await invoke(IPC_CHANNELS.PREVIEW_PROPOSE_SERVICES, 'p1', 't1')).toEqual({ success: true, data: [{ name: 'web', dir: '', command: 'npm run dev -- --port {port}', page: true }] });
    expect(await invoke(IPC_CHANNELS.PREVIEW_PROPOSE_SERVICES, 'p1')).toEqual({ success: true, data: [] });
  });

  describe("changing a recipe's services in the app", () => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dirs.project, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const SITE = { name: 'site', dir: '', command: 'make serve', page: true };
    const FILE = { version: 1, kind: 'web', env: { FEATURE: 'on' }, services: [SITE] };
    const asRepo = (withFile = true) => {
      if (withFile) writeFileSync(join(dirs.project, 'preview.json'), `${JSON.stringify(FILE, null, 2)}\n`);
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 't@t');
      git('config', 'user.name', 't');
      git('add', '-A');
      git('commit', '-q', '-m', 'first');
    };
    type Saved = { success: boolean; error?: string; errorSaid?: { key: string }; data?: { source: string; servicesFrom: string; services: unknown[]; pending?: { origin: string; refusal?: string } } };
    const save = (services: unknown) => invoke(IPC_CHANNELS.PREVIEW_SAVE_RECIPE_SERVICES, 'p1', services) as Promise<Saved>;

    it('writes the change into main itself, keeps the rest of the recipe, and leaves nothing pending', async () => {
      asRepo();
      const changed = [{ ...SITE, command: 'make serve-fast', port: 8080 }];
      const result = await save(changed);
      expect(result).toEqual({ success: true, data: { source: 'file', servicesFrom: 'file', services: changed } });
      expect(JSON.parse(git('show', 'main:preview.json'))).toEqual({ ...FILE, services: changed });
      expect(SETTINGS.previewPendingRecipe).toBeUndefined();
      expect(git('status', '--porcelain')).toBe('');
    });

    it("uses the change at once and says why it is not in the repository yet, while the owner's folder is on another branch", async () => {
      asRepo();
      git('checkout', '-q', '-b', 'feature');
      const main = git('rev-parse', 'main');
      const changed = [{ ...SITE, command: 'make serve-fast' }];
      const result = await save(changed);
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ source: 'pending', servicesFrom: 'pending', services: changed, pending: { origin: 'owner' } });
      expect(result.data?.pending?.refusal).toMatch(/feature/);
      expect(git('rev-parse', 'main')).toBe(main);
      // Back on main, the next change goes in with it
      git('checkout', '-q', 'main');
      const again = await save([{ ...SITE, command: 'make serve-faster' }]);
      expect(again.data).toMatchObject({ source: 'file' });
      expect(JSON.parse(git('show', 'main:preview.json')).services[0].command).toBe('make serve-faster');
    });

    it('restarts the running preview by the saved recipe itself, or starts it, exactly once', async () => {
      asRepo();
      const changed = [{ ...SITE, command: 'make serve-fast' }];
      // What the preview is restarted with, as it was at that moment: the recipe is taken out of the settings once it is in main
      let restartedWith: unknown;
      session.restartPreviewServices.mockImplementationOnce((async (project: { settings: { previewPendingRecipe?: { recipe: { services: unknown[] } } } }) => {
        restartedWith = JSON.parse(JSON.stringify(project.settings.previewPendingRecipe?.recipe.services ?? null));
        return null;
      }) as never);
      await save(changed);
      expect(session.restartPreviewServices).toHaveBeenCalledTimes(1);
      expect(restartedWith).toEqual(changed);
      // Not running (the stand-in answers null): it is started instead
      await vi.waitFor(() => expect(session.startPreview).toHaveBeenCalledTimes(1));
    });

    it("shows main's recipe, not an edit of the file the owner has not committed", async () => {
      asRepo();
      writeFileSync(join(dirs.project, 'preview.json'), JSON.stringify({ version: 1, kind: 'web', services: [{ ...SITE, name: 'local-edit' }] }));
      const info = (await invoke(IPC_CHANNELS.PREVIEW_RECIPE, 'p1')) as { data: { source: string; services: Array<{ name: string }> } };
      expect(info.data.source).toBe('file');
      expect(info.data.services.map((s) => s.name)).toEqual(['site']);
    });

    it('says a recipe is still waiting also where the folder has another branch checked out', async () => {
      asRepo();
      git('checkout', '-q', '-b', 'feature');
      git('rm', '-q', 'preview.json');
      git('commit', '-q', '-m', 'no recipe on this branch');
      const result = await save([{ ...SITE, command: 'make serve-fast' }]);
      expect(result.data).toMatchObject({ source: 'pending', pending: { origin: 'owner' } });
      const info = (await invoke(IPC_CHANNELS.PREVIEW_RECIPE, 'p1')) as { data: { source: string; pending?: { refusalSaid?: { key: string } } } };
      expect(info.data.source).toBe('pending');
      expect(info.data.pending?.refusalSaid?.key).toBe('recipeOtherBranch');
    });

    it('refuses services a recipe may not have, and stores nothing', async () => {
      asRepo();
      const result = await save([{ ...SITE, command: 'sudo make serve' }]);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/services\[0\]\.command/);
      expect(result.errorSaid?.key).toBe('recipeCommand');
      expect(SETTINGS.previewPendingRecipe).toBeUndefined();
      expect(JSON.parse(git('show', 'main:preview.json'))).toEqual(FILE);
    });

    it('has nothing to change for a project without a recipe', async () => {
      asRepo(false);
      const result = await save([SITE]);
      expect(result.success).toBe(false);
      expect(result.errorSaid?.key).toBe('noRecipeToChange');
      expect(SETTINGS.previewPendingRecipe).toBeUndefined();
    });

    it('is an error for an unknown project, in a sentence the interface can translate', async () => {
      expect(await invoke(IPC_CHANNELS.PREVIEW_SAVE_RECIPE_SERVICES, 'nope', [SITE])).toMatchObject({ success: false, errorSaid: { key: 'projectNotFound' } });
    });
  });

  it('recipe: an unknown project is an error', async () => {
    expect(await invoke(IPC_CHANNELS.PREVIEW_RECIPE, 'nope')).toMatchObject({ success: false });
  });

  it('before the start, shows what each service will get from the example settings and never reads .env', async () => {
    const result = (await invoke(IPC_CHANNELS.PREVIEW_ENV, 'p1')) as { success: boolean; data: PreviewEnvReport };
    expect(result.success).toBe(true);
    expect(result.data.running).toBe(false);
    const vars = result.data.services[0].vars;
    expect(vars.find((v) => v.name === 'AUTH_TEST_IDP_ENABLED')).toMatchObject({ value: 'true', source: 'exampleDir' });
    expect(JSON.stringify(result.data)).not.toContain('leak');
  });

  it('never reads .env even when git tracks it', async () => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dirs.project, stdio: 'ignore' });
    git('init', '-q');
    git('add', '-f', '.');
    writeFileSync(join(dirs.project, '.env.example'), 'ROOT=1\n');
    const report = await previewEnvReport({ id: 'p1', path: dirs.project, settings: SETTINGS } as unknown as Project, dirs.project, undefined, 'git', NO_DOCKER);
    expect(JSON.stringify(report)).not.toContain('leak');
  });

  it('before the start, says when Docker is not running and the project needs a test database', async () => {
    writeFileSync(join(dirs.project, 'docker-compose.yml'), 'services:\n  db:\n    image: postgres:18\n');
    const project = { id: 'p1', path: dirs.project, settings: SETTINGS } as unknown as Project;
    expect(await previewEnvReport(project, dirs.project, undefined, join(dirs.project, 'no-git'), NO_DOCKER)).toMatchObject({ databases: ['postgres'], dockerUnavailable: true });
    expect(await previewEnvReport(project, dirs.project, undefined, join(dirs.project, 'no-git'), async () => ({ ok: true, stdout: '' }))).toMatchObject({ dockerUnavailable: false });
  });

  it('before the start, names the other compose services and says when Docker is not running for them', async () => {
    writeFileSync(join(dirs.project, 'docker-compose.yml'), 'services:\n  rabbitmq:\n    image: rabbitmq:3\n');
    const project = { id: 'p1', path: dirs.project, settings: SETTINGS } as unknown as Project;
    expect(await previewEnvReport(project, dirs.project, undefined, join(dirs.project, 'no-git'), NO_DOCKER)).toMatchObject({ databases: [], composeServices: ['rabbitmq'], dockerUnavailable: true });
  });

  it('while running, reports what the services got', async () => {
    const running: PreviewEnvReport = { running: true, restartNeeded: false, databases: [], mail: false, dockerUnavailable: false, services: [] };
    session.runningPreviewEnv.mockReturnValueOnce(running);
    expect(await invoke(IPC_CHANNELS.PREVIEW_ENV, 'p1')).toEqual({ success: true, data: running });
  });

  it('apply and restart restarts the running services, and starts the preview when it is not running', async () => {
    session.restartPreviewServices.mockResolvedValueOnce({ projectId: 'p1', stage: 'ready', origins: [] });
    expect(await invoke(IPC_CHANNELS.PREVIEW_RESTART_SERVICES, 'p1')).toMatchObject({ success: true, data: { stage: 'ready' } });
    expect(session.startPreview).not.toHaveBeenCalled();
    await invoke(IPC_CHANNELS.PREVIEW_RESTART_SERVICES, 'p1');
    expect(session.startPreview).toHaveBeenCalledTimes(1);
  });

  it('refuses an unknown project', async () => {
    expect(await invoke(IPC_CHANNELS.PREVIEW_ENV, 'nope')).toMatchObject({ success: false });
  });
});
