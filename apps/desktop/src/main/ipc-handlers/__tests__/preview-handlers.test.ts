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
  currentPreview: vi.fn(() => null),
  previewLogs: vi.fn(() => []),
  previewMailPort: vi.fn(() => undefined),
}));
vi.mock('../../project-store', () => ({
  projectStore: { getProject: vi.fn((id: string) => (id === 'p1' ? { id: 'p1', path: '/p1', settings: {} } : undefined)) },
}));
vi.mock('../../cli-tool-manager', () => ({ getToolPath: () => 'git' }));

import { currentPreview, startPreview, stopPreview } from '../../preview/preview-session';
import { readTail, registerPreviewHandlers } from '../preview-handlers';
import { mkdtempSync as mkTmp, writeFileSync as writeTmp } from 'node:fs';
import { join as joinPath } from 'node:path';
import { tmpdir as tmpDir } from 'node:os';

type Invoke = (channel: string, event: unknown, ...args: unknown[]) => Promise<unknown>;
const invoke = (channel: string, ...args: unknown[]) => (ipcMain as unknown as { invokeHandler: Invoke }).invokeHandler(channel, {}, ...args);

function fakeView() {
  let listener: (event: unknown) => void = () => {};
  return {
    show: vi.fn(), hide: vi.fn(), setBounds: vi.fn(), navigate: vi.fn(), destroy: vi.fn(),
    setWorktree: vi.fn(), setNotesMode: vi.fn(), setPins: vi.fn(), focusPin: vi.fn(),
    isOwnPage: vi.fn((id: number) => id === 77),
    handleOverlayMessage: vi.fn(async () => {}),
    onOverlayEvent: vi.fn((l: (event: unknown) => void) => { listener = l; return () => {}; }),
    emit: (event: unknown) => listener(event),
  };
}

describe('preview IPC', () => {
  let view: ReturnType<typeof fakeView>;
  const window = { isDestroyed: () => false, webContents: { send: vi.fn(), on: vi.fn(), focus: vi.fn() } };

  beforeEach(() => {
    vi.clearAllMocks();
    (ipcMain as unknown as { removeAllListeners: () => void }).removeAllListeners();
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

  it('takes the view off the screen while the preview is not ready, e.g. reinstalling after a merge', async () => {
    vi.mocked(startPreview).mockImplementationOnce(async (project, onStatus) => {
      const status = { projectId: project.id, stage: 'install' as const, origins: [] };
      onStatus(status);
      return status;
    });
    await invoke(IPC_CHANNELS.PREVIEW_START, 'p1');
    expect(view.hide).toHaveBeenCalled();
    expect(view.destroy).not.toHaveBeenCalled();
  });

  it('starts previews in the app folder, outside the project', async () => {
    await invoke(IPC_CHANNELS.PREVIEW_START, 'p1');
    expect(vi.mocked(startPreview).mock.calls[0][2].worktreesRoot).toMatch(/\/\.vibe-teamlead\/worktrees\/preview$/);
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

  describe('notes', () => {
    const emitter = ipcMain as unknown as { emit: (channel: string, ...args: unknown[]) => void };

    it("serves the overlay's script to the previewed page only", () => {
      const own = { sender: { id: 77 }, returnValue: undefined as unknown };
      const other = { sender: { id: 5 }, returnValue: undefined as unknown };
      emitter.emit('preview:overlay-source', own);
      emitter.emit('preview:overlay-source', other);
      expect(typeof own.returnValue).toBe('string');
      expect(other.returnValue).toBe('');
    });

    it("passes the page's messages to the view with who sent them", () => {
      emitter.emit('preview:overlay-event', { sender: { id: 77 } }, { type: 'escape' });
      expect(view.handleOverlayMessage).toHaveBeenCalledWith(77, { type: 'escape' });
    });

    it('sends a pick to the app and gives it the keyboard for the note', () => {
      view.emit({ type: 'picked', route: '/', width: 1280, pick: {} });
      expect(window.webContents.send).toHaveBeenCalledWith('preview:overlayEvent', { type: 'picked', route: '/', width: 1280, pick: {} });
      expect(window.webContents.focus).toHaveBeenCalled();
    });

    it('turns notes mode on and off, and passes only well-formed pins', async () => {
      await invoke('preview:notesMode', true);
      await invoke('preview:notesMode', 'yes');
      expect(view.setNotesMode.mock.calls).toEqual([[true], [false]]);
      await invoke('preview:pins', [{ n: 1, selector: '#a' }, { n: 'x' }, null]);
      expect(view.setPins).toHaveBeenCalledWith([{ n: 1, selector: '#a' }]);
    });
  });

  it("refuses a UX review of a task's preview: it reviews main's", async () => {
    vi.mocked(currentPreview).mockReturnValueOnce({ projectId: 'p1', taskId: 't23', stage: 'ready', url: 'http://localhost:1', origins: [] });
    const result = (await invoke('preview:uxReview', 'p1')) as { success: boolean; error?: string };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/task/i);
  });
});

describe('readTail', () => {
  it('gives the end of a log from a whole line, and nothing for a file that is not there', async () => {
    const dir = mkTmp(joinPath(tmpDir(), 'vtl-tail-'));
    const file = joinPath(dir, 'api.log');
    writeTmp(file, 'first line\nsecond line\nthird line\n');
    expect(await readTail(file, 1000)).toBe('first line\nsecond line\nthird line\n');
    expect(await readTail(file, 15)).toBe('third line\n');
    expect(await readTail(joinPath(dir, 'none.log'), 100)).toBe('');
  });
});
