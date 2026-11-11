import { ipcRenderer } from 'electron';

import { IPC_CHANNELS } from '../../shared/constants';
import type { DeployAPI, DeployRunsState, VercelAPI, VercelConnectState } from '../../shared/types/deploy';

export type { DeployAPI, VercelAPI };

export const createDeployAPI = (): DeployAPI => ({
  startRuns: (projectId, selectedRunId) =>
    ipcRenderer.invoke(IPC_CHANNELS.DEPLOY_RUNS_START, projectId, selectedRunId),
  selectRun: (projectId, runId) => ipcRenderer.invoke(IPC_CHANNELS.DEPLOY_RUNS_SELECT, projectId, runId),
  stopRuns: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.DEPLOY_RUNS_STOP, projectId),
  jobLog: (projectId, jobId) => ipcRenderer.invoke(IPC_CHANNELS.DEPLOY_JOB_LOG, projectId, jobId),
  onRunsUpdate: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, state: DeployRunsState) => callback(state);
    ipcRenderer.on(IPC_CHANNELS.DEPLOY_RUNS_UPDATE, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.DEPLOY_RUNS_UPDATE, handler);
  },
});

export const createVercelAPI = (): VercelAPI => ({
  status: () => ipcRenderer.invoke(IPC_CHANNELS.VERCEL_STATUS),
  connect: () => ipcRenderer.invoke(IPC_CHANNELS.VERCEL_CONNECT),
  cancelConnect: () => ipcRenderer.invoke(IPC_CHANNELS.VERCEL_CANCEL_CONNECT),
  setToken: (token) => ipcRenderer.invoke(IPC_CHANNELS.VERCEL_SET_TOKEN, token),
  disconnect: () => ipcRenderer.invoke(IPC_CHANNELS.VERCEL_DISCONNECT),
  onConnectState: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, state: VercelConnectState) => callback(state);
    ipcRenderer.on(IPC_CHANNELS.VERCEL_CONNECT_STATE, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.VERCEL_CONNECT_STATE, handler);
  },
});
