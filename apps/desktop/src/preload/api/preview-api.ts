import { ipcRenderer } from 'electron';

import { IPC_CHANNELS } from '../../shared/constants';
import type { PreviewAPI, PreviewOverlayEvent, PreviewStatus } from '../../shared/types/preview';

export type { PreviewAPI };

export const createPreviewAPI = (): PreviewAPI => ({
  start: (projectId, taskId) => ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_START, projectId, taskId),
  stop: () => ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_STOP),
  onStatus: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, status: PreviewStatus) => callback(status);
    ipcRenderer.on(IPC_CHANNELS.PREVIEW_STATUS, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PREVIEW_STATUS, handler);
  },
  setBounds: (bounds) => ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_SET_BOUNDS, bounds),
  navigate: (navigation) => ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_NAVIGATE, navigation),
  proposeServices: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_PROPOSE_SERVICES, projectId),
  resetData: (projectId, taskId) => ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_RESET_DATA, projectId, taskId),
  uxReview: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_UX_REVIEW, projectId),
  cancelUxReview: () => ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_UX_REVIEW_CANCEL),
  lastUxReview: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_UX_REVIEW_LAST, projectId),
  logs: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_LOGS, projectId),
  mailList: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_MAIL_LIST, projectId),
  mailGet: (projectId, id) => ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_MAIL_GET, projectId, id),
  setNotesMode: (on) => ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_NOTES_MODE, on),
  setPins: (pins) => ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_PINS, pins),
  focusPin: (n) => ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_FOCUS_PIN, n),
  onOverlayEvent: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, overlayEvent: PreviewOverlayEvent) => callback(overlayEvent);
    ipcRenderer.on(IPC_CHANNELS.PREVIEW_OVERLAY_EVENT, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PREVIEW_OVERLAY_EVENT, handler);
  },
  loadNotes: (projectId, taskId) => ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_NOTES_LOAD, projectId, taskId),
  saveNotes: (projectId, notes, taskId) => ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_NOTES_SAVE, projectId, notes, taskId),
});
