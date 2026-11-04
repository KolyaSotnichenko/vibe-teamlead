import { ipcRenderer } from 'electron';

import { IPC_CHANNELS } from '../../shared/constants';
import type { DesignAPI, DesignProgressEvent } from '../../shared/types/design-system';

export type { DesignAPI };

export const createDesignAPI = (): DesignAPI => ({
  get: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.DESIGN_GET, projectId),
  save: (projectId, content) => ipcRenderer.invoke(IPC_CHANNELS.DESIGN_SAVE, projectId, content),
  extract: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.DESIGN_EXTRACT, projectId),
  propose: (projectId, brief) => ipcRenderer.invoke(IPC_CHANNELS.DESIGN_PROPOSE, projectId, brief),
  write: (projectId, brief, direction) => ipcRenderer.invoke(IPC_CHANNELS.DESIGN_WRITE, projectId, brief, direction),
  cancel: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.DESIGN_CANCEL, projectId),
  onProgress: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: DesignProgressEvent) => callback(payload);
    ipcRenderer.on(IPC_CHANNELS.DESIGN_PROGRESS, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.DESIGN_PROGRESS, handler);
  },
  startStorybook: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.STORYBOOK_START, projectId),
  stopStorybook: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.STORYBOOK_STOP, projectId),
});
