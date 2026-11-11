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
    expect(await pending).toEqual({ success: false, error: 'cancelled' });
  });

  it('a second connect while one runs answers busy', async () => {
    cred.connectVercel.mockImplementation(() => new Promise<void>(() => undefined));
    void invoke(IPC_CHANNELS.VERCEL_CONNECT);
    expect(await invoke(IPC_CHANNELS.VERCEL_CONNECT)).toEqual({ success: false, error: 'busy' });
  });

  it('errors cross IPC as kinds only, never as main-process text', async () => {
    cred.connectVercel.mockRejectedValueOnce(Object.assign(new Error('Vercel CLI download timed out at /Users/x'), { kind: 'timeout' }));
    expect(await invoke(IPC_CHANNELS.VERCEL_CONNECT)).toEqual({ success: false, error: 'timeout' });
    cred.setVercelToken.mockRejectedValueOnce(Object.assign(new Error('Encryption is unavailable'), { kind: 'encryption-unavailable' }));
    expect(await invoke(IPC_CHANNELS.VERCEL_SET_TOKEN, 'tok')).toEqual({ success: false, error: 'encryption-unavailable' });
    cred.setVercelToken.mockRejectedValueOnce(new Error('ENOENT: /Users/x/secret'));
    expect(await invoke(IPC_CHANNELS.VERCEL_SET_TOKEN, 'tok')).toEqual({ success: false, error: 'unknown' });
    cred.vercelStatus.mockRejectedValueOnce(new Error('boom'));
    expect(await invoke(IPC_CHANNELS.VERCEL_STATUS)).toEqual({ success: false, error: 'unknown' });
  });

  it('setToken, disconnect and status go to the credential', async () => {
    expect(await invoke(IPC_CHANNELS.VERCEL_SET_TOKEN, 'tok')).toEqual({ success: true, data: { connected: false } });
    expect(cred.setVercelToken).toHaveBeenCalledWith('tok');
    expect(await invoke(IPC_CHANNELS.VERCEL_DISCONNECT)).toEqual({ success: true, data: { connected: false } });
    expect(cred.disconnectVercel).toHaveBeenCalled();
    expect(await invoke(IPC_CHANNELS.VERCEL_STATUS)).toMatchObject({ success: true, data: { connected: true } });
  });
});
