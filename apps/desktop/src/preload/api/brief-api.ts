import { ipcRenderer, webUtils } from 'electron';

import { IPC_CHANNELS } from '../../shared/constants';
import type { BriefAPI, BriefProgressEvent } from '../../shared/types/brief';

export type { BriefAPI };

export const createBriefAPI = (): BriefAPI => ({
  pickFile: () => ipcRenderer.invoke(IPC_CHANNELS.BRIEF_PICK_FILE),
  pathForFile: (file) => webUtils.getPathForFile(file),
  analyze: (projectId, input) => ipcRenderer.invoke(IPC_CHANNELS.BRIEF_ANALYZE, projectId, input),
  cancel: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.BRIEF_CANCEL, projectId),
  createTasks: (projectId, briefId, tasks, options) =>
    ipcRenderer.invoke(IPC_CHANNELS.BRIEF_CREATE_TASKS, projectId, briefId, tasks, options),
  onProgress: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: BriefProgressEvent) => callback(payload);
    ipcRenderer.on(IPC_CHANNELS.BRIEF_PROGRESS, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.BRIEF_PROGRESS, handler);
  },
});
