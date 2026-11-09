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
import type { IPCResult, PreviewBounds, PreviewNavigation, PreviewService, PreviewNote, PreviewStatus, UxReviewResult } from '../../shared/types';
import { getToolPath } from '../cli-tool-manager';
import { proposePreviewServices } from '../preview/detect-services';
import { currentPreview, startPreview, stopPreview } from '../preview/preview-session';
import { readLastUxReview, runUxReview } from '../preview/ux-review';
import { readNotesDraft, writeNotesDraft } from '../preview/notes-draft';
import { previewWorktreePath } from '../preview/preview-worktree';
import { runClaudeTask } from '../ai/claude-code/task';
import { getFeatureSettings } from './feature-settings-helper';
import { PreviewView } from '../preview/preview-view';
import { projectStore } from '../project-store';
import { findTaskWorktree } from '../worktree-paths';

/** The previews' worktrees: in the app's folder, outside every project */
export const previewWorktreesRoot = () => path.join(homedir(), '.vibe-teamlead', 'worktrees', 'preview');

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function registerPreviewHandlers(getMainWindow: () => BrowserWindow | null, view = new PreviewView(getMainWindow)): void {
  const send = (status: PreviewStatus) => {
    const window = getMainWindow();
    if (window && !window.isDestroyed()) window.webContents.send(IPC_CHANNELS.PREVIEW_STATUS, status);
  };
  // One UX review at a time, on the running preview; it ends when the preview stops
  let uxReview: AbortController | null = null;
  const onStatus = (status: PreviewStatus) => {
    if (status.stage !== 'ready') uxReview?.abort();
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

  const start = async (projectId: string, resetData: boolean, taskId?: unknown): Promise<IPCResult<PreviewStatus>> => {
    const project = projectStore.getProject(projectId);
    if (!project) return { success: false, error: 'Project not found' };
    // A task's preview runs its worktree
    let task: { taskId: string; worktree: string } | undefined;
    if (typeof taskId === 'string' && taskId) {
      const found = projectStore.getTasks(projectId).find((t) => t.id === taskId);
      const worktree = found ? findTaskWorktree(project.path, found.specId) : null;
      if (!found || !worktree) return { success: false, error: "This task has no worktree to preview." };
      task = { taskId, worktree };
    }
    watchReloads();
    view.setWorktree(task?.worktree ?? previewWorktreePath(previewWorktreesRoot(), projectId));
    try {
      const status = await startPreview(project, onStatus, { git: getToolPath('git'), secretsDir: path.join(app.getPath('userData'), 'preview'), worktreesRoot: previewWorktreesRoot() }, { resetData, task });
      return { success: true, data: status };
    } catch (error) {
      view.destroy();
      return { success: false, error: errorMessage(error) };
    }
  };

  ipcMain.handle(IPC_CHANNELS.PREVIEW_START, (_e, projectId: string, taskId?: unknown) => start(projectId, false, taskId));
  ipcMain.handle(IPC_CHANNELS.PREVIEW_RESET_DATA, (_e, projectId: string, taskId?: unknown) => start(projectId, true, taskId));

  ipcMain.handle(IPC_CHANNELS.PREVIEW_UX_REVIEW, async (_e, projectId: string): Promise<IPCResult<UxReviewResult>> => {
    const status = currentPreview();
    if (!status || status.projectId !== projectId || status.stage !== 'ready' || !status.url) {
      return { success: false, error: 'The preview is not running. Open it and wait until the page shows.' };
    }
    if (status.taskId) return { success: false, error: "The UX review looks at the project's main branch; this is a task's preview." };
    if (uxReview) return { success: false, error: 'A UX review is already running.' };
    const controller = new AbortController();
    uxReview = controller;
    try {
      const review = await runUxReview({
        projectId,
        url: status.url,
        worktree: previewWorktreePath(previewWorktreesRoot(), projectId),
        dataDir: app.getPath('userData'),
        runTask: (options) => runClaudeTask(options as unknown as Parameters<typeof runClaudeTask>[0]),
        model: getFeatureSettings('uxReview'),
        signal: controller.signal,
      });
      return { success: true, data: review };
    } catch (error) {
      return { success: false, error: controller.signal.aborted ? 'The UX review was stopped.' : errorMessage(error) };
    } finally {
      if (uxReview === controller) uxReview = null;
    }
  });

  // Notes: the page's overlay asks for its script and reports picks; the renderer drives the mode and pins
  let overlaySource: string | null = null;
  ipcMain.on('preview:overlay-source', (event) => {
    if (!view.isOwnPage(event.sender.id)) {
      event.returnValue = '';
      return;
    }
    if (overlaySource === null) {
      try {
        overlaySource = readFileSync(path.join(app.getAppPath(), 'out', 'preview', 'overlay.js'), 'utf-8');
      } catch {
        overlaySource = '';
      }
    }
    event.returnValue = overlaySource;
  });
  ipcMain.on('preview:overlay-event', (event, data: unknown) => void view.handleOverlayMessage(event.sender.id, data));
  view.onOverlayEvent((overlayEvent) => {
    const window = getMainWindow();
    if (!window || window.isDestroyed()) return;
    window.webContents.send(IPC_CHANNELS.PREVIEW_OVERLAY_EVENT, overlayEvent);
    // The note's text is typed in the app's own panel
    if (overlayEvent.type === 'picked') window.webContents.focus();
  });
  ipcMain.handle(IPC_CHANNELS.PREVIEW_NOTES_MODE, (_e, on: unknown): IPCResult => {
    view.setNotesMode(on === true);
    return { success: true };
  });
  ipcMain.handle(IPC_CHANNELS.PREVIEW_PINS, (_e, pins: unknown): IPCResult => {
    const clean = (Array.isArray(pins) ? pins : [])
      .filter((p): p is { n: number; selector: string } => typeof p?.n === 'number' && typeof p?.selector === 'string')
      .slice(0, 200)
      .map((p) => ({ n: p.n, selector: p.selector.slice(0, 500) }));
    view.setPins(clean);
    return { success: true };
  });
  ipcMain.handle(IPC_CHANNELS.PREVIEW_FOCUS_PIN, (_e, n: unknown): IPCResult => {
    if (typeof n === 'number') view.focusPin(n);
    return { success: true };
  });
  const draftTask = (taskId: unknown) => (typeof taskId === 'string' && taskId ? taskId : undefined);
  ipcMain.handle(IPC_CHANNELS.PREVIEW_NOTES_LOAD, (_e, projectId: string, taskId?: unknown): IPCResult<PreviewNote[]> => {
    const project = projectStore.getProject(projectId);
    return project ? { success: true, data: readNotesDraft(project.path, draftTask(taskId)) } : { success: false, error: 'Project not found' };
  });
  ipcMain.handle(IPC_CHANNELS.PREVIEW_NOTES_SAVE, (_e, projectId: string, notes: unknown, taskId?: unknown): IPCResult<PreviewNote[]> => {
    const project = projectStore.getProject(projectId);
    if (!project) return { success: false, error: 'Project not found' };
    try {
      return { success: true, data: writeNotesDraft(project.path, notes, draftTask(taskId)) };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.PREVIEW_UX_REVIEW_CANCEL, (): IPCResult => {
    uxReview?.abort();
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.PREVIEW_UX_REVIEW_LAST, (_e, projectId: string): IPCResult<UxReviewResult | null> => ({
    success: true,
    data: readLastUxReview(app.getPath('userData'), projectId),
  }));

  ipcMain.handle(IPC_CHANNELS.PREVIEW_STOP, async (): Promise<IPCResult> => {
    uxReview?.abort();
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
