/**
 * The frames' pictures (the Telegram album, QA's design/shots) are taken in an offscreen window.
 * vt-design:// is served in the main session only, and Electron doesn't serve it on a partition
 * of its own: a shot window there failed every frame and no picture was ever taken.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: vi.fn(), ipcMain: { handle: vi.fn() }, protocol: { handle: vi.fn() } }));
vi.mock('../../app-logger', () => ({ appLog: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() } }));
vi.mock('../../agent', () => ({ AgentManager: vi.fn() }));
vi.mock('../task/execution-handlers', () => ({ startTask: vi.fn() }));
vi.mock('../task/shared', () => ({ findTaskAndProject: vi.fn(() => ({})) }));
vi.mock('../task/workspace-handlers', () => ({ resolveSpecDir: vi.fn(() => null) }));
vi.mock('../../project-store', () => ({ projectStore: { getProject: vi.fn() } }));

import { SHOT_WEB_PREFERENCES } from '../task-design-handlers';

describe('the frame-picture window', () => {
  it('runs in the session that serves vt-design://, not a partition of its own', () => {
    expect(SHOT_WEB_PREFERENCES.partition).toBeUndefined();
    expect(SHOT_WEB_PREFERENCES.session).toBeUndefined();
  });

  it('stays locked down: offscreen, sandboxed, isolated, no Node', () => {
    expect(SHOT_WEB_PREFERENCES).toMatchObject({ offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false });
  });
});
