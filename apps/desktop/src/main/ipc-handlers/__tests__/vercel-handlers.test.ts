import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ipcMain } from 'electron';

import { IPC_CHANNELS } from '../../../shared/constants';

const cred = vi.hoisted(() => ({
  vercelStatus: vi.fn(async () => ({ connected: true, source: 'browser', user: { username: 'ada' }, teams: [] })),
  connectVercel: vi.fn(),
  setVercelToken: vi.fn(async () => ({ connected: false })),
  disconnectVercel: vi.fn(async () => undefined),
}));
vi.mock('../../deploy/vercel-credential', () => cred);

import { registerVercelHandlers } from '../vercel-handlers';

type Invoke = (channel: string, event: unknown, ...args: unknown[]) => Promise<unknown>;
const invoke = (channel: string, ...args: unknown[]) =>
  (ipcMain as unknown as { invokeHandler: Invoke }).invokeHandler(channel, {}, ...args);

describe('vercel IPC', () => {
  const window = { isDestroyed: () => false, webContents: { send: vi.fn(), isDestroyed: () => false } };

  beforeEach(() => {
    vi.clearAllMocks();
    (ipcMain as unknown as { removeAllListeners: () => void }).removeAllListeners();
    registerVercelHandlers(() => window as never);
  });

  it('connect pushes progress to the window and answers with the status', async () => {
    cred.connectVercel.mockImplementation(async (onState: (s: unknown) => void) => {
      onState({ phase: 'waiting', url: 'https://vercel.com/oauth/device?user_code=AB-CD', code: 'AB-CD' });
    });
    const result = await invoke(IPC_CHANNELS.VERCEL_CONNECT);
    expect(window.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.VERCEL_CONNECT_STATE, {
      phase: 'waiting',
      url: 'https://vercel.com/oauth/device?user_code=AB-CD',
      code: 'AB-CD',
    });
    expect(result).toMatchObject({ success: true, data: { connected: true } });
  });

  it('cancel aborts the running sign-in', async () => {
    let seen: AbortSignal | undefined;
    cred.connectVercel.mockImplementation(
      (_onState: unknown, signal: AbortSignal) =>
        new Promise<void>((_, reject) => {
          seen = signal;
          signal.addEventListener('abort', () => reject(new Error('Vercel sign-in was cancelled')));
        }),
    );
    const pending = invoke(IPC_CHANNELS.VERCEL_CONNECT);
    // a second connect while one runs does not start another CLI
    expect(await invoke(IPC_CHANNELS.VERCEL_CONNECT)).toMatchObject({ success: false });
    expect(cred.connectVercel).toHaveBeenCalledTimes(1);
    await invoke(IPC_CHANNELS.VERCEL_CANCEL_CONNECT);
    expect(seen?.aborted).toBe(true);
    expect(await pending).toMatchObject({ success: false, error: 'Vercel sign-in was cancelled' });
  });

  it('setToken, disconnect and status go to the credential', async () => {
    expect(await invoke(IPC_CHANNELS.VERCEL_SET_TOKEN, 'tok')).toEqual({ success: true, data: { connected: false } });
    expect(cred.setVercelToken).toHaveBeenCalledWith('tok');
    expect(await invoke(IPC_CHANNELS.VERCEL_DISCONNECT)).toEqual({ success: true, data: { connected: false } });
    expect(cred.disconnectVercel).toHaveBeenCalled();
    expect(await invoke(IPC_CHANNELS.VERCEL_STATUS)).toMatchObject({ success: true, data: { connected: true } });
  });
});
