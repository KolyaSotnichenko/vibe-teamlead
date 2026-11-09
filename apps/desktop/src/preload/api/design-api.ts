import { ipcRenderer, webUtils } from 'electron';

import { IPC_CHANNELS } from '../../shared/constants';
import type { DesignAPI, DesignProgressEvent } from '../../shared/types/design-system';

export type { DesignAPI };

export const createDesignAPI = (): DesignAPI => ({
  get: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.DESIGN_GET, projectId),
  redesignBrief: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.DESIGN_REDESIGN_BRIEF, projectId),
  audit: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.DESIGN_AUDIT, projectId),
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
  taskStorybookStatus: (taskId, projectId) => ipcRenderer.invoke(IPC_CHANNELS.STORYBOOK_TASK_STATUS, taskId, projectId),
  startTaskStorybook: (taskId, projectId) => ipcRenderer.invoke(IPC_CHANNELS.STORYBOOK_TASK_START, taskId, projectId),
  stopTaskStorybook: (taskId, projectId) => ipcRenderer.invoke(IPC_CHANNELS.STORYBOOK_TASK_STOP, taskId, projectId),
  listReferences: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.DESIGN_REFS_LIST, projectId),
  pickReferenceFiles: () => ipcRenderer.invoke(IPC_CHANNELS.DESIGN_REFS_PICK),
  pathForFile: (file) => webUtils.getPathForFile(file),
  addReferenceFiles: (projectId, paths, role) => ipcRenderer.invoke(IPC_CHANNELS.DESIGN_REFS_ADD_FILES, projectId, paths, role),
  addReferenceUrls: (projectId, urls, role) => ipcRenderer.invoke(IPC_CHANNELS.DESIGN_REFS_ADD_URLS, projectId, urls, role),
  setReferenceRole: (projectId, id, role) => ipcRenderer.invoke(IPC_CHANNELS.DESIGN_REFS_SET_ROLE, projectId, id, role),
  removeReference: (projectId, id) => ipcRenderer.invoke(IPC_CHANNELS.DESIGN_REFS_REMOVE, projectId, id),
  retryReference: (projectId, id) => ipcRenderer.invoke(IPC_CHANNELS.DESIGN_REFS_RETRY, projectId, id),
  onReferencesChanged: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, projectId: string) => callback(projectId);
    ipcRenderer.on(IPC_CHANNELS.DESIGN_REFS_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.DESIGN_REFS_CHANGED, handler);
  },
});
