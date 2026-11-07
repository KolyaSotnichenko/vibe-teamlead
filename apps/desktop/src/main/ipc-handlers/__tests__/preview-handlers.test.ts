import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ipcMain } from 'electron';

import { IPC_CHANNELS } from '../../../shared/constants';

vi.mock('../../preview/preview-session', () => ({
  startPreview: vi.fn(async (project: { id: string }, onStatus: (s: unknown) => void) => {
    const status = { projectId: project.id, stage: 'ready', url: 'http://localhost:4100', origins: ['http://localhost:4100'] };
    onStatus(status);
    return status;
  }),
  stopPreview: vi.fn(async () => {}),
}));
vi.mock('../../project-store', () => ({
  projectStore: { getProject: vi.fn((id: string) => (id === 'p1' ? { id: 'p1', path: '/p1', settings: {} } : undefined)) },
}));
vi.mock('../../cli-tool-manager', () => ({ getToolPath: () => 'git' }));

import { startPreview, stopPreview } from '../../preview/preview-session';
import { registerPreviewHandlers } from '../preview-handlers';

type Invoke = (channel: string, event: unknown, ...args: unknown[]) => Promise<unknown>;
const invoke = (channel: string, ...args: unknown[]) => (ipcMain as unknown as { invokeHandler: Invoke }).invokeHandler(channel, {}, ...args);

function fakeView() {
  return { show: vi.fn(), setBounds: vi.fn(), navigate: vi.fn(), destroy: vi.fn() };
}

describe('preview IPC', () => {
  let view: ReturnType<typeof fakeView>;
  const window = { isDestroyed: () => false, webContents: { send: vi.fn(), on: vi.fn() } };

  beforeEach(() => {
    vi.clearAllMocks();
    view = fakeView();
    registerPreviewHandlers(() => window as never, view as never);
  });

  it('start for an unknown project returns success false and starts nothing', async () => {
    expect(await invoke(IPC_CHANNELS.PREVIEW_START, 'nope')).toMatchObject({ success: false });
    expect(startPreview).not.toHaveBeenCalled();
  });

  it('start shows the view when the preview is ready and sends the status', async () => {
    expect(await invoke(IPC_CHANNELS.PREVIEW_START, 'p1')).toMatchObject({ success: true, data: { stage: 'ready' } });
    expect(view.show).toHaveBeenCalledWith('p1', 'http://localhost:4100', ['http://localhost:4100']);
    expect(window.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.PREVIEW_STATUS, expect.objectContaining({ stage: 'ready' }));
  });

  it('reset data starts with resetData', async () => {
    await invoke(IPC_CHANNELS.PREVIEW_RESET_DATA, 'p1');
    expect(startPreview).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }), expect.any(Function), expect.objectContaining({ git: 'git' }), { resetData: true });
  });

  it('stop calls stopPreview and destroys the view', async () => {
    await invoke(IPC_CHANNELS.PREVIEW_STOP);
    expect(stopPreview).toHaveBeenCalled();
    expect(view.destroy).toHaveBeenCalled();
  });

  it('setBounds before start is passed on without throwing', async () => {
    expect(await invoke(IPC_CHANNELS.PREVIEW_SET_BOUNDS, { x: 0, y: 0, width: 10, height: 10 })).toEqual({ success: true });
    expect(view.setBounds).toHaveBeenCalled();
  });

  it("stops the preview when the app's own page reloads, watching from the first start", async () => {
    expect(window.webContents.on).not.toHaveBeenCalled();
    await invoke(IPC_CHANNELS.PREVIEW_START, 'p1');
    await invoke(IPC_CHANNELS.PREVIEW_START, 'p1');
    expect(window.webContents.on.mock.calls.filter(([event]) => event === 'did-start-navigation')).toHaveLength(1);
    const listener = window.webContents.on.mock.calls.find(([event]) => event === 'did-start-navigation')?.[1] as (d: unknown) => void;
    listener({ isMainFrame: true, isSameDocument: false });
    expect(view.destroy).toHaveBeenCalled();
    expect(stopPreview).toHaveBeenCalled();
  });
});
