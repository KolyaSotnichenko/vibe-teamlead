/**
 * Design system IPC: read and save the project's design system, run the design
 * agent (extract from code, propose directions, write the chosen one), and run
 * the project's Storybook for the in-app component view.
 */

import { type BrowserWindow, ipcMain } from 'electron';

import { IPC_CHANNELS } from '../../shared/constants';
import type { DesignBrief, DesignDirection, DesignSystemInfo, DesignTokens, IPCResult, TaskStorybookStatus } from '../../shared/types';
import { extractDesignSystem, proposeDirections, writeDesignSystem } from '../ai/design/design-agent';
import { loadDesignSystem, saveDesignSystem } from '../ai/design/design-system';
import {
  installDependencies,
  isInstalling,
  needsInstall,
  packageManagerOf,
  runningStorybook,
  startStorybook,
  stopStorybook,
  touchesStorybook,
} from '../design/storybook-service';
import { changedFiles, resolveBaseRef } from '../ai/security/gates';
import { detectStorybook } from '../ai/design/design-system';
import { findTaskWorktree } from '../worktree-paths';
import { findTaskAndProject } from './task/shared';
import { projectStore } from '../project-store';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The project's design system, with the Storybook server state. */
export function designInfo(projectId: string): DesignSystemInfo | null {
  const project = projectStore.getProject(projectId);
  if (!project) return null;
  const info = loadDesignSystem(project.path, project.settings);
  const url = runningStorybook(project.path, info.storybook.dir);
  return url ? { ...info, storybook: { ...info.storybook, running: { url } } } : info;
}

/** The task's worktree and the Storybook in it. */
function taskWorktree(taskId: string, projectId: string): { worktree: string | null } {
  const { task, project } = findTaskAndProject(taskId, projectId);
  if (!task || !project) throw new Error('Task not found');
  return { worktree: findTaskWorktree(project.path, task.specId) };
}

export async function taskStorybookStatus(taskId: string, projectId: string): Promise<TaskStorybookStatus> {
  const { worktree } = taskWorktree(taskId, projectId);
  if (!worktree) return { worktree: false, detected: false, needsInstall: false, installing: false };
  const sb = detectStorybook(worktree, true);
  const url = runningStorybook(worktree, sb.dir);
  // Only a task that changes the UI Storybook shows gets the tab (not an API-only task)
  const touchesUi = sb.detected && sb.dir !== undefined
    ? touchesStorybook(await changedFiles(worktree, await resolveBaseRef(worktree)), sb.dir)
    : false;
  return {
    worktree: true,
    detected: sb.detected && (touchesUi || url !== undefined),
    packageManager: packageManagerOf(worktree),
    dir: sb.dir,
    script: sb.script,
    needsInstall: sb.detected && sb.dir !== undefined ? needsInstall(worktree, sb.dir) : false,
    installing: isInstalling(worktree),
    running: url ? { url } : undefined,
  };
}

export function registerDesignHandlers(getMainWindow: () => BrowserWindow | null): void {
  const running = new Map<string, AbortController>();

  const withProject = <T>(projectId: string, run: (path: string, settings: Parameters<typeof loadDesignSystem>[1]) => Promise<T>) => {
    const project = projectStore.getProject(projectId);
    if (!project) return Promise.resolve<IPCResult<T>>({ success: false, error: 'Project not found' });
    return run(project.path, project.settings).then(
      (data) => ({ success: true as const, data }),
      (error) => ({ success: false as const, error: errorMessage(error) }),
    );
  };

  /** Run one design-agent job per project; a new one cancels the old. */
  const agentJob = async <T>(projectId: string, job: (signal: AbortSignal, onProgress: (m: string) => void) => Promise<T>): Promise<T> => {
    running.get(projectId)?.abort();
    const controller = new AbortController();
    running.set(projectId, controller);
    try {
      return await job(controller.signal, (message) =>
        getMainWindow()?.webContents.send(IPC_CHANNELS.DESIGN_PROGRESS, { projectId, message }),
      );
    } catch (error) {
      if (controller.signal.aborted) throw new Error('Cancelled');
      throw error;
    } finally {
      if (running.get(projectId) === controller) running.delete(projectId);
    }
  };

  ipcMain.handle(IPC_CHANNELS.DESIGN_GET, async (_e, projectId: string): Promise<IPCResult<DesignSystemInfo>> => {
    try {
      const info = designInfo(projectId);
      return info ? { success: true, data: info } : { success: false, error: 'Project not found' };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.DESIGN_SAVE,
    (_e, projectId: string, content: { markdown?: string; tokens?: DesignTokens }): Promise<IPCResult<DesignSystemInfo>> =>
      withProject(projectId, async (path, settings) => {
        if (typeof content?.markdown !== 'string' && !content?.tokens) throw new Error('Nothing to save');
        saveDesignSystem(path, settings, {
          markdown: typeof content.markdown === 'string' ? content.markdown : undefined,
          tokens: content.tokens,
        });
        return designInfo(projectId) as DesignSystemInfo;
      }),
  );

  ipcMain.handle(
    IPC_CHANNELS.DESIGN_EXTRACT,
    (_e, projectId: string): Promise<IPCResult<DesignSystemInfo>> =>
      withProject(projectId, async (path, settings) => {
        const result = await agentJob(projectId, (signal, onProgress) => extractDesignSystem({ projectPath: path, signal, onProgress }));
        saveDesignSystem(path, settings, result);
        return designInfo(projectId) as DesignSystemInfo;
      }),
  );

  ipcMain.handle(
    IPC_CHANNELS.DESIGN_PROPOSE,
    (_e, projectId: string, brief: DesignBrief): Promise<IPCResult<DesignDirection[]>> =>
      withProject(projectId, (path) =>
        agentJob(projectId, (signal, onProgress) => proposeDirections({ projectPath: path, brief, signal, onProgress })),
      ),
  );

  ipcMain.handle(
    IPC_CHANNELS.DESIGN_WRITE,
    (_e, projectId: string, brief: DesignBrief, direction: DesignDirection): Promise<IPCResult<DesignSystemInfo>> =>
      withProject(projectId, async (path, settings) => {
        const result = await agentJob(projectId, (signal, onProgress) =>
          writeDesignSystem({ projectPath: path, brief, direction, signal, onProgress }),
        );
        saveDesignSystem(path, settings, result);
        return designInfo(projectId) as DesignSystemInfo;
      }),
  );

  ipcMain.handle(IPC_CHANNELS.DESIGN_CANCEL, async (_e, projectId: string): Promise<IPCResult> => {
    running.get(projectId)?.abort();
    running.delete(projectId);
    return { success: true };
  });

  ipcMain.handle(
    IPC_CHANNELS.STORYBOOK_START,
    (_e, projectId: string): Promise<IPCResult<{ url: string }>> =>
      withProject(projectId, async (path, settings) => {
        const info = loadDesignSystem(path, settings);
        if (!info.storybook.detected || !info.storybook.dir) {
          throw new Error('Storybook is not set up in this project yet. Turn it on in the design system settings; the agents add it with the next UI task.');
        }
        return { url: await startStorybook(path, info.storybook.dir, info.storybook.script) };
      }),
  );

  ipcMain.handle(
    IPC_CHANNELS.STORYBOOK_STOP,
    (_e, projectId: string): Promise<IPCResult> =>
      withProject(projectId, async (path, settings) => {
        const info = loadDesignSystem(path, settings);
        if (info.storybook.dir) stopStorybook(path, info.storybook.dir);
        return undefined;
      }),
  );

  ipcMain.handle(IPC_CHANNELS.STORYBOOK_TASK_STATUS, async (_e, taskId: string, projectId: string): Promise<IPCResult<TaskStorybookStatus>> => {
    try {
      return { success: true, data: await taskStorybookStatus(taskId, projectId) };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.STORYBOOK_TASK_START, async (_e, taskId: string, projectId: string): Promise<IPCResult<{ url: string }>> => {
    try {
      const { worktree } = taskWorktree(taskId, projectId);
      if (!worktree) throw new Error("This task has no worktree (it was merged or discarded). Use the project's Storybook in Context → Design system.");
      const sb = detectStorybook(worktree, true);
      if (!sb.detected || !sb.dir) throw new Error("There is no Storybook in this task's worktree yet.");
      const progress = (message: string) => getMainWindow()?.webContents.send(IPC_CHANNELS.DESIGN_PROGRESS, { projectId: `task:${taskId}`, message });
      // A worktree starts without node_modules: install once (they stay until the worktree is removed)
      if (needsInstall(worktree, sb.dir)) await installDependencies(worktree, progress);
      progress('Starting Storybook…');
      return { success: true, data: { url: await startStorybook(worktree, sb.dir, sb.script) } };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.STORYBOOK_TASK_STOP, async (_e, taskId: string, projectId: string): Promise<IPCResult> => {
    try {
      const { worktree } = taskWorktree(taskId, projectId);
      const sb = worktree ? detectStorybook(worktree, true) : undefined;
      if (worktree && sb?.dir) stopStorybook(worktree, sb.dir);
      return { success: true };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  });
}
