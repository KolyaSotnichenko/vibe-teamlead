/**
 * Deploy IPC: start, select and stop the runs poller, read a job's log.
 * The poller pushes its state to the window; errors travel as data.
 */
import { type BrowserWindow, ipcMain } from 'electron';

import { IPC_CHANNELS } from '../../shared/constants';
import type { IPCResult } from '../../shared/types';
import type { DeployJobLog } from '../../shared/types/deploy';
import { createActionsClient, resolveRepo } from '../deploy/github-actions';
import { githubFetcher } from '../deploy/github-fetcher';
import { createRunsPoller, fetchJobLog } from '../deploy/runs-poller';
import { projectStore } from '../project-store';
import { safeSendToRenderer } from './utils';

export function registerDeployHandlers(getMainWindow: () => BrowserWindow | null): void {
  const client = createActionsClient(githubFetcher);
  const poller = createRunsPoller({
    client,
    resolveRepo,
    emit: (state) => safeSendToRenderer(getMainWindow, IPC_CHANNELS.DEPLOY_RUNS_UPDATE, state),
  });

  ipcMain.handle(
    IPC_CHANNELS.DEPLOY_RUNS_START,
    async (_event, projectId: string, selectedRunId?: number): Promise<IPCResult> => {
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };
      poller.start(project, selectedRunId);
      return { success: true };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.DEPLOY_RUNS_SELECT,
    async (_event, _projectId: string, runId: number): Promise<IPCResult> => {
      poller.select(runId);
      return { success: true };
    }
  );

  ipcMain.handle(IPC_CHANNELS.DEPLOY_RUNS_STOP, async (_event, projectId: string): Promise<IPCResult> => {
    poller.stop(projectId);
    return { success: true };
  });

  ipcMain.handle(
    IPC_CHANNELS.DEPLOY_JOB_LOG,
    async (_event, projectId: string, jobId: number): Promise<IPCResult<DeployJobLog>> => {
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };
      const repo = await resolveRepo(project).catch(() => null);
      if (!repo) return { success: false, error: 'No GitHub repository' };
      return { success: true, data: await fetchJobLog(client, repo, jobId) };
    }
  );
}
