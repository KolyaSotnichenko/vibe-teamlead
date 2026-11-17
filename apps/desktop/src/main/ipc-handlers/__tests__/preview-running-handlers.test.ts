import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ipcMain } from 'electron';

import { IPC_CHANNELS } from '../../../shared/constants';

const dirs = vi.hoisted(() => ({ project: '', worktree: '' }));

vi.mock('../../preview/preview-session', () => ({
  startPreview: vi.fn(),
  stopPreview: vi.fn(async () => {}),
  currentPreview: vi.fn(() => null),
  previewLogs: vi.fn(() => []),
  previewMailPort: vi.fn(() => undefined),
}));
vi.mock('../../project-store', () => ({
  projectStore: {
    getProject: vi.fn((id: string) => (id === 'p1' ? { id: 'p1', path: dirs.project, settings: {} } : undefined)),
    getTasks: vi.fn(() => [{ id: 't1', specId: '001-x' }]),
  },
}));
vi.mock('../../worktree-paths', () => ({ findTaskWorktree: vi.fn((_p: string, specId: string) => (specId === '001-x' ? dirs.worktree : null)) }));
vi.mock('../../cli-tool-manager', () => ({ getToolPath: () => 'git' }));

import { registerPreviewHandlers } from '../preview-handlers';

type Invoke = (channel: string, event: unknown, ...args: unknown[]) => Promise<unknown>;
const invoke = (channel: string, ...args: unknown[]) => (ipcMain as unknown as { invokeHandler: Invoke }).invokeHandler(channel, {}, ...args);

describe('preview IPC: RUNNING.md', () => {
  beforeEach(() => {
    (ipcMain as unknown as { removeAllListeners: () => void }).removeAllListeners();
    dirs.project = mkdtempSync(join(tmpdir(), 'vt-run-p-'));
    dirs.worktree = mkdtempSync(join(tmpdir(), 'vt-run-w-'));
    const view = { onOverlayEvent: vi.fn(() => () => {}) };
    registerPreviewHandlers(() => null, view as never);
  });

  it("reads the project's RUNNING.md and says where it is", async () => {
    writeFileSync(join(dirs.project, 'RUNNING.md'), '# Run\n');
    expect(await invoke(IPC_CHANNELS.PREVIEW_RUNNING_DOC, 'p1')).toEqual({
      success: true,
      data: { exists: true, markdown: '# Run\n', truncated: false, dir: dirs.project },
    });
  });

  it("reads a task's from its worktree, where the task's agents keep it", async () => {
    writeFileSync(join(dirs.worktree, 'RUNNING.md'), 'task');
    expect(await invoke(IPC_CHANNELS.PREVIEW_RUNNING_DOC, 'p1', 't1')).toMatchObject({ success: true, data: { markdown: 'task', dir: dirs.worktree } });
  });

  it('says it is missing, with the folder a terminal would open in', async () => {
    expect(await invoke(IPC_CHANNELS.PREVIEW_RUNNING_DOC, 'p1')).toEqual({ success: true, data: { exists: false, dir: dirs.project } });
  });

  it('refuses an unknown project', async () => {
    expect(await invoke(IPC_CHANNELS.PREVIEW_RUNNING_DOC, 'nope')).toMatchObject({ success: false });
  });
});
