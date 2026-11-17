/**
 * Settings → Security QA: Strix's own secrets. A secret comes in and is never
 * sent back: only which secrets are saved, per provider.
 */
import { type BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron';

import { IPC_CHANNELS } from '../../shared/constants';
import { isStrixProviderId, isStrixSecretName, type StrixSecretStatus } from '../../shared/constants/strix-providers';
import type { StrixSecretResult } from '../../shared/types/strix';
import type { StrixSecretStore } from '../ai/security/strix-secrets';

export function registerStrixHandlers(getStore: () => StrixSecretStore, getMainWindow: () => BrowserWindow | null = () => null): void {
  const status = (): StrixSecretStatus => {
    try {
      return getStore().status();
    } catch {
      return {};
    }
  };

  ipcMain.handle(IPC_CHANNELS.STRIX_SECRETS_STATUS, () => status());

  ipcMain.handle(IPC_CHANNELS.STRIX_SECRET_SAVE, (_e, provider: unknown, name: unknown, value: unknown): StrixSecretResult => {
    // "Same as agents" uses the Claude credential (Settings → Claude), not this store
    if (!isStrixProviderId(provider) || provider === 'agents' || !isStrixSecretName(name) || typeof value !== 'string') {
      return { success: false, error: 'invalid' };
    }
    if (!value.trim()) return { success: false, error: 'empty' };
    try {
      getStore().save(provider, name, value);
      return { success: true, data: status() };
    } catch {
      return { success: false, error: 'save_failed' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.STRIX_SECRET_CLEAR, (_e, provider: unknown, name: unknown): StrixSecretResult => {
    if (!isStrixProviderId(provider) || !isStrixSecretName(name)) return { success: false, error: 'invalid' };
    try {
      getStore().clear(provider, name);
      return { success: true, data: status() };
    } catch {
      return { success: false, error: 'save_failed' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.STRIX_PICK_CREDENTIALS_FILE, async (): Promise<string | null> => {
    const options: OpenDialogOptions = { properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] };
    const window = getMainWindow();
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
}
