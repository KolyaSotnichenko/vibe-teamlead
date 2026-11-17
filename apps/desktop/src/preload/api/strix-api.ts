import { ipcRenderer } from 'electron';

import { IPC_CHANNELS } from '../../shared/constants';
import type { StrixAPI } from '../../shared/types/strix';

export type { StrixAPI };

/** window.electronAPI.strix — Security QA's own secrets go in, never out (only which are saved) */
export const createStrixAPI = (): StrixAPI => ({
  getSecretsStatus: () => ipcRenderer.invoke(IPC_CHANNELS.STRIX_SECRETS_STATUS),
  saveSecret: (provider, name, value) => ipcRenderer.invoke(IPC_CHANNELS.STRIX_SECRET_SAVE, provider, name, value),
  clearSecret: (provider, name) => ipcRenderer.invoke(IPC_CHANNELS.STRIX_SECRET_CLEAR, provider, name),
  pickCredentialsFile: () => ipcRenderer.invoke(IPC_CHANNELS.STRIX_PICK_CREDENTIALS_FILE),
});
