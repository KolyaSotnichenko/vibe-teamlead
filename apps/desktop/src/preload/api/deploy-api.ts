import { ipcRenderer } from 'electron';

import { IPC_CHANNELS } from '../../shared/constants';
import type {
  DeployAPI,
  DeployPushResult,
  DeployRunsState,
  ReadinessState,
  DeploySetupProgress,
} from '../../shared/types/deploy';

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
  setUp: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.DEPLOY_SETUP, projectId),
  state: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.DEPLOY_STATE, projectId),
  onSetupProgress: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: DeploySetupProgress) => callback(progress);
    ipcRenderer.on(IPC_CHANNELS.DEPLOY_SETUP_PROGRESS, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.DEPLOY_SETUP_PROGRESS, handler);
  },
  onPushResult: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, result: DeployPushResult) => callback(result);
    ipcRenderer.on(IPC_CHANNELS.DEPLOY_PUSH_RESULT, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.DEPLOY_PUSH_RESULT, handler);
  },
  isDeployTask: (projectId, specId) => ipcRenderer.invoke(IPC_CHANNELS.DEPLOY_IS_DEPLOY_TASK, projectId, specId),
  readinessState: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.DEPLOY_READINESS_STATE, projectId),
  scanReadiness: (projectId, reason) => ipcRenderer.invoke(IPC_CHANNELS.DEPLOY_READINESS_SCAN, projectId, reason),
  onReadinessUpdate: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, update: { projectId: string; state: ReadinessState }) => callback(update);
    ipcRenderer.on(IPC_CHANNELS.DEPLOY_READINESS_UPDATE, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.DEPLOY_READINESS_UPDATE, handler);
  },
  previewState: (projectId, taskId) => ipcRenderer.invoke(IPC_CHANNELS.DEPLOY_PREVIEW_STATE, projectId, taskId),
  onPreviewUpdate: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, update: { projectId: string; taskId: string }) => callback(update);
    ipcRenderer.on(IPC_CHANNELS.DEPLOY_PREVIEW_UPDATE, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.DEPLOY_PREVIEW_UPDATE, handler);
  },
});
