/**
 * Preview IPC: start and stop the project's preview, keep its view over the box
 * the renderer reserves, and propose the services to run. The renderer starts it
 * when the Preview page opens and stops it when the page goes away.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { app, type BrowserWindow, ipcMain } from 'electron';

import { IPC_CHANNELS } from '../../shared/constants';
import type { IPCResult, PreviewBounds, PreviewNavigation, PreviewService, PreviewStatus } from '../../shared/types';
import { getToolPath } from '../cli-tool-manager';
import { proposePreviewServices } from '../preview/detect-services';
import { startPreview, stopPreview } from '../preview/preview-session';
import { PreviewView } from '../preview/preview-view';
import { projectStore } from '../project-store';

/** The previews' worktrees: in the app's folder, outside every project */
export const previewWorktreesRoot = () => path.join(homedir(), '.vibe-teamlead', 'worktrees', 'preview');

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function registerPreviewHandlers(getMainWindow: () => BrowserWindow | null, view = new PreviewView(getMainWindow)): void {
  const send = (status: PreviewStatus) => {
    const window = getMainWindow();
    if (window && !window.isDestroyed()) window.webContents.send(IPC_CHANNELS.PREVIEW_STATUS, status);
  };
  const onStatus = (status: PreviewStatus) => {
    if (status.stage === 'ready' && status.url) view.show(status.projectId, status.url, status.origins);
    else if (status.stage === 'stopped' || status.stage === 'failed') view.destroy();
    else view.hide();
    send(status);
  };

  // A reload of the app's own page leaves nobody to stop the preview: stop it then.
  // Watched from the first start: the window may not exist yet when handlers register.
  const watched = new WeakSet<object>();
  const watchReloads = () => {
    const window = getMainWindow();
    if (!window || watched.has(window)) return;
    watched.add(window);
    window.webContents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) {
        view.destroy();
        void stopPreview();
      }
    });
  };

  const start = async (projectId: string, resetData: boolean): Promise<IPCResult<PreviewStatus>> => {
    const project = projectStore.getProject(projectId);
    if (!project) return { success: false, error: 'Project not found' };
    watchReloads();
    try {
      const status = await startPreview(project, onStatus, { git: getToolPath('git'), secretsDir: path.join(app.getPath('userData'), 'preview'), worktreesRoot: previewWorktreesRoot() }, { resetData });
      return { success: true, data: status };
    } catch (error) {
      view.destroy();
      return { success: false, error: errorMessage(error) };
    }
  };

  ipcMain.handle(IPC_CHANNELS.PREVIEW_START, (_e, projectId: string) => start(projectId, false));
  ipcMain.handle(IPC_CHANNELS.PREVIEW_RESET_DATA, (_e, projectId: string) => start(projectId, true));

  ipcMain.handle(IPC_CHANNELS.PREVIEW_STOP, async (): Promise<IPCResult> => {
    view.destroy();
    await stopPreview();
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.PREVIEW_SET_BOUNDS, (_e, bounds: PreviewBounds | null): IPCResult => {
    view.setBounds(bounds);
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.PREVIEW_NAVIGATE, (_e, navigation: PreviewNavigation): IPCResult => {
    view.navigate(navigation);
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.PREVIEW_PROPOSE_SERVICES, (_e, projectId: string): IPCResult<PreviewService[]> => {
    const project = projectStore.getProject(projectId);
    if (!project) return { success: false, error: 'Project not found' };
    try {
      const files = execFileSync(getToolPath('git'), ['ls-files', '-z'], { cwd: project.path, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 })
        .split('\0')
        .filter(Boolean);
      const read = (file: string) => {
        try {
          return readFileSync(path.join(project.path, file), 'utf-8');
        } catch {
          return null;
        }
      };
      return { success: true, data: proposePreviewServices({ files, read }) };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  });

}
