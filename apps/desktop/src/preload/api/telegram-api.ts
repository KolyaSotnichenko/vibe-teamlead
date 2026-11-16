import { ipcRenderer } from 'electron';

import { IPC_CHANNELS } from '../../shared/constants';
import type { TelegramAPI, TelegramDigestSettings, TelegramNotificationSettings, TelegramStatus } from '../../shared/types/telegram';

export type { TelegramAPI };

/** window.electronAPI.telegram — the bot token goes in, never out */
export const createTelegramAPI = (): TelegramAPI => ({
  getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.TELEGRAM_STATUS),
  saveToken: (token: string) => ipcRenderer.invoke(IPC_CHANNELS.TELEGRAM_SAVE_TOKEN, token),
  testToken: (token: string) => ipcRenderer.invoke(IPC_CHANNELS.TELEGRAM_TEST_TOKEN, token),
  removeToken: () => ipcRenderer.invoke(IPC_CHANNELS.TELEGRAM_REMOVE_TOKEN),
  newPairingCode: () => ipcRenderer.invoke(IPC_CHANNELS.TELEGRAM_NEW_PAIRING_CODE),
  unpair: () => ipcRenderer.invoke(IPC_CHANNELS.TELEGRAM_UNPAIR),
  setNotifications: (notifications: TelegramNotificationSettings) =>
    ipcRenderer.invoke(IPC_CHANNELS.TELEGRAM_SET_NOTIFICATIONS, notifications),
  setDigest: (digest: TelegramDigestSettings) => ipcRenderer.invoke(IPC_CHANNELS.TELEGRAM_SET_DIGEST, digest),
  onStatus: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, status: TelegramStatus) => callback(status);
    ipcRenderer.on(IPC_CHANNELS.TELEGRAM_STATUS_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TELEGRAM_STATUS_CHANGED, handler);
  },
});
