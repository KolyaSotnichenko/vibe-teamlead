/**
 * The Telegram bot in the running app: the service (service.ts) with the real stores, event
 * sources and actions. One per app (the single-instance lock keeps a second app from polling
 * the same token). Started after the IPC handlers; stopped before quit.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { app, type BrowserWindow, nativeImage, powerMonitor } from 'electron';

import { AUTO_BUILD_PATHS, getSpecsDir, IPC_CHANNELS } from '../../shared/constants';
import type { GatewayPrices, Project, Task } from '../../shared/types';
import { resolveDefaultTaskModels } from '../../shared/utils/task-models';
import { parseVerificationSummary } from '../../shared/utils/verification-summary';
import type { TelegramStatus } from '../../shared/types/telegram';
import type { AgentManager } from '../agent';
import { listPendingQuestions, onQuestionEvent } from '../agent/agent-questions';
import { answerAgentQuestion } from '../agent/answer-question';
import { resolveClaudeCredential } from '../ai/claude-code/credential';
import { analyzeBrief } from '../ai/runners/brief-import';
import { getToolPath } from '../cli-tool-manager';
import { lastBranchPush } from '../deploy/branch-push';
import { createBriefTasks } from '../ipc-handlers/brief-handlers';
import { approveTaskDesign, captureWaitingFrames, commentTaskDesign, taskDesign } from '../ipc-handlers/task-design-handlers';
import { createTaskInProject } from '../ipc-handlers/task/crud-handlers';
import { reviewTask, startTask } from '../ipc-handlers/task/execution-handlers';
import { resolveSpecDir } from '../ipc-handlers/task/workspace-handlers';
import { mergeTaskWorktree } from '../ipc-handlers/task/worktree-handlers';
import { safeSendToRenderer } from '../ipc-handlers/utils';
import { getIsolatedGitEnv } from '../utils/git-isolation';
import { taskDiffBase } from '../utils/task-diff-base';
import { findTaskWorktree } from '../worktree-paths';
import { USAGE_FILE } from '../ai/usage/usage-ledger';
import { appEvents } from '../app-events';
import { getAppLanguage } from '../app-language';
import { appLog } from '../app-logger';
import { stopTaskById } from '../ipc-handlers/task/execution-handlers';
import { findTaskAndProject } from '../ipc-handlers/task/shared';
import { queuePause } from '../ipc-handlers/task/task-control';
import { projectStore } from '../project-store';
import { readSettingsFile } from '../settings-utils';
import { taskStateManager } from '../task-state-manager';
import { createBotApi } from './bot-api';
import { usageBetween, usageToday } from './commands';
import type { MergeOutcome } from './review';
import { criteriaCoverage, diffUrl, latestScreenshots, parseNumstat, type ReviewDetails } from './review-details';
import { toTelegramPhoto } from './photos';
import { titleFromText } from './tasks';
import { createTelegramService, type TelegramService } from './service';
import { createTelegramSettingsStore } from './settings-store';
import { createTokenStore } from './token-store';

let service: TelegramService | undefined;

export function getTelegramService(): TelegramService | undefined {
  return service;
}

/** The projects open in the window (tabs); all of them when none is open */
function openProjects() {
  const all = projectStore.getProjects();
  const open = projectStore.getTabState().openProjectIds;
  const picked = open.length ? open.map((id) => all.find((p) => p.id === id)).filter((p): p is (typeof all)[number] => !!p) : all;
  return picked.map((p) => ({ id: p.id, name: p.name, path: p.path }));
}

const execFileAsync = promisify(execFile);
const MAX_PHOTOS = 10;

const readText = (file: string) => readFile(file, 'utf-8').catch(() => '');

/** The project's own spec folder of a task, and the task's worktree one (where the agents write) */
function specDirs(task: Task, project: Project): string[] {
  const own = task.specsPath ?? path.join(project.path, getSpecsDir(project.autoBuildPath), task.specId);
  const current = resolveSpecDir(task.id, project.id);
  return current && current !== own ? [current, own] : [own];
}

/** Criteria covered, app checks, files changed and the diff link of a task in review */
async function reviewDetails(taskId: string, projectId?: string): Promise<ReviewDetails> {
  const { task, project } = findTaskAndProject(taskId, projectId);
  if (!task || !project) return {};
  const [specDir] = specDirs(task, project);
  const [spec, qa, verification] = await Promise.all([
    readText(path.join(specDir, AUTO_BUILD_PATHS.SPEC_FILE)),
    readText(path.join(specDir, AUTO_BUILD_PATHS.QA_REPORT)),
    readText(path.join(specDir, 'verification.json')),
  ]);
  const details: ReviewDetails = {};
  const criteria = criteriaCoverage(spec, qa);
  if (criteria) details.criteria = criteria;
  const checks = parseVerificationSummary(verification);
  if (checks) details.checks = { status: checks.status, ...(checks.source ? { source: checks.source } : {}) };
  const base = task.metadata?.baseBranch || project.settings?.mainBranch || 'main';
  const worktree = findTaskWorktree(project.path, task.specId);
  if (worktree) {
    try {
      const git = getToolPath('git');
      const { stdout } = await execFileAsync(git, ['diff', '--numstat', taskDiffBase(git, worktree, base)], { cwd: worktree, encoding: 'utf-8', env: getIsolatedGitEnv() });
      details.files = parseNumstat(stdout);
    } catch {
      // informational
    }
  }
  const repo = project.settings?.deploy?.repo;
  if (repo && lastBranchPush(project.id, task.id)?.sha) details.diffUrl = diffUrl(repo, base, task.specId);
  return details;
}

/** The latest QA browser screenshots of a task, ready for Telegram (none for a task without UI) */
async function reviewScreenshots(taskId: string, projectId?: string): Promise<Buffer[]> {
  const { task, project } = findTaskAndProject(taskId, projectId);
  if (!task || !project) return [];
  const photos: Buffer[] = [];
  for (const file of latestScreenshots(specDirs(task, project), MAX_PHOTOS)) {
    const photo = toTelegramPhoto(nativeImage.createFromPath(file));
    if (photo) photos.push(photo);
  }
  return photos;
}

function mergeOutcome(result: Awaited<ReturnType<typeof mergeTaskWorktree>>): MergeOutcome {
  if (!result.success || !result.data) return { kind: 'failed', message: result.error };
  if (result.data.needsReview) return { kind: 'needs_review', message: result.data.message };
  if (!result.data.success) return { kind: 'failed', message: result.data.message };
  return { kind: 'merged', message: result.data.message };
}

export function initTelegram(agentManager: AgentManager, getMainWindow: () => BrowserWindow | null): TelegramService {
  const dir = app.getPath('userData');
  const settings = createTelegramSettingsStore(dir);

  service = createTelegramService({
    tokens: createTokenStore(dir),
    settings,
    createApi: (token) => createBotApi(token),
    language: getAppLanguage,
    secrets: () => {
      try {
        return [resolveClaudeCredential().key];
      } catch {
        return [];
      }
    },
    questions: { pending: listPendingQuestions, onEvent: onQuestionEvent, answer: answerAgentQuestion },
    notifierSources: {
      onStatusChange: (listener) => taskStateManager.onStatusChange(listener),
      onAppEvent: (type, listener) => appEvents.on(type, listener),
      onBaseFailures: (listener) => {
        agentManager.on('base-failures', listener);
        return () => agentManager.off('base-failures', listener);
      },
    },
    task: (taskId, projectId) => {
      const { task, project } = findTaskAndProject(taskId, projectId);
      if (!task) return undefined;
      return { title: task.title || task.specId, projectName: project?.name, projectId: project?.id };
    },
    projectName: (projectId) => projectStore.getProject(projectId)?.name,
    commands: {
      projects: () => openProjects().map(({ id, name }) => ({ id, name })),
      tasks: (projectId) => projectStore.getTasks(projectId),
      runningTaskIds: () => agentManager.getRunningTasks(),
      stopTask: (taskId) => stopTaskById(agentManager, taskId),
      queuePause,
      pendingQuestions: () => listPendingQuestions().length,
      usageToday: async () => {
        const ledgers = await Promise.all(
          openProjects().map((p) => readFile(path.join(p.path, '.vibe-teamlead', USAGE_FILE), 'utf-8').catch(() => '')),
        );
        const prices = (readSettingsFile()?.gatewayModelPrices ?? {}) as GatewayPrices;
        return usageToday(ledgers, Date.now(), prices);
      },
    },
    review: {
      details: reviewDetails,
      screenshots: reviewScreenshots,
      state: (taskId, projectId) => {
        const { task } = findTaskAndProject(taskId, projectId);
        return task ? { status: task.status, reviewReason: task.reviewReason } : undefined;
      },
      // The window's Merge button: the same merge, auto-merge rules included
      merge: async (taskId, projectId) => mergeOutcome(await mergeTaskWorktree(getMainWindow, taskId, { projectId })),
      // The window's "send back with an instruction"
      sendBack: (taskId, comment) => reviewTask(agentManager, taskId, false, comment),
    },
    design: {
      waiting: (taskId) => {
        const design = taskDesign(taskId);
        return design?.waiting && design.settings.approval !== 'auto' ? { stage: design.waiting } : undefined;
      },
      frames: async (taskId) =>
        (await captureWaitingFrames(taskId, MAX_PHOTOS)).map(({ image }) => toTelegramPhoto(image)).filter((p): p is Buffer => !!p),
      approve: (taskId, stage) => approveTaskDesign(agentManager, getMainWindow, taskId, stage),
      comment: (taskId, text) => commentTaskDesign(agentManager, getMainWindow, taskId, [{ frame: '', text }]),
    },
    taskActions: {
      create: async (projectId, text) => {
        const project = projectStore.getProject(projectId);
        if (!project) throw new Error('Project not found');
        // The window's create path, with the user's default models as the task wizard sets them
        const task = await createTaskInProject(project, titleFromText(text), text, { ...resolveDefaultTaskModels(readSettingsFile() as never) });
        // A task main created isn't on the board yet: this makes the window read the list
        safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_STATUS_CHANGE, task.id, 'backlog', project.id);
        return { taskId: task.id, title: task.title };
      },
      start: (taskId) => startTask(agentManager, getMainWindow, taskId),
      analyseBrief: async (projectId, text) => {
        const project = projectStore.getProject(projectId);
        if (!project) throw new Error('Project not found');
        if (!project.autoBuildPath) throw new Error('Initialize the project first.');
        // Clarification off: the analyst asks nothing and lists its open questions instead
        return analyzeBrief({ projectPath: project.path, autoBuildPath: project.autoBuildPath, input: { text, clarify: false }, askUser: async () => null });
      },
      createBriefTasks: async (projectId, briefId, tasks) => {
        const result = await createBriefTasks(projectId, briefId, tasks, { queue: false });
        for (const created of result.data ?? []) safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_STATUS_CHANGE, created.taskId, 'backlog', projectId);
        return { success: result.success, count: result.data?.length, error: result.error };
      },
    },
    digest: {
      tasks: (projectId) => projectStore.getTasks(projectId),
      usageSince: async (from, to) => {
        const ledgers = await Promise.all(openProjects().map((p) => readText(path.join(p.path, '.vibe-teamlead', USAGE_FILE))));
        const prices = (readSettingsFile()?.gatewayModelPrices ?? {}) as GatewayPrices;
        return usageBetween(ledgers, from, to, prices);
      },
    },
    onStatus: (status: TelegramStatus) => {
      const window = getMainWindow();
      if (window && !window.isDestroyed()) window.webContents.send(IPC_CHANNELS.TELEGRAM_STATUS_CHANGED, status);
    },
    log: appLog,
  });

  // A sleeping computer misses the digest timer's ticks: look again on wake
  powerMonitor.on('resume', () => void service?.checkDigest());

  void service.start().catch((error) => appLog.warn('[Telegram] Could not start:', error instanceof Error ? error.message : String(error)));
  return service;
}

/** Before quit: the long poll is aborted so nothing keeps the app alive */
export async function stopTelegram(): Promise<void> {
  await service?.stop();
}
