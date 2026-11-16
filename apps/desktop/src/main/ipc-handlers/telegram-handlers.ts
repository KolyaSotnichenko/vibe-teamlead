/**
 * Settings → Telegram. The token comes in and is never sent back: only the status.
 */
import { ipcMain } from 'electron';

import { IPC_CHANNELS } from '../../shared/constants';
import type { TelegramNotificationSettings, TelegramStatus } from '../../shared/types/telegram';
import type { TelegramService } from '../telegram/service';
import { DEFAULT_NOTIFICATIONS } from '../telegram/settings-store';

const OFF: TelegramStatus = { connection: 'not_set', notifications: DEFAULT_NOTIFICATIONS };

export function registerTelegramHandlers(getService: () => TelegramService | undefined): void {
  ipcMain.handle(IPC_CHANNELS.TELEGRAM_STATUS, () => getService()?.status() ?? OFF);
  ipcMain.handle(IPC_CHANNELS.TELEGRAM_SAVE_TOKEN, async (_e, token: unknown) => {
    const service = getService();
    if (!service) return { success: false, error: 'unknown' };
    return service.saveToken(typeof token === 'string' ? token : '');
  });
  ipcMain.handle(IPC_CHANNELS.TELEGRAM_TEST_TOKEN, async (_e, token: unknown) => {
    const service = getService();
    if (!service) return { success: false, error: 'unknown' };
    return service.testToken(typeof token === 'string' ? token : '');
  });
  ipcMain.handle(IPC_CHANNELS.TELEGRAM_REMOVE_TOKEN, async () => (await getService()?.removeToken()) ?? OFF);
  ipcMain.handle(IPC_CHANNELS.TELEGRAM_NEW_PAIRING_CODE, () => getService()?.newPairingCode() ?? OFF);
  ipcMain.handle(IPC_CHANNELS.TELEGRAM_UNPAIR, () => getService()?.unpair() ?? OFF);
  ipcMain.handle(IPC_CHANNELS.TELEGRAM_SET_NOTIFICATIONS, (_e, notifications: TelegramNotificationSettings) => {
    const service = getService();
    if (!service || !notifications || typeof notifications !== 'object') return getService()?.status() ?? OFF;
    return service.setNotifications(notifications);
  });
}
