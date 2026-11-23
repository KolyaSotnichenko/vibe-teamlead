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
const SETTINGS = { previewServices: [{ name: 'api', dir: 'api', command: 'x', page: true }] };
vi.mock('../../project-store', () => ({
  projectStore: {
    getProject: vi.fn((id: string) => (id === 'p1' ? { id: 'p1', path: dirs.project, settings: SETTINGS } : undefined)),
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
