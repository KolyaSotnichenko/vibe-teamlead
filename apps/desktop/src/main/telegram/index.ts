/**
 * The Telegram bot in the running app: the service (service.ts) with the real stores, event
 * sources and actions. One per app (the single-instance lock keeps a second app from polling
 * the same token). Started after the IPC handlers; stopped before quit.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { app, type BrowserWindow } from 'electron';

import { IPC_CHANNELS } from '../../shared/constants';
import type { GatewayPrices } from '../../shared/types';
import type { TelegramStatus } from '../../shared/types/telegram';
import type { AgentManager } from '../agent';
import { listPendingQuestions, onQuestionEvent } from '../agent/agent-questions';
import { answerAgentQuestion } from '../agent/answer-question';
import { resolveClaudeCredential } from '../ai/claude-code/credential';
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
import { usageToday } from './commands';
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
    onStatus: (status: TelegramStatus) => {
      const window = getMainWindow();
      if (window && !window.isDestroyed()) window.webContents.send(IPC_CHANNELS.TELEGRAM_STATUS_CHANGED, status);
    },
    log: appLog,
  });

  void service.start().catch((error) => appLog.warn('[Telegram] Could not start:', error instanceof Error ? error.message : String(error)));
  return service;
}

/** Before quit: the long poll is aborted so nothing keeps the app alive */
export async function stopTelegram(): Promise<void> {
  await service?.stop();
}
