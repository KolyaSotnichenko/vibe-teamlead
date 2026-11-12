import { ipcRenderer } from 'electron';

import { IPC_CHANNELS } from '../../shared/constants';
import type {
  DeployAPI,
  DeployDatabaseProgress,
  DeployPushResult,
  DeployRunsState,
  ReadinessState,
  DeploySetupProgress,
  VercelAPI,
  VercelConnectState,
} from '../../shared/types/deploy';

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
  setUp: (projectId, opts) => ipcRenderer.invoke(IPC_CHANNELS.DEPLOY_SETUP, projectId, opts),
  state: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.DEPLOY_STATE, projectId),
  chooseVercelProject: (projectId, choice) => ipcRenderer.invoke(IPC_CHANNELS.DEPLOY_CHOOSE_VERCEL_PROJECT, projectId, choice),
  setVariable: (projectId, input) => ipcRenderer.invoke(IPC_CHANNELS.DEPLOY_SET_VARIABLE, projectId, input),
  listVariables: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.DEPLOY_LIST_VARIABLES, projectId),
  addDatabase: (projectId, opts) => ipcRenderer.invoke(IPC_CHANNELS.DEPLOY_ADD_DATABASE, projectId, opts),
  cancelDatabase: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.DEPLOY_CANCEL_DATABASE, projectId),
  addService: (projectId, service, opts) => ipcRenderer.invoke(IPC_CHANNELS.DEPLOY_ADD_SERVICE, projectId, service, opts),
  cancelService: (projectId, service) => ipcRenderer.invoke(IPC_CHANNELS.DEPLOY_CANCEL_SERVICE, projectId, service),
  onDatabaseProgress: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: DeployDatabaseProgress) => callback(progress);
    ipcRenderer.on(IPC_CHANNELS.DEPLOY_DATABASE_PROGRESS, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.DEPLOY_DATABASE_PROGRESS, handler);
  },
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
