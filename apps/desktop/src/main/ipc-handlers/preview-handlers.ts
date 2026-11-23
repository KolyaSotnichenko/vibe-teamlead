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
import { commitRecipeToMain, mainBranchExists, mainRecipeText } from '../preview/recipe-commit';
import { createPendingRecipeSettler } from '../preview/settle-pending-recipe';
import { inMergeQueue, onMergeSettled } from '../ai/merge/merge-queue';
import { getIsolatedGitEnv } from '../utils/git-isolation';
import { saidFor, say } from '../say';
import { plannedEnv } from '../preview/preview-env';
import { parseRecipe, RECIPE_FILE, recipeHash, resolveRecipe } from '../preview/recipe';
import { isPathContained } from '../ai/security/path-containment';
import { type DockerRun, hostDocker } from '../ai/verification/test-services';
import { getMail, listMail } from '../preview/preview-mail';
import { readLastUxReview, runUxReview } from '../preview/ux-review';
import { readNotesDraft, writeNotesDraft } from '../preview/notes-draft';
import { previewWorktreePath } from '../preview/preview-worktree';
import { readRunningMd } from '../preview/running-md';
import { runClaudeTask } from '../ai/claude-code/task';
import { getFeatureSettings } from './feature-settings-helper';
import { getClaudeCredentialStatus } from '../ai/claude-code/credential';
import { findOnPath, searchPath } from '../platform/exec';
import { fixFacts } from '../preview/fix-facts';
import { failureKey, openFixLedger } from '../preview/fix-ledger';
import { fixStart } from '../preview/fix-start';
import { createStartFixer } from '../preview/start-fixer';
import { readSettingsFile } from '../settings-utils';
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
export function previewRecipeInfo(project: Project, dir: string, git?: string, main?: { text: string | null }): PreviewRecipeInfo {
  const saved = project.settings.previewServices ?? [];
  const inFolder = previewFiles(dir, saved.map((s) => s.dir), git);
  const readFolder = safeRead(dir);
  // `main`: the recipe is the one main has, not the folder's (the owner's uncommitted edit, another branch, a copy not moved yet)
  const files = main ? [...inFolder.filter((file) => file !== RECIPE_FILE), ...(main.text === null ? [] : [RECIPE_FILE])] : inFolder;
  const resolved = resolveRecipe({
    files,
    read: (file) => (main && file === RECIPE_FILE ? main.text : readFolder(file)),
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
    // Its place in the queue is the project's own: another project's commit never stands for it
    commit: (project, text, base) =>
      inMergeQueue(project.path, `preview-recipe:${project.id}`, () =>
        commitRecipeToMain({ projectDir: project.path, mainBranch: mainBranchOf(project), text, expectedBase: base, git: getToolPath('git'), env: getIsolatedGitEnv() }),
      ),
    contained: (project, dir) => isPathContained(path.resolve(project.path, dir), project.path).contained,
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
  // The agent that fixes a failed start of a project's preview: every status passes through it on its way to the page
  const startDeps = () => ({ git: getToolPath('git'), secretsDir: path.join(app.getPath('userData'), 'preview'), worktreesRoot: previewWorktreesRoot() });
  /**
   * The preview's copy of main, the only folder the agent works in; null before the first start made
   * one. Never the project's own folder: its `.env` and the owner's uncommitted work are there.
   */
  const mainCopy = (project: Project): string | null => {
    const copy = previewWorktreePath(previewWorktreesRoot(), project.id);
    return existsSync(copy) ? copy : null;
  };
  const fixer = createStartFixer({
    getProject: (id) => projectStore.getProject(id),
    updateSettings: (id, settings) => {
      projectStore.updateProjectSettings(id, settings);
    },
    describe: async (project, failed) => {
      const dir = mainCopy(project);
      // A start that failed before there was a copy of main: nothing for the agent to work in
      if (!dir) return null;
      const saved = project.settings.previewServices ?? [];
      const resolved = resolveRecipe({
        files: previewFiles(dir, saved.map((s) => s.dir)),
        read: safeRead(dir),
        saved,
        pending: project.settings.previewPendingRecipe,
        contained: (folder) => isPathContained(path.resolve(dir, folder), dir).contained,
      });
      let commit = '';
      try {
        commit = execFileSync(getToolPath('git'), ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      } catch {
        // Not a repository yet: the recipe, the stage and the service still tell failures apart
      }
      const mainText = await mainRecipeText(project.path, mainBranchOf(project), { git: getToolPath('git'), env: getIsolatedGitEnv() });
      return { key: failureKey({ commit, recipe: resolved.recipe, stage: failed.failedAt, service: failed.failedService }), recipe: resolved.recipe, source: resolved.source, base: recipeHash(mainText) };
    },
    ledger: (projectId) => openFixLedger(app.getPath('userData'), projectId),
    hasCredential: () => getClaudeCredentialStatus().configured,
    fix: async (run) => {
      const project = projectStore.getProject(run.projectId);
      if (!project) throw new Error('Project not found');
      const dir = mainCopy(project);
      if (!dir) throw new Error("The preview has no copy of the project's main branch to work in.");
      const runningMd = readRunningMd(dir);
      const env = await previewEnvReport(project, dir);
      // What must not reach the model whatever printed it: the owner's own values, and every value the preview set itself
      const secrets = [
        ...Object.values(project.settings.previewEnv ?? {}),
        ...Object.values(project.settings.previewServiceEnv ?? {}).flatMap((values) => Object.values(values)),
        ...env.services.flatMap((service) => service.vars.filter((v) => v.source !== 'example' && v.source !== 'exampleDir' && v.source !== 'port' && v.source !== 'address').map((v) => v.value)),
      ];
      return fixStart({
        failure: run.failure,
        recipe: run.recipe,
        source: run.source,
        facts: fixFacts({
          dockerAnswers: (await hostDocker(process.env)(['info']).catch(() => ({ ok: false }))).ok,
          onPath: (name) => findOnPath(name, searchPath()) !== undefined,
          env,
          runningMd: runningMd.exists ? runningMd.markdown : null,
        }),
        worktree: dir,
        language: (readSettingsFile()?.language as string | undefined) ?? 'en',
        runTask: (options) => runClaudeTask(options as unknown as Parameters<typeof runClaudeTask>[0]),
        model: getFeatureSettings('previewFix'),
        tryRecipe: run.tryRecipe,
        signal: run.signal,
        onTry: run.onTry,
        secrets,
        // A recipe whose folder is a link out of the copy is not tried
        contained: (folder) => isPathContained(path.resolve(dir, folder), dir).contained,
      });
    },
    tryStart: (project) => startPreview(project, onStatus, startDeps()),
    stop: (projectId) => stopPreview(projectId),
    settle: (projectId) => settleSoon(projectId),
    send: (status) => send(status),
  });

  const onStatus = (status: PreviewStatus) => {
    if (status.stage !== 'ready') uxReview?.abort();
    if (status.stage === 'ready' && status.url) view.show(status.projectId, status.url, status.origins);
    else if (status.stage === 'stopped' || status.stage === 'failed') view.destroy();
    else view.hide();
    send(fixer.onStatus(status));
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
        // A try of the agent's that was starting is stopped once it has
        void fixer.previewStopped().then(() => stopPreview());
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
    // A start the owner asked for takes over from an agent that was working on the one before:
    // a try of the agent's that is starting is waited for and stopped first, so two never race
    await fixer.previewStopped();
    view.setWorktree(task?.worktree ?? previewWorktreePath(previewWorktreesRoot(), projectId));
    try {
      if (!task) settleSoon(projectId);
      const status = await startPreview(project, onStatus, startDeps(), { resetData, task });
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
  const gitOf = () => ({ git: getToolPath('git'), env: getIsolatedGitEnv() });
  /** main's preview.json for a project that has that branch; undefined where it has none (a folder that is no repository yet) */
  const mainRecipe = async (project: Project): Promise<{ text: string | null } | undefined> =>
    (await mainBranchExists(project.path, mainBranchOf(project), gitOf())) ? { text: await mainRecipeText(project.path, mainBranchOf(project), gitOf()) } : undefined;
  const recipeInfo = async (project: Project, taskId?: unknown): Promise<PreviewRecipeInfo> => {
    // A task's preview runs the task's own folder; the project's runs main
    const ofTask = typeof taskId === 'string' && !!taskId;
    const info = previewRecipeInfo(project, previewDir(project, taskId), undefined, ofTask ? undefined : await mainRecipe(project));
    const pending = project.settings.previewPendingRecipe;
    if (info.source !== 'pending' || !pending) return info;
    const refusal = settler.refusal(project.id);
    const refusalSaid = refusal ? saidFor([refusal])[0] : undefined;
    return { ...info, pending: { origin: pending.origin, ...(refusal ? { refusal } : {}), ...(refusalSaid ? { refusalSaid } : {}) } };
  };
  ipcMain.handle(IPC_CHANNELS.PREVIEW_RECIPE, async (_e, projectId: string, taskId?: unknown): Promise<IPCResult<PreviewRecipeInfo>> => {
    const project = projectStore.getProject(projectId);
    if (!project) return { success: false, error: 'Project not found' };
    try {
      return { success: true, data: await recipeInfo(project, taskId) };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  });
  /** By the project's settings as they are now: a running preview restarts its services, one that is not running starts */
  const restartOrStart = async (projectId: string, taskId?: unknown): Promise<IPCResult<PreviewStatus>> => {
    const project = projectStore.getProject(projectId);
    if (!project) return { success: false, error: 'Project not found' };
    const restarted = await restartPreviewServices(project, draftTask(taskId));
    return restarted ? { success: true, data: restarted } : start(projectId, false, taskId);
  };
  // The owner changed the services of the project's recipe: used at once, and written into main by the app
  ipcMain.handle(IPC_CHANNELS.PREVIEW_SAVE_RECIPE_SERVICES, async (_e, projectId: string, services: unknown): Promise<IPCResult<PreviewRecipeInfo> & { errorSaid?: SaidText }> => {
    const project = projectStore.getProject(projectId);
    const refuse = (error: string) => ({ success: false as const, error, errorSaid: saidFor([error])[0] });
    if (!project) return refuse(say('projectNotFound', 'The project was not found.'));
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
      // Used at once: the running preview restarts its services by it, one that is not running starts. Once, here:
      // the commit that follows changes nothing the preview has not got already.
      void restartOrStart(projectId).catch(() => {});
      // Usually a moment; behind a task's merge it goes on in the background, and the form says it is not in the repository yet
      await Promise.race([settler.settle(projectId), new Promise((resolve) => setTimeout(resolve, SAVE_WAIT_MS))]);
      const saved = projectStore.getProject(projectId) ?? project;
      return { success: true, data: await recipeInfo(saved) };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  });
  // Apply and restart: the running services restart with the saved values; a preview that isn't running starts
  ipcMain.handle(IPC_CHANNELS.PREVIEW_RESTART_SERVICES, async (_e, projectId: string, taskId?: unknown): Promise<IPCResult<PreviewStatus>> => {
    return restartOrStart(projectId, taskId);
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

  // The owner asks the agent to look at the project's last failed start, or stops it
  ipcMain.handle(IPC_CHANNELS.PREVIEW_FIX, async (_e, projectId: string): Promise<IPCResult & { errorSaid?: SaidText }> => {
    if (await fixer.ask(projectId)) return { success: true };
    const error = say('fixNothingToFix', "No failed start of this project's preview is waiting to be looked at.");
    return { success: false, error, errorSaid: saidFor([error])[0] };
  });
  ipcMain.handle(IPC_CHANNELS.PREVIEW_FIX_CANCEL, async (): Promise<IPCResult> => {
    await fixer.cancel();
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.PREVIEW_STOP, async (): Promise<IPCResult> => {
    // A UX review stopped mid-way can leave its Playwright behind
    if (uxReview) cleanUpBrowserOrphansSoon(bundledBrowserServers);
    uxReview?.abort();
    view.destroy();
    await fixer.previewStopped();
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
