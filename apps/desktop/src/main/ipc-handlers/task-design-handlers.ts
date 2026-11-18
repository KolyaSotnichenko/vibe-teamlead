/**
 * Design before code, the Design tab of a task: its frames (served by vt-design://), the owner's
 * approval and comments, and QA's comparison. Approving or commenting starts the task again; its
 * build goes on from the design step (ai/design/design-runner.ts).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { BrowserWindow, ipcMain, protocol } from 'electron';

import { IPC_CHANNELS } from '../../shared/constants';
import type { DesignLibrary, IPCResult, TaskDesign, TaskDesignComment, TaskDesignFrame } from '../../shared/types';
import { AgentManager } from '../agent';
import { appLog } from '../app-logger';
import { readDesignCanvas, readDesignState, writeDesignState } from '../ai/design/design-step';
import { DESIGN_SCHEME, designAsset, libraryAsset, parseDesignUrl, parseLibraryUrl } from '../design/design-protocol';
import { readLibrary } from '../ai/design/design-library';
import { projectStore } from '../project-store';
import { approvedState, commentedState, designSkipNote, ownerSkippedState, parseCompare } from '../design/task-design';
import { clearDesignFailure, readDesignFailure } from '../ai/design/design-runner';
import { startTask } from './task/execution-handlers';
import { findTaskAndProject } from './task/shared';
import { resolveSpecDir } from './task/workspace-handlers';

const SHOT_SETTLE_MS = 600;

/**
 * The offscreen window that takes a frame's picture. It runs in the main session, where
 * vt-design:// is served (the Design tab shows the same frames there, in sandboxed iframes):
 * on a partition of its own Electron doesn't serve the scheme, so every frame failed to load
 * and neither the Telegram album nor QA's design/shots ever got a picture.
 */
export const SHOT_WEB_PREFERENCES: Electron.WebPreferences = { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false };

export function taskDesign(taskId: string): TaskDesign | null {
  const { task, project } = findTaskAndProject(taskId);
  const specDir = resolveSpecDir(taskId);
  if (!task || !project || !specDir) return null;
  const state = readDesignState(specDir);
  let compare: TaskDesign['compare'] = null;
  try {
    compare = parseCompare(readFileSync(path.join(specDir, 'design_compare.json'), 'utf-8'));
  } catch {
    // QA hasn't compared yet
  }
  const waitingHere = task.status === 'human_review' && task.reviewReason === 'design_review';
  const failedHere = task.status === 'human_review' && task.reviewReason === 'design_failed';
  const failure = failedHere ? readDesignFailure(specDir) : undefined;
  let taskLogs: string | undefined;
  if (state?.stage === 'skipped' && !state.skipped) {
    try {
      taskLogs = readFileSync(path.join(specDir, 'task_logs.json'), 'utf-8');
    } catch {
      // no log
    }
  }
  return {
    frames: readDesignCanvas(specDir).frames,
    stage: state?.stage ?? null,
    round: state?.round ?? 0,
    approved: state?.approved ?? {},
    waiting: waitingHere && state && state.stage !== 'skipped' ? state.stage : null,
    ...(state?.checkFindings !== undefined ? { checkFindings: state.checkFindings } : {}),
    failure: failedHere ? { error: failure?.error ?? '', at: failure?.at ?? '' } : null,
    skipNote: designSkipNote(state, taskLogs),
    compare,
    settings: { mode: project.settings.designMode ?? 'full', approval: project.settings.designApproval ?? 'owner' },
  };
}

/** One frame rendered offscreen from vt-design:// (the frame is agent-written: no new windows, no leaving it) */
async function captureFrame(taskId: string, frame: TaskDesignFrame): Promise<Electron.NativeImage | null> {
  const win = new BrowserWindow({
    show: false,
    width: frame.width,
    height: frame.height,
    webPreferences: SHOT_WEB_PREFERENCES,
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const stay = (event: { preventDefault(): void }, url: string) => {
    if (!url.startsWith(`${DESIGN_SCHEME}:`)) event.preventDefault();
  };
  win.webContents.on('will-navigate', stay);
  win.webContents.on('will-redirect', stay);
  try {
    await win.loadURL(`${DESIGN_SCHEME}://task/${encodeURIComponent(taskId)}/${frame.file.split('/').map(encodeURIComponent).join('/')}`);
    await new Promise((resolve) => setTimeout(resolve, SHOT_SETTLE_MS));
    return await win.webContents.capturePage();
  } catch (error) {
    appLog.warn(`[design] could not take a picture of ${frame.file}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  } finally {
    win.destroy();
  }
}

/**
 * Pictures of the design's screens for QA to compare with (design/shots/<name>-<width>.png),
 * rendered offscreen from vt-design://. Best effort: QA reads the HTML without them.
 */
async function renderShots(taskId: string, specDir: string): Promise<void> {
  const frames = readDesignCanvas(specDir).frames.filter((f) => f.kind === 'screen');
  const shotsDir = path.join(specDir, 'design', 'shots');
  mkdirSync(shotsDir, { recursive: true });
  for (const frame of frames) {
    const image = await captureFrame(taskId, frame);
    // without a picture, this frame has none
    if (image) writeFileSync(path.join(shotsDir, `${path.basename(frame.file, '.html')}-${frame.width}.png`), image.toPNG());
  }
}

/**
 * Pictures of the frames that wait for the owner's approval (the Telegram bot's album): the
 * screens at the design stage, the wireframes before it. Best effort, at most `limit`.
 */
export async function captureWaitingFrames(taskId: string, limit: number): Promise<Array<{ title: string; image: Electron.NativeImage }>> {
  const design = taskDesign(taskId);
  if (!design?.waiting) return [];
  const kind = design.waiting === 'design' ? 'screen' : 'wireframe';
  const frames = design.frames.filter((f) => f.kind === kind);
  const out: Array<{ title: string; image: Electron.NativeImage }> = [];
  for (const frame of (frames.length ? frames : design.frames).slice(0, limit)) {
    const image = await captureFrame(taskId, frame);
    if (image && !image.isEmpty()) out.push({ title: frame.title, image });
  }
  return out;
}

/** The owner approves the stage that waits (the Design tab's Approve, and the Telegram bot's) */
export async function approveTaskDesign(agentManager: AgentManager, getMainWindow: () => BrowserWindow | null, taskId: string, stage: unknown): Promise<IPCResult> {
  if (stage !== 'wireframes' && stage !== 'design') return { success: false, error: 'Unknown stage' };
  const specDir = typeof taskId === 'string' ? resolveSpecDir(taskId) : null;
  if (!specDir) return { success: false, error: 'Task not found' };
  const next = approvedState(readDesignState(specDir), stage);
  if (!next) return { success: false, error: 'The task is not waiting for this approval.' };
  writeDesignState(specDir, next);
  // The approved design's pictures, for QA (the last stage before the plan)
  const { project } = findTaskAndProject(taskId);
  const last = stage === 'design' || project?.settings.designMode === 'wireframes';
  await startTask(agentManager, getMainWindow, taskId);
  // QA's pictures of the screens: one offscreen render per frame takes a while with many
  // screens, and QA needs them only much later, so the task doesn't wait for them
  if (last && stage === 'design') {
    void renderShots(taskId, specDir).catch((error) => appLog.warn(`[design] pictures for QA: ${error instanceof Error ? error.message : String(error)}`));
  }
  return { success: true };
}

/** The owner's comments go back to the designer (the Design tab, and the Telegram bot's Comment) */
export async function commentTaskDesign(agentManager: AgentManager, getMainWindow: () => BrowserWindow | null, taskId: string, comments: TaskDesignComment[]): Promise<IPCResult> {
  const specDir = typeof taskId === 'string' ? resolveSpecDir(taskId) : null;
  if (!specDir) return { success: false, error: 'Task not found' };
  const frames = readDesignCanvas(specDir).frames.map((f) => f.file);
  const next = commentedState(readDesignState(specDir), comments, frames);
  if (!next) return { success: false, error: 'No comments to send.' };
  writeDesignState(specDir, next);
  await startTask(agentManager, getMainWindow, taskId);
  return { success: true };
}

/** Whether the task waits because the designer could not draw (design_failed) */
function waitsAfterFailure(taskId: string): boolean {
  const { task } = findTaskAndProject(taskId);
  return task?.status === 'human_review' && task.reviewReason === 'design_failed';
}

/** The owner tries the design again: the build restarts the design step from its stage */
export async function retryTaskDesign(agentManager: AgentManager, getMainWindow: () => BrowserWindow | null, taskId: string): Promise<IPCResult> {
  const specDir = typeof taskId === 'string' ? resolveSpecDir(taskId) : null;
  if (!specDir) return { success: false, error: 'Task not found' };
  if (!waitsAfterFailure(taskId)) return { success: false, error: 'The task is not waiting for this decision.' };
  clearDesignFailure(specDir);
  await startTask(agentManager, getMainWindow, taskId);
  return { success: true };
}

/** The owner builds without a design: the only way a failed design becomes skipped */
export async function skipTaskDesign(agentManager: AgentManager, getMainWindow: () => BrowserWindow | null, taskId: string): Promise<IPCResult> {
  const specDir = typeof taskId === 'string' ? resolveSpecDir(taskId) : null;
  if (!specDir) return { success: false, error: 'Task not found' };
  if (!waitsAfterFailure(taskId)) return { success: false, error: 'The task is not waiting for this decision.' };
  writeDesignState(specDir, ownerSkippedState(readDesignState(specDir), readDesignFailure(specDir)?.error ?? ''));
  clearDesignFailure(specDir);
  appLog.info(`[design] ${taskId}: the owner chose to build without a design`);
  await startTask(agentManager, getMainWindow, taskId);
  return { success: true };
}

/**
 * The owner stops waiting for a designer that waits out a rate limit (the card's and the Design
 * tab's Stop waiting): the design stops for the owner now, as design_failed.
 */
export function stopDesignWait(agentManager: Pick<AgentManager, 'stopDesignWait'>, taskId: string): IPCResult {
  const { task } = typeof taskId === 'string' ? findTaskAndProject(taskId) : { task: undefined };
  if (task?.status !== 'in_progress') return { success: false, error: 'The task is not running.' };
  return agentManager.stopDesignWait(taskId) ? { success: true } : { success: false, error: 'The task is not running.' };
}

/** vt-design:// in the main session (sandboxed iframes on the Design tab, offscreen shots) */
export function registerDesignProtocol(): void {
  protocol.handle(DESIGN_SCHEME, serveDesign);
}

function serveDesign(request: Request): Response {
  const library = parseLibraryUrl(request.url);
  if (library) {
    const project = projectStore.getProject(library.projectId);
    const asset = project ? libraryAsset(project.path, library.file) : null;
    if (!asset) return new Response('Not found', { status: 404 });
    return new Response(asset.body as BodyInit, { headers: { 'Content-Type': asset.mime, ...asset.headers } });
  }
  const target = parseDesignUrl(request.url);
  const specDir = target ? resolveSpecDir(target.taskId) : null;
  const asset = target && specDir ? designAsset(specDir, target) : null;
  if (!asset) return new Response('Not found', { status: 404 });
  return new Response(asset.body as BodyInit, { headers: { 'Content-Type': asset.mime, ...asset.headers } });
}

export function registerTaskDesignHandlers(agentManager: AgentManager, getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle(IPC_CHANNELS.TASK_DESIGN_GET, (_e, taskId: string): IPCResult<TaskDesign> => {
    const design = typeof taskId === 'string' ? taskDesign(taskId) : null;
    return design ? { success: true, data: design } : { success: false, error: 'Task not found' };
  });

  ipcMain.handle(IPC_CHANNELS.DESIGN_LIBRARY_GET, (_e, projectId: string): IPCResult<DesignLibrary> => {
    const project = typeof projectId === 'string' ? projectStore.getProject(projectId) : undefined;
    if (!project) return { success: false, error: 'Project not found' };
    const tasks = projectStore.getTasks(projectId);
    const frames = readLibrary(project.path).frames.map((f) => ({ ...f, taskTitle: tasks.find((t) => t.id === f.taskId)?.title }));
    return { success: true, data: { frames } };
  });

  ipcMain.handle(IPC_CHANNELS.TASK_DESIGN_APPROVE, (_e, taskId: string, stage: unknown): Promise<IPCResult> =>
    approveTaskDesign(agentManager, getMainWindow, taskId, stage),
  );

  ipcMain.handle(IPC_CHANNELS.TASK_DESIGN_RETRY, (_e, taskId: string): Promise<IPCResult> => retryTaskDesign(agentManager, getMainWindow, taskId));

  ipcMain.handle(IPC_CHANNELS.TASK_DESIGN_SKIP, (_e, taskId: string): Promise<IPCResult> => skipTaskDesign(agentManager, getMainWindow, taskId));

  ipcMain.handle(IPC_CHANNELS.TASK_DESIGN_STOP_WAIT, (_e, taskId: string): IPCResult => stopDesignWait(agentManager, taskId));

  ipcMain.handle(IPC_CHANNELS.TASK_DESIGN_COMMENT, (_e, taskId: string, comments: TaskDesignComment[]): Promise<IPCResult> =>
    commentTaskDesign(agentManager, getMainWindow, taskId, comments),
  );
}
