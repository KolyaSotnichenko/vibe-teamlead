import { ipcRenderer } from 'electron';

import { IPC_CHANNELS } from '../../shared/constants';
import type { PreviewAPI, PreviewStatus } from '../../shared/types/preview';

export type { PreviewAPI };

export const createPreviewAPI = (): PreviewAPI => ({
  start: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_START, projectId),
  stop: () => ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_STOP),
  onStatus: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, status: PreviewStatus) => callback(status);
    ipcRenderer.on(IPC_CHANNELS.PREVIEW_STATUS, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PREVIEW_STATUS, handler);
  },
  setBounds: (bounds) => ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_SET_BOUNDS, bounds),
  navigate: (navigation) => ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_NAVIGATE, navigation),
  proposeServices: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_PROPOSE_SERVICES, projectId),
  resetData: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_RESET_DATA, projectId),
  uxReview: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_UX_REVIEW, projectId),
  cancelUxReview: () => ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_UX_REVIEW_CANCEL),
  lastUxReview: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_UX_REVIEW_LAST, projectId),
});
