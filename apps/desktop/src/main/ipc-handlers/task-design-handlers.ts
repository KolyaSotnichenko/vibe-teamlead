/**
 * Design before code, the Design tab of a task: its frames (served by vt-design://), the owner's
 * approval and comments, and QA's comparison. Approving or commenting starts the task again; its
 * build goes on from the design step (ai/design/design-runner.ts).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { BrowserWindow, ipcMain, protocol } from 'electron';

import { IPC_CHANNELS } from '../../shared/constants';
import type { IPCResult, TaskDesign, TaskDesignComment } from '../../shared/types';
import { AgentManager } from '../agent';
import { readDesignCanvas, readDesignState, writeDesignState } from '../ai/design/design-step';
import { DESIGN_SCHEME, designAsset, parseDesignUrl } from '../design/design-protocol';
import { approvedState, commentedState, parseCompare } from '../design/task-design';
import { startTask } from './task/execution-handlers';
import { findTaskAndProject } from './task/shared';
import { resolveSpecDir } from './task/workspace-handlers';

const SHOT_SETTLE_MS = 600;

function taskDesign(taskId: string): TaskDesign | null {
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

/**
 * Pictures of the design's screens for QA to compare with (design/shots/<name>-<width>.png),
 * rendered offscreen from vt-design://. Best effort: QA reads the HTML without them.
 */
async function renderShots(taskId: string, specDir: string): Promise<void> {
  const frames = readDesignCanvas(specDir).frames.filter((f) => f.kind === 'screen');
  const shotsDir = path.join(specDir, 'design', 'shots');
  mkdirSync(shotsDir, { recursive: true });
  for (const frame of frames) {
    const win = new BrowserWindow({
      show: false,
      width: frame.width,
      height: frame.height,
      webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'design-shots' },
    });
    // The frame is agent-written: no new windows, no leaving vt-design://
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const stay = (event: { preventDefault(): void }, url: string) => {
      if (!url.startsWith(`${DESIGN_SCHEME}:`)) event.preventDefault();
    };
    win.webContents.on('will-navigate', stay);
    win.webContents.on('will-redirect', stay);
    try {
      await win.loadURL(`${DESIGN_SCHEME}://task/${encodeURIComponent(taskId)}/${frame.file.split('/').map(encodeURIComponent).join('/')}`);
      await new Promise((resolve) => setTimeout(resolve, SHOT_SETTLE_MS));
      const image = await win.webContents.capturePage();
      const name = path.basename(frame.file, '.html');
      writeFileSync(path.join(shotsDir, `${name}-${frame.width}.png`), image.toPNG());
    } catch {
      // this frame has no picture
    } finally {
      win.destroy();
    }
  }
}

/** vt-design:// in the main session (sandboxed iframes on the Design tab, offscreen shots) */
export function registerDesignProtocol(): void {
  protocol.handle(DESIGN_SCHEME, (request) => {
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

  ipcMain.handle(IPC_CHANNELS.TASK_DESIGN_APPROVE, async (_e, taskId: string, stage: unknown): Promise<IPCResult> => {
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
  });

  ipcMain.handle(IPC_CHANNELS.TASK_DESIGN_COMMENT, async (_e, taskId: string, comments: TaskDesignComment[]): Promise<IPCResult> => {
    const specDir = typeof taskId === 'string' ? resolveSpecDir(taskId) : null;
    if (!specDir) return { success: false, error: 'Task not found' };
    const frames = readDesignCanvas(specDir).frames.map((f) => f.file);
    const next = commentedState(readDesignState(specDir), comments, frames);
    if (!next) return { success: false, error: 'No comments to send.' };
    writeDesignState(specDir, next);
    await startTask(agentManager, getMainWindow, taskId);
    return { success: true };
  });
}
