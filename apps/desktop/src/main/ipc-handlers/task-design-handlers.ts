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
import { readDesignCanvas, readDesignState, writeDesignState } from '../ai/design/design-step';
import { DESIGN_SCHEME, designAsset, libraryAsset, parseDesignUrl, parseLibraryUrl } from '../design/design-protocol';
import { readLibrary } from '../ai/design/design-library';
import { projectStore } from '../project-store';
import { approvedState, commentedState, parseCompare } from '../design/task-design';
import { startTask } from './task/execution-handlers';
import { findTaskAndProject } from './task/shared';
import { resolveSpecDir } from './task/workspace-handlers';

const SHOT_SETTLE_MS = 600;

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
  return {
    frames: readDesignCanvas(specDir).frames,
    stage: state?.stage ?? null,
    round: state?.round ?? 0,
    approved: state?.approved ?? {},
    waiting: waitingHere && state && state.stage !== 'skipped' ? state.stage : null,
    ...(state?.checkFindings !== undefined ? { checkFindings: state.checkFindings } : {}),
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
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'design-shots' },
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
  } catch {
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
  if (last && stage === 'design') await renderShots(taskId, specDir).catch(() => undefined);
  await startTask(agentManager, getMainWindow, taskId);
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

/** vt-design:// in the main session (sandboxed iframes on the Design tab, offscreen shots) */
export function registerDesignProtocol(): void {
  protocol.handle(DESIGN_SCHEME, (request) => {
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
  });
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

  ipcMain.handle(IPC_CHANNELS.TASK_DESIGN_COMMENT, (_e, taskId: string, comments: TaskDesignComment[]): Promise<IPCResult> =>
    commentTaskDesign(agentManager, getMainWindow, taskId, comments),
  );
}
