import { ipcMain } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import { IPC_CHANNELS } from '../../../shared/constants';
import { registerTelegramHandlers } from '../telegram-handlers';

const invoke = (channel: string, ...args: unknown[]) =>
  (ipcMain as unknown as { invokeHandler: (c: string, e: unknown, ...a: unknown[]) => Promise<unknown> }).invokeHandler(channel, {}, ...args);

describe('Settings → Telegram IPC', () => {
  it('answers "not set" before the bot exists', async () => {
    registerTelegramHandlers(() => undefined);
    expect(await invoke(IPC_CHANNELS.TELEGRAM_STATUS)).toMatchObject({ connection: 'not_set' });
    expect(await invoke(IPC_CHANNELS.TELEGRAM_SAVE_TOKEN, 'x')).toEqual({ success: false, error: 'unknown' });
  });

  it('passes the token in and only the status out', async () => {
    const status = { connection: 'connected', botUsername: 'my_bot', notifications: {} };
    const service = {
      status: vi.fn(() => status),
      saveToken: vi.fn(async () => ({ success: true, data: status })),
      testToken: vi.fn(async () => ({ success: true, data: { username: 'my_bot' } })),
      removeToken: vi.fn(async () => status),
      newPairingCode: vi.fn(() => status),
      unpair: vi.fn(() => status),
      setNotifications: vi.fn(() => status),
    };
    registerTelegramHandlers(() => service as never);
    const saved = await invoke(IPC_CHANNELS.TELEGRAM_SAVE_TOKEN, '123:SECRET');
    expect(service.saveToken).toHaveBeenCalledWith('123:SECRET');
    expect(JSON.stringify(saved)).not.toContain('SECRET');
    await invoke(IPC_CHANNELS.TELEGRAM_SAVE_TOKEN, 42);
    expect(service.saveToken).toHaveBeenLastCalledWith('');
    await invoke(IPC_CHANNELS.TELEGRAM_SET_NOTIFICATIONS, null);
    expect(service.setNotifications).not.toHaveBeenCalled();
  });
});
