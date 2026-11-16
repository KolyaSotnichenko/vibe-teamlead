/**
 * Bot commands (stage 1): /status, /project, /stop_all (with a confirmation), /resume, /help.
 * They use the same main-process functions the window's IPC handlers use (the Stop path, the
 * queue pause, the projects and tasks of the project store, the usage ledger).
 */

import type { GatewayPrices, Task } from '../../shared/types';
import { summarizeUsage } from '../ai/usage/usage-ledger';
import { type QueuePause, stopAllTasks } from '../ipc-handlers/task/task-control';
import type { BotApi } from './bot-api';
import type { Translate } from './i18n';
import type { Router } from './router';
import type { TelegramSettingsStore } from './settings-store';

export interface CommandDeps {
  api: () => BotApi | undefined;
  router: Router;
  t: Translate;
  settings: TelegramSettingsStore;
  /** The projects open in the app (tabs) */
  projects: () => Array<{ id: string; name: string }>;
  tasks: (projectId: string) => Task[];
  runningTaskIds: () => string[];
  /** What the Stop button does */
  stopTask: (taskId: string) => void;
  queuePause: QueuePause;
  pendingQuestions: () => number;
  /** Today's spend of the open projects */
  usageToday: () => Promise<{ usd: number; tokens: number }>;
}

const LIST_LIMIT = 5;
const RUNNING = new Set(['in_progress', 'ai_review']);

/** Sessions of the given ledgers between two moments (epoch ms): priced dollars and all tokens. Pure. */
export function usageBetween(ledgers: string[], from: number, to: number, prices: GatewayPrices = {}): { usd: number; tokens: number } {
  let usd = 0;
  let tokens = 0;
  for (const text of ledgers) {
    const inRange = text
      .split('\n')
      .filter((line) => {
        try {
          const at = Date.parse((JSON.parse(line) as { at?: string }).at ?? '');
          return at >= from && at <= to;
        } catch {
          return false;
        }
      })
      .join('\n');
    const summary = summarizeUsage(inRange, prices);
    usd += summary.costUsd + summary.gatewayCostUsd;
    tokens += summary.totalTokens;
  }
  return { usd: Math.round(usd * 1e6) / 1e6, tokens };
}

/** Today's (local day) sessions of the given ledgers. Pure. */
export function usageToday(ledgers: string[], now: number, prices: GatewayPrices = {}): { usd: number; tokens: number } {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return usageBetween(ledgers, start.getTime(), now, prices);
}

export function registerCommands(deps: CommandDeps): void {
  const { router, t } = deps;
  const send = async (chatId: number, text: string, buttons?: Parameters<BotApi['sendMessage']>[2]) => deps.api()?.sendMessage(chatId, text, buttons);
  const edit = async (chatId: number, messageId: number | undefined, text: string) => {
    if (messageId !== undefined) await deps.api()?.editMessageText(chatId, messageId, text);
  };

  const list = (tasks: Task[]) => {
    if (!tasks.length) return t('status.none');
    const names = tasks.slice(0, LIST_LIMIT).map((task) => task.title || task.specId);
    return tasks.length > LIST_LIMIT ? `${names.join(', ')}, +${tasks.length - LIST_LIMIT}` : names.join(', ');
  };

  router.command('help', ({ chatId }) => void send(chatId, t('help')));

  router.command('status', async ({ chatId }) => {
    const projects = deps.projects();
    if (!projects.length) {
      await send(chatId, t('status.noProjects'));
      return;
    }
    const current = deps.settings.get().currentProjectId;
    const blocks: string[] = [];
    for (const project of projects) {
      const tasks = deps.tasks(project.id).filter((task) => !task.metadata?.archivedAt);
      blocks.push(
        [
          `${t('status.project', { name: project.name })}${project.id === current ? ` ${t('status.current')}` : ''}`,
          t('status.running', { tasks: list(tasks.filter((task) => RUNNING.has(task.status))) }),
          t('status.queued', { tasks: list(tasks.filter((task) => task.status === 'queue')) }),
          t('status.waiting', { tasks: list(tasks.filter((task) => task.status === 'human_review' && task.reviewReason !== 'stopped')) }),
        ].join('\n'),
      );
    }
    const footer: string[] = [];
    const questions = deps.pendingQuestions();
    if (questions) footer.push(t('status.questions', { count: questions }));
    if (deps.queuePause.isPaused()) footer.push(t('status.queuePaused'));
    try {
      const usage = await deps.usageToday();
      footer.push(usage.usd > 0 ? t('status.spend', { amount: usage.usd.toFixed(2) }) : t('status.spendTokens', { tokens: usage.tokens.toLocaleString('en-US') }));
    } catch {
      // the spend is informational
    }
    await send(chatId, [...blocks, ...(footer.length ? [footer.join('\n')] : [])].join('\n\n'));
  });

  router.command('project', async ({ chatId }) => {
    const projects = deps.projects();
    if (!projects.length) {
      await send(chatId, t('project.none'));
      return;
    }
    const group = `project:${Date.now()}:${Math.random()}`;
    const buttons = projects.map((project) => [
      router.button(project.name, async ({ chatId: chat, messageId }) => {
        deps.settings.update({ currentProjectId: project.id });
        router.forgetGroup(group);
        await edit(chat, messageId, t('project.chosen', { name: project.name }));
      }, group),
    ]);
    await send(chatId, t('project.choose'), { buttons });
  });

  router.command('stop_all', async ({ chatId }) => {
    const count = deps.runningTaskIds().length;
    const group = `stop:${Date.now()}:${Math.random()}`;
    const yes = router.button(t('stopAll.yes'), async ({ chatId: chat, messageId }) => {
      router.forgetGroup(group);
      const ids = stopAllTasks({ running: deps.runningTaskIds, stop: deps.stopTask, pause: deps.queuePause });
      await edit(chat, messageId, t('stopAll.done', { count: ids.length }));
    }, group);
    const no = router.button(t('stopAll.no'), async ({ chatId: chat, messageId }) => {
      router.forgetGroup(group);
      await edit(chat, messageId, t('stopAll.cancelled'));
    }, group);
    await send(chatId, count ? t('stopAll.confirmCount', { count }) : t('stopAll.confirm'), { buttons: [[yes, no]] });
  });

  router.command('resume', async ({ chatId }) => {
    await send(chatId, t(deps.queuePause.set(false) ? 'resume.done' : 'resume.notPaused'));
  });
}
