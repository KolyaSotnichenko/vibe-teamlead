/**
 * Preview IPC: start and stop the project's preview, keep its view over the box
 * the renderer reserves, and propose the services to run. The renderer starts it
 * when the Preview page opens and stops it when the page goes away.
 */

import { execFileSync } from 'node:child_process';
import { cleanUpBrowserOrphansSoon } from '../utils/browser-mcp-orphans';
import { bundledBrowserServers } from '../ai/claude-code/bundled-tools';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { app, type BrowserWindow, ipcMain } from 'electron';

import { IPC_CHANNELS } from '../../shared/constants';
import type { SaidText } from '../../shared/constants/preview-say';
import type { IPCResult, PreviewBounds, PreviewEnvReport, PreviewRecipe, PreviewRecipeInfo, Project, PreviewNavigation, PreviewService, PreviewMailMessage, PreviewMailSummary, PreviewNote, PreviewRunningDoc, PreviewStatus, UxReviewResult } from '../../shared/types';
import { getToolPath } from '../cli-tool-manager';
import { proposePreviewServices } from '../preview/detect-services';
import { addPreviewNotice, currentPreview, previewLogs, previewMailPort, restartPreviewServices, runningPreviewEnv, startPreview, stopPreview } from '../preview/preview-session';
import { commitRecipeToMain, mainRecipeText } from '../preview/recipe-commit';
import { createPendingRecipeSettler } from '../preview/settle-pending-recipe';
import { inMergeQueue, onMergeSettled } from '../ai/merge/merge-queue';
import { getIsolatedGitEnv } from '../utils/git-isolation';
import { saidFor, say } from '../say';
import { plannedEnv } from '../preview/preview-env';
import { parseRecipe, recipeFileText, recipeHash, resolveRecipe } from '../preview/recipe';
import { isPathContained } from '../ai/security/path-containment';
import { type DockerRun, hostDocker } from '../ai/verification/test-services';
import { getMail, listMail } from '../preview/preview-mail';
import { readLastUxReview, runUxReview } from '../preview/ux-review';
import { readNotesDraft, writeNotesDraft } from '../preview/notes-draft';
import { previewWorktreePath } from '../preview/preview-worktree';
import { readRunningMd } from '../preview/running-md';
import { runClaudeTask } from '../ai/claude-code/task';
import { getFeatureSettings } from './feature-settings-helper';
import { PreviewView } from '../preview/preview-view';
import { projectStore } from '../project-store';
import { findTaskWorktree } from '../worktree-paths';

/** The previews' worktrees: in the app's folder, outside every project */
/** How long saving a recipe's services waits for the commit into main before answering "not in the repository yet" */
const SAVE_WAIT_MS = 5000;

export const previewWorktreesRoot = () => path.join(homedir(), '.vibe-teamlead', 'worktrees', 'preview');

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** How much of each service's log the Logs panel gets */
const LOG_TAIL_BYTES = 64 * 1024;

/** The end of a file, from a line start; empty when it can't be read */
export async function readTail(file: string, bytes: number): Promise<string> {
  try {
    const handle = await open(file, 'r');
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - bytes);
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      const text = buffer.toString('utf-8');
      return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
    } finally {
      await handle.close();
    }
  } catch {
    return '';
  }
}

/** `.env` and its variants are never read; `.env.example` is */
const SECRET_ENV_FILE = /(^|\/)\.env(\.(?!example$)[^/]*)?$/;

/** A worktree's tracked files, with `/`; what is there when git can't say (the root and the services' example settings) */
export function previewFiles(dir: string, serviceDirs: string[], git = getToolPath('git')): string[] {
  try {
    return execFileSync(git, ['ls-files', '-z'], { cwd: dir, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\0')
      .filter(Boolean);
  } catch {
    let root: string[] = [];
    try {
      root = readdirSync(dir);
    } catch {
      // no folder yet
    }
    const examples = serviceDirs.filter(Boolean).map((d) => `${d}/.env.example`).filter((file) => existsSync(path.join(dir, file)));
    return [...root, ...examples];
  }
}

/** A file of the folder a preview runs from; `.env` and its variants are never read */
const safeRead = (dir: string) => (file: string): string | null => {
  if (SECRET_ENV_FILE.test(file)) return null;
  try {
    return readFileSync(path.join(dir, file), 'utf-8');
  } catch {
    return null;
  }
};

/**
 * What a start would run from this folder, and where that came from: the project's
 * preview.json, the saved services, or the proposal (preview/recipe.ts). For the Services form.
 */
export function previewRecipeInfo(project: Project, dir: string, git?: string): PreviewRecipeInfo {
  const saved = project.settings.previewServices ?? [];
  const resolved = resolveRecipe({
    files: previewFiles(dir, saved.map((s) => s.dir), git),
    read: safeRead(dir),
    saved,
    pending: project.settings.previewPendingRecipe,
    // As a start does: a folder that is a link out of the project makes the file unusable
    contained: (folder) => isPathContained(path.resolve(dir, folder), dir).contained,
  });
  return { source: resolved.source, servicesFrom: resolved.servicesFrom, services: resolved.recipe.services ?? [], ...(resolved.invalid ? { invalid: resolved.invalid } : {}) };
}

/**
 * What each service of a preview gets: what the running services got, or what they will get
 * at the next start, worked out from the worktree's files the way the preview does it.
 */
export async function previewEnvReport(project: Project, dir: string, taskId?: string, git?: string, docker: DockerRun = hostDocker(process.env)): Promise<PreviewEnvReport> {
  const running = runningPreviewEnv(project, taskId);
  if (running) return running;
  const files = previewFiles(dir, (project.settings.previewServices ?? []).map((s) => s.dir), git);
  const planned = plannedEnv(project.settings, files, safeRead(dir));
  // Only asked when the preview would need it: the test database, the other compose services and the mail catcher run in Docker
  const needsDocker = planned.databases.length > 0 || planned.composeServices.length > 0 || planned.mail;
  const dockerUnavailable = needsDocker ? !(await docker(['info']).catch(() => ({ ok: false }))).ok : false;
  return { running: false, restartNeeded: false, dockerUnavailable, ...planned };
}

export function registerPreviewHandlers(getMainWindow: () => BrowserWindow | null, view = new PreviewView(getMainWindow)): void {
  const send = (status: PreviewStatus) => {
    const window = getMainWindow();
    if (window && !window.isDestroyed()) window.webContents.send(IPC_CHANNELS.PREVIEW_STATUS, status);
  };
  // A recipe made in the app that is not in main yet: settled at each start of the project's preview and after each merge
  const mainBranchOf = (project: Project) => project.settings.mainBranch ?? 'main';
  const settler = createPendingRecipeSettler({
    getProject: (id) => projectStore.getProject(id),
    updateSettings: (id, settings) => {
      projectStore.updateProjectSettings(id, settings);
    },
    mainText: (project) => mainRecipeText(project.path, mainBranchOf(project), { git: getToolPath('git'), env: getIsolatedGitEnv() }),
    commit: (project, text) =>
      inMergeQueue(project.path, 'preview-recipe', () => commitRecipeToMain({ projectDir: project.path, mainBranch: mainBranchOf(project), text, git: getToolPath('git'), env: getIsolatedGitEnv() })),
  });
  /** An owner's edit that lost to a newer recipe in main is said once, over that project's running preview */
  const sayDropped = (projectId: string) => {
    const running = currentPreview();
    if (running?.projectId !== projectId || running.taskId || running.stage === 'stopped') return;
    if (settler.takeDropped(projectId)) addPreviewNotice(projectId, say('editDropped', 'Your change to the services was not kept: the recipe changed in the project since.'));
  };
  /** Never in the way of a start: the commit may wait in the merge queue behind a task */
  const settleSoon = (projectId: string) => {
    void settler.settle(projectId).then(() => sayDropped(projectId), () => {});
  };
  onMergeSettled((dir) => {
    const merged = projectStore.getProjects().find((project) => path.resolve(project.path) === path.resolve(dir));
    if (merged?.settings.previewPendingRecipe) settleSoon(merged.id);
  });

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
      if (!task) settleSoon(projectId);
      const status = await startPreview(project, onStatus, { git: getToolPath('git'), secretsDir: path.join(app.getPath('userData'), 'preview'), worktreesRoot: previewWorktreesRoot() }, { resetData, task });
      if (!task) sayDropped(projectId);
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
  ipcMain.handle(IPC_CHANNELS.PREVIEW_LOGS, async (_e, projectId: string): Promise<IPCResult<Array<{ service: string; text: string }>>> => ({
    success: true,
    data: await Promise.all(previewLogs(projectId).map(async ({ service, path: file }) => ({ service, text: await readTail(file, LOG_TAIL_BYTES) }))),
  }));
  const fetchJson = async (url: string) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`The mail catcher answered ${response.status}`);
    return response.json() as Promise<unknown>;
  };
  ipcMain.handle(IPC_CHANNELS.PREVIEW_MAIL_LIST, async (_e, projectId: string): Promise<IPCResult<PreviewMailSummary[]>> => {
    const port = previewMailPort(projectId);
    if (!port) return { success: true, data: [] };
    try {
      return { success: true, data: await listMail(port, fetchJson) };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  });
  ipcMain.handle(IPC_CHANNELS.PREVIEW_MAIL_GET, async (_e, projectId: string, id: unknown): Promise<IPCResult<PreviewMailMessage | null>> => {
    const port = previewMailPort(projectId);
    if (!port || typeof id !== 'string') return { success: true, data: null };
    try {
      return { success: true, data: await getMail(port, id, fetchJson) };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
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

  // The Environment panel: the task's worktree for a task's preview; main's preview worktree, or the project before its first start
  const previewDir = (project: Project, taskId?: unknown): string => {
    if (typeof taskId === 'string' && taskId) {
      const found = projectStore.getTasks(project.id).find((t) => t.id === taskId);
      const worktree = found ? findTaskWorktree(project.path, found.specId) : null;
      if (worktree) return worktree;
    }
    const preview = previewWorktreePath(previewWorktreesRoot(), project.id);
    return existsSync(preview) ? preview : project.path;
  };
  ipcMain.handle(IPC_CHANNELS.PREVIEW_ENV, async (_e, projectId: string, taskId?: unknown): Promise<IPCResult<PreviewEnvReport>> => {
    const project = projectStore.getProject(projectId);
    if (!project) return { success: false, error: 'Project not found' };
    try {
      return { success: true, data: await previewEnvReport(project, previewDir(project, taskId), draftTask(taskId)) };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  });
  /** What a start would run, and, when that is a recipe not in main yet, whose it is and why it is still waiting */
  const recipeInfo = (project: Project, taskId?: unknown): PreviewRecipeInfo => {
    const info = previewRecipeInfo(project, previewDir(project, taskId));
    const pending = project.settings.previewPendingRecipe;
    if (info.source !== 'pending' || !pending) return info;
    const refusal = settler.refusal(project.id);
    return { ...info, pending: { origin: pending.origin, ...(refusal ? { refusal } : {}) } };
  };
  ipcMain.handle(IPC_CHANNELS.PREVIEW_RECIPE, (_e, projectId: string, taskId?: unknown): IPCResult<PreviewRecipeInfo> => {
    const project = projectStore.getProject(projectId);
    if (!project) return { success: false, error: 'Project not found' };
    try {
      return { success: true, data: recipeInfo(project, taskId) };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  });
  // The owner changed the services of the project's recipe: used at once, and written into main by the app
  ipcMain.handle(IPC_CHANNELS.PREVIEW_SAVE_RECIPE_SERVICES, async (_e, projectId: string, services: unknown): Promise<IPCResult<PreviewRecipeInfo> & { errorSaid?: SaidText }> => {
    const project = projectStore.getProject(projectId);
    if (!project) return { success: false, error: 'Project not found' };
    const refuse = (error: string) => ({ success: false as const, error, errorSaid: saidFor([error])[0] });
    try {
      const mainText = await mainRecipeText(project.path, mainBranchOf(project), { git: getToolPath('git'), env: getIsolatedGitEnv() });
      // The recipe in use for main: one made in the app while main's file is still the one it was made against, else main's file
      const pending = project.settings.previewPendingRecipe;
      const fromFile = mainText === null ? undefined : parseRecipe(mainText);
      const base: PreviewRecipe | undefined = pending && recipeHash(mainText) === pending.base ? pending.recipe : fromFile?.ok ? fromFile.recipe : undefined;
      if (!base) return refuse(say('noRecipeToChange', 'This project has no recipe (preview.json) to change.'));
      // Checked as the file would be: what comes from the interface is not trusted either
      const checked = parseRecipe(JSON.stringify({ ...base, services }));
      if (!checked.ok) return refuse(checked.reason);
      projectStore.updateProjectSettings(projectId, { previewPendingRecipe: { recipe: checked.recipe, base: recipeHash(mainText), origin: 'owner', at: new Date().toISOString() } });
      // Usually a moment; behind a task's merge it goes on in the background, and the form says it is not in the repository yet
      await Promise.race([settler.settle(projectId), new Promise((resolve) => setTimeout(resolve, SAVE_WAIT_MS))]);
      const saved = projectStore.getProject(projectId) ?? project;
      return { success: true, data: recipeInfo(saved) };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  });
  // Apply and restart: the running services restart with the saved values; a preview that isn't running starts
  ipcMain.handle(IPC_CHANNELS.PREVIEW_RESTART_SERVICES, async (_e, projectId: string, taskId?: unknown): Promise<IPCResult<PreviewStatus>> => {
    const project = projectStore.getProject(projectId);
    if (!project) return { success: false, error: 'Project not found' };
    const restarted = await restartPreviewServices(project, draftTask(taskId));
    return restarted ? { success: true, data: restarted } : start(projectId, false, taskId);
  });

  // How to run the project, for when the preview can't: the task's worktree for a task's preview
  ipcMain.handle(IPC_CHANNELS.PREVIEW_RUNNING_DOC, (_e, projectId: string, taskId?: unknown): IPCResult<PreviewRunningDoc> => {
    const project = projectStore.getProject(projectId);
    if (!project) return { success: false, error: 'Project not found' };
    let dir = project.path;
    if (typeof taskId === 'string' && taskId) {
      const found = projectStore.getTasks(projectId).find((t) => t.id === taskId);
      const worktree = found ? findTaskWorktree(project.path, found.specId) : null;
      if (worktree) dir = worktree;
    }
    return { success: true, data: { ...readRunningMd(dir), dir } };
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
    // A UX review stopped mid-way can leave its Playwright behind
    if (uxReview) cleanUpBrowserOrphansSoon(bundledBrowserServers);
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

  // What the files of the folder a preview runs from propose: the task's for a task's preview
  ipcMain.handle(IPC_CHANNELS.PREVIEW_PROPOSE_SERVICES, (_e, projectId: string, taskId?: unknown): IPCResult<PreviewService[]> => {
    const project = projectStore.getProject(projectId);
    if (!project) return { success: false, error: 'Project not found' };
    try {
      const dir = previewDir(project, taskId);
      return { success: true, data: proposePreviewServices({ files: previewFiles(dir, []), read: safeRead(dir) }) };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  });

}
