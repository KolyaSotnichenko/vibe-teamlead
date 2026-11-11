import { ipcRenderer } from 'electron';

import { IPC_CHANNELS } from '../../shared/constants';
import type { DeployAPI, DeployRunsState } from '../../shared/types/deploy';

export type { DeployAPI };

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
