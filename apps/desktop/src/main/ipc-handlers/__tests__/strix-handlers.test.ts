import { dialog, ipcMain } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import { IPC_CHANNELS } from '../../../shared/constants';
import { registerStrixHandlers } from '../strix-handlers';

const invoke = (channel: string, ...args: unknown[]) =>
  (ipcMain as unknown as { invokeHandler: (c: string, e: unknown, ...a: unknown[]) => Promise<unknown> }).invokeHandler(channel, {}, ...args);

function fakeStore() {
  const saved: Record<string, Record<string, string>> = {};
  return {
    saved,
    load: vi.fn((p: string) => ({ ...(saved[p] ?? {}) })),
    save: vi.fn((p: string, n: string, v: string) => {
      if (!v.trim()) throw new Error('The value is empty');
      saved[p] = { ...saved[p], [n]: v };
    }),
    clear: vi.fn((p: string, n: string) => {
      delete saved[p]?.[n];
    }),
    status: vi.fn(() => Object.fromEntries(Object.entries(saved).map(([p, s]) => [p, Object.fromEntries(Object.keys(s).map((n) => [n, true]))]))),
  };
}

describe('Settings → Security QA IPC', () => {
  it('takes a secret in and gives only the status back', async () => {
    const store = fakeStore();
    registerStrixHandlers(() => store as never);
    const result = await invoke(IPC_CHANNELS.STRIX_SECRET_SAVE, 'openrouter', 'apiKey', 'sk-or-SECRET');
    expect(store.save).toHaveBeenCalledWith('openrouter', 'apiKey', 'sk-or-SECRET');
    expect(result).toEqual({ success: true, data: { openrouter: { apiKey: true } } });
    expect(JSON.stringify(await invoke(IPC_CHANNELS.STRIX_SECRETS_STATUS))).not.toContain('SECRET');
    expect(await invoke(IPC_CHANNELS.STRIX_SECRET_CLEAR, 'openrouter', 'apiKey')).toEqual({ success: true, data: { openrouter: {} } });
  });

  it('refuses unknown providers, names and non-string values without touching the store', async () => {
    const store = fakeStore();
    registerStrixHandlers(() => store as never);
    for (const args of [['nope', 'apiKey', 'k'], ['openai', 'nope', 'k'], ['openai', 'apiKey', 42], ['agents', 'apiKey', 'k']]) {
      expect(await invoke(IPC_CHANNELS.STRIX_SECRET_SAVE, ...args)).toMatchObject({ success: false });
    }
    expect(await invoke(IPC_CHANNELS.STRIX_SECRET_CLEAR, 'nope', 'apiKey')).toMatchObject({ success: false });
    expect(store.save).not.toHaveBeenCalled();
    expect(store.clear).not.toHaveBeenCalled();
    expect(await invoke(IPC_CHANNELS.STRIX_SECRET_SAVE, 'openai', 'apiKey', '  ')).toMatchObject({ success: false });
  });

  it('picks a credentials file, or nothing when cancelled', async () => {
    registerStrixHandlers(() => fakeStore() as never);
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: ['/keys/sa.json'] });
    expect(await invoke(IPC_CHANNELS.STRIX_PICK_CREDENTIALS_FILE)).toBe('/keys/sa.json');
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: true, filePaths: [] });
    expect(await invoke(IPC_CHANNELS.STRIX_PICK_CREDENTIALS_FILE)).toBeNull();
  });
});
