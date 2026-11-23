import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { app, ipcMain } from 'electron';

import { IPC_CHANNELS } from '../../../shared/constants';
import type { PreviewStatus, Project } from '../../../shared/types';

const GOOD = { version: 1, kind: 'web', services: [{ name: 'web', dir: '', command: 'npm run dev', page: true }] };
const FAILED: PreviewStatus = { projectId: 'p1', stage: 'failed', origins: [], message: 'web did not start', failedAt: 'services', failedService: 'web', recipe: { source: 'proposal', kind: 'web' }, logTail: 'npm error Missing script' };
const READY: PreviewStatus = { projectId: 'p1', stage: 'ready', url: 'http://localhost:5173', origins: ['http://localhost:5173'], recipe: { source: 'pending', kind: 'web' } };

const state = vi.hoisted(() => ({ project: '', settings: {} as Record<string, unknown>, starts: [] as Array<{ pending: unknown }>, credential: true }));
const session = vi.hoisted(() => ({
  startPreview: vi.fn(),
  stopPreview: vi.fn(async () => {}),
  currentPreview: vi.fn(() => null),
  previewLogs: vi.fn(() => []),
  previewMailPort: vi.fn(() => undefined),
  runningPreviewEnv: vi.fn(() => null),
  restartPreviewServices: vi.fn(async () => null),
  addPreviewNotice: vi.fn(() => false),
}));
const task = vi.hoisted(() => ({ runClaudeTask: vi.fn() }));

vi.mock('../../preview/preview-session', () => session);
vi.mock('../../ai/claude-code/task', () => task);
vi.mock('../../ai/claude-code/credential', () => ({ getClaudeCredentialStatus: () => ({ configured: state.credential }) }));
vi.mock('../feature-settings-helper', () => ({ getFeatureSettings: () => ({ model: 'sonnet', thinkingLevel: 'medium' }) }));
vi.mock('../../settings-utils', () => ({ readSettingsFile: () => ({ language: 'uk' }) }));
vi.mock('../../ai/verification/test-services', async (original) => ({ ...(await original<Record<string, unknown>>()), hostDocker: () => async () => ({ ok: false, stdout: '' }) }));
vi.mock('../../project-store', () => ({
  projectStore: {
    getProject: vi.fn((id: string) => (id === 'p1' ? ({ id: 'p1', path: state.project, settings: state.settings } as unknown as Project) : undefined)),
    getProjects: vi.fn(() => [{ id: 'p1', path: state.project, settings: state.settings }]),
    getTasks: vi.fn(() => []),
    updateProjectSettings: vi.fn((_id: string, changed: Record<string, unknown>) => { Object.assign(state.settings, changed); }),
  },
}));
vi.mock('../../worktree-paths', () => ({ findTaskWorktree: vi.fn(() => null) }));
vi.mock('../../cli-tool-manager', () => ({ getToolPath: () => 'git' }));

import { registerPreviewHandlers } from '../preview-handlers';

type Invoke = (channel: string, event: unknown, ...args: unknown[]) => Promise<unknown>;
const invoke = (channel: string, ...args: unknown[]) => (ipcMain as unknown as { invokeHandler: Invoke }).invokeHandler(channel, {}, ...args);

describe('preview IPC: the agent that fixes a failed start', () => {
  const sent: PreviewStatus[] = [];
  const window = { isDestroyed: () => false, webContents: { send: vi.fn((_channel: string, status: PreviewStatus) => { sent.push(status); }), on: vi.fn(), focus: vi.fn() } };

  beforeEach(() => {
    vi.clearAllMocks();
    (ipcMain as unknown as { removeAllListeners: () => void }).removeAllListeners();
    sent.length = 0;
    state.credential = true;
    state.starts = [];
    for (const key of Object.keys(state.settings)) delete state.settings[key];
    state.project = mkdtempSync(join(tmpdir(), 'vtl-fixproj-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: state.project, stdio: ['ignore', 'pipe', 'ignore'] });
    writeFileSync(join(state.project, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    git('add', '-A');
    git('commit', '-q', '-m', 'first');
    // The ledger of a run before must not answer for this one
    rmSync(join(app.getPath('userData'), 'preview', 'p1-start-fix.json'), { force: true });
    // The first start fails; each start after it is a try of the agent's recipe and comes up
    session.startPreview.mockImplementation(async (project: Project, onStatus: (s: PreviewStatus) => void) => {
      state.starts.push({ pending: JSON.parse(JSON.stringify(project.settings.previewPendingRecipe ?? null)) });
      const status = state.starts.length === 1 ? FAILED : READY;
      onStatus(status);
      return status;
    });
    task.runClaudeTask.mockImplementation(async (options: { tryPreviewRecipe: (recipe: unknown) => Promise<string>; prompt: string }) => {
      const answer = await options.tryPreviewRecipe(GOOD);
      return { text: '', output: { outcome: 'fixed', summary: `Команду виправлено. (${answer.slice(0, 7)})` } };
    });
    const view = { show: vi.fn(), hide: vi.fn(), setBounds: vi.fn(), navigate: vi.fn(), destroy: vi.fn(), setWorktree: vi.fn(), onOverlayEvent: vi.fn(() => () => {}) };
    registerPreviewHandlers(() => window as never, view as never);
  });

  it('after a failed start, runs the agent once, starts the preview by its recipe, and keeps the recipe for the project', async () => {
    await invoke(IPC_CHANNELS.PREVIEW_START, 'p1');
    await vi.waitFor(() => expect(sent.at(-1)?.fix).toEqual({ state: 'done', outcome: 'fixed', summary: 'Команду виправлено. (Started)' }));
    expect(sent.at(-1)?.stage).toBe('ready');
    expect(sent.some((s) => s.fix?.state === 'running')).toBe(true);
    // The try was the app's own start, by the agent's recipe
    expect(state.starts).toHaveLength(2);
    expect(state.starts[1].pending).toMatchObject({ recipe: GOOD, origin: 'agent', base: 'none' });
    // The agent was told what failed and what the machine has, in the owner's language, and never a variable's value
    const prompt = task.runClaudeTask.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('web did not start');
    expect(prompt).toContain('Missing script');
    expect(prompt).toMatch(/Docker does not answer/);
    expect(prompt).toMatch(/Ukrainian/);
    expect(task.runClaudeTask.mock.calls[0][0]).toMatchObject({ agentType: 'preview_fixer', model: 'sonnet' });
    // Kept: the recipe is the project's from now on (and goes on to main)
    await vi.waitFor(() => expect(execFileSync('git', ['show', 'main:preview.json'], { cwd: state.project, encoding: 'utf-8' })).toContain('npm run dev'));
  });

  it('shows what was found for the same failure the next time, without another session', async () => {
    task.runClaudeTask.mockImplementation(async () => ({ text: '', output: { outcome: 'needs_owner', summary: 'Бракує Docker.', missing: [{ what: 'Docker', why: 'для бази' }] } }));
    session.startPreview.mockImplementation(async (_project: Project, onStatus: (s: PreviewStatus) => void) => {
      onStatus(FAILED);
      return FAILED;
    });
    await invoke(IPC_CHANNELS.PREVIEW_START, 'p1');
    await vi.waitFor(() => expect(sent.at(-1)?.fix).toMatchObject({ state: 'done', outcome: 'needs_owner' }));
    await invoke(IPC_CHANNELS.PREVIEW_START, 'p1');
    await vi.waitFor(() => expect(sent.at(-1)?.fix).toMatchObject({ state: 'done', outcome: 'needs_owner', missing: [{ what: 'Docker', why: 'для бази' }] }));
    expect(task.runClaudeTask).toHaveBeenCalledTimes(1);
    // The owner asks again: a new session
    expect(await invoke(IPC_CHANNELS.PREVIEW_FIX, 'p1')).toEqual({ success: true });
    await vi.waitFor(() => expect(task.runClaudeTask).toHaveBeenCalledTimes(2));
  });

  it('has nothing to ask the agent about when no start of that project failed', async () => {
    expect(await invoke(IPC_CHANNELS.PREVIEW_FIX, 'p1')).toMatchObject({ success: false });
  });

  it('stops the agent when the owner stops it, and when the owner leaves the preview', async () => {
    let aborted = 0;
    task.runClaudeTask.mockImplementation((options: { abortSignal: AbortSignal }) => new Promise((_resolve, reject) => {
      options.abortSignal.addEventListener('abort', () => { aborted += 1; reject(new Error('aborted')); });
    }));
    session.startPreview.mockImplementation(async (_project: Project, onStatus: (s: PreviewStatus) => void) => {
      onStatus(FAILED);
      return FAILED;
    });
    await invoke(IPC_CHANNELS.PREVIEW_START, 'p1');
    await vi.waitFor(() => expect(sent.at(-1)?.fix?.state).toBe('running'));
    expect(await invoke(IPC_CHANNELS.PREVIEW_FIX_CANCEL)).toEqual({ success: true });
    expect(aborted).toBe(1);
    await vi.waitFor(() => expect(sent.at(-1)?.fix).toEqual({ state: 'idle' }));

    expect(await invoke(IPC_CHANNELS.PREVIEW_FIX, 'p1')).toEqual({ success: true });
    await vi.waitFor(() => expect(sent.at(-1)?.fix?.state).toBe('running'));
    await invoke(IPC_CHANNELS.PREVIEW_STOP);
    expect(aborted).toBe(2);
  });
});
