import { ipcRenderer } from 'electron';

import { IPC_CHANNELS } from '../../shared/constants';
import type { CloudArchitectureAPI } from '../../shared/types/cloud-architecture';

export type { CloudArchitectureAPI };

export const createCloudArchitectureAPI = (): CloudArchitectureAPI => ({
  get: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.CLOUD_ARCHITECTURE_GET, projectId),
  open: (projectId, file) => ipcRenderer.invoke(IPC_CHANNELS.CLOUD_ARCHITECTURE_OPEN, projectId, file),
  tools: () => ipcRenderer.invoke(IPC_CHANNELS.CLOUD_DIAGRAMS_TOOLS),
  onUpdated: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, projectId: string) => callback(projectId);
    ipcRenderer.on(IPC_CHANNELS.CLOUD_ARCHITECTURE_UPDATED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.CLOUD_ARCHITECTURE_UPDATED, handler);
  },
});
