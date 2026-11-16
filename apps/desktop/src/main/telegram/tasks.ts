/**
 * New tasks from the chat (design item 6). `/task <text>` creates a task in the current project
 * (`/project`; the only open project otherwise) in Planning, through the window's create path,
 * with a Start button. A plain message from the owner offers "Create a task from this". Text over
 * LONG_TEXT characters also offers "Analyse as a brief": the brief import with clarification off
 * (it asks nothing), then the proposal's summary with "Create N tasks" (the brief dialog's create,
 * not queued) or "Discard". Slow work (creating, analysing) runs in the background so the chat
 * keeps working.
 */

import type { BriefProposal } from '../../shared/types';
import type { BotApi } from './bot-api';
import type { Translate } from './i18n';
import type { Router } from './router';
import type { TelegramSettingsStore } from './settings-store';

/** Longer than this, a message reads as a brief */
export const LONG_TEXT = 600;
const LISTED_TASKS = 15;

export interface TaskActions {
  /** The window's create path: a task in Planning */
  create: (projectId: string, text: string) => Promise<{ taskId: string; title: string }>;
  /** What the Start button does */
  start: (taskId: string, projectId: string) => Promise<void>;
  /** The brief import, clarification off */
  analyseBrief: (projectId: string, text: string) => Promise<BriefProposal>;
  /** The brief dialog's create, not queued */
  createBriefTasks: (projectId: string, briefId: string, tasks: BriefProposal['tasks']) => Promise<{ success: boolean; count?: number; error?: string }>;
}

export interface TaskCommandDeps {
  api: () => BotApi | undefined;
  router: Router;
  t: Translate;
  settings: TelegramSettingsStore;
  projects: () => Array<{ id: string; name: string }>;
  actions: TaskActions;
  onError?: (error: unknown) => void;
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function registerTaskCommands(deps: TaskCommandDeps): void {
  const { router, t, actions } = deps;
  let counter = 0;
  let analysing = false;
  const group = (kind: string) => `${kind}:${++counter}`;
  const send = async (chatId: number, text: string, options?: Parameters<BotApi['sendMessage']>[2]) => deps.api()?.sendMessage(chatId, text, options);
  const edit = async (chatId: number, messageId: number | undefined, text: string) => {
    if (messageId !== undefined) await deps.api()?.editMessageText(chatId, messageId, text);
  };
  const background = (work: () => Promise<void>) => {
    void work().catch((error) => deps.onError?.(error));
  };

  /** The project the commands act on: the chosen one if still open, else the only open one */
  const project = (): { id: string; name: string } | undefined => {
    const open = deps.projects();
    const chosen = deps.settings.get().currentProjectId;
    return open.find((p) => p.id === chosen) ?? (open.length === 1 ? open[0] : undefined);
  };

  const createTask = (chatId: number, target: { id: string; name: string }, text: string) =>
    background(async () => {
      let created: { taskId: string; title: string };
      try {
        created = await actions.create(target.id, text);
      } catch (error) {
        await send(chatId, t('task.createFailed', { reason: reasonOf(error) }));
        return;
      }
      const buttons = group('task');
      const start = router.button(
        t('task.start'),
        async ({ chatId: chat, messageId }) => {
          router.forgetGroup(buttons);
          try {
            await actions.start(created.taskId, target.id);
            await edit(chat, messageId, t('task.started', { title: created.title }));
          } catch (error) {
            await edit(chat, messageId, t('task.startFailed', { reason: reasonOf(error) }));
          }
        },
        buttons,
      );
      await send(chatId, t('task.created', { project: target.name, title: created.title }), { buttons: [[start]] });
    });

  const showProposal = async (chatId: number, target: { id: string; name: string }, proposal: BriefProposal) => {
    const titles = proposal.tasks.slice(0, LISTED_TASKS).map((task) => `• ${task.title}`);
    if (proposal.tasks.length > LISTED_TASKS) titles.push(`+${proposal.tasks.length - LISTED_TASKS}`);
    const text = [
      t('brief.title', { title: proposal.title, project: target.name }),
      ...(proposal.summary ? [proposal.summary] : []),
      '',
      t('brief.counts', { epics: proposal.epics.length, tasks: proposal.tasks.length, questions: proposal.openQuestions.length }),
      ...titles,
    ].join('\n');
    if (!proposal.tasks.length) {
      await send(chatId, text);
      return;
    }
    const buttons = group('brief');
    const create = router.button(
      t('brief.create', { count: proposal.tasks.length }),
      async ({ chatId: chat, messageId }) => {
        router.forgetGroup(buttons);
        await edit(chat, messageId, `${text}\n\n${t('brief.creating')}`);
        background(async () => {
          const result = await actions.createBriefTasks(target.id, proposal.briefId, proposal.tasks).catch((error) => ({ success: false, error: reasonOf(error), count: 0 }));
          await edit(
            chat,
            messageId,
            `${text}\n\n${result.success ? t('brief.created', { count: result.count ?? proposal.tasks.length }) : t('brief.createFailed', { reason: result.error ?? '' })}`,
          );
        });
      },
      buttons,
    );
    const discard = router.button(
      t('brief.discard'),
      async ({ chatId: chat, messageId }) => {
        router.forgetGroup(buttons);
        await edit(chat, messageId, `${text}\n\n${t('brief.discarded')}`);
      },
      buttons,
    );
    await send(chatId, text, { buttons: [[create, discard]] });
  };

  const analyse = (chatId: number, target: { id: string; name: string }, text: string) => {
    if (analysing) return send(chatId, t('brief.busy'));
    analysing = true;
    background(async () => {
      try {
        await send(chatId, t('brief.analysing'));
        let proposal: BriefProposal;
        try {
          proposal = await actions.analyseBrief(target.id, text);
        } catch (error) {
          await send(chatId, t('brief.failed', { reason: reasonOf(error) }));
          return;
        }
        await showProposal(chatId, target, proposal);
      } finally {
        analysing = false;
      }
    });
  };

  /** The choice for a text: create a task, and for a long one analyse it as a brief */
  const offer = async (chatId: number, text: string, prompt: string) => {
    const buttons = group('offer');
    const pick = (action: (chat: number, target: { id: string; name: string }) => unknown) =>
      async ({ chatId: chat, messageId }: { chatId: number; messageId?: number }) => {
        router.forgetGroup(buttons);
        const target = project();
        if (!target) {
          await edit(chat, messageId, t('task.chooseProject'));
          return;
        }
        await edit(chat, messageId, prompt);
        await action(chat, target);
      };
    const row = [router.button(t('task.createFromText'), pick((chat, target) => createTask(chat, target, text)), buttons)];
    if (text.length > LONG_TEXT) row.push(router.button(t('task.analyse'), pick((chat, target) => analyse(chat, target, text)), buttons));
    await send(chatId, prompt, { buttons: [row] });
  };

  router.command('task', async ({ chatId, args }) => {
    if (!args) {
      await send(chatId, t('task.usage'));
      return;
    }
    const target = project();
    if (!target) {
      await send(chatId, t('task.chooseProject'));
      return;
    }
    if (args.length > LONG_TEXT) {
      await offer(chatId, args, t('task.longOffer'));
      return;
    }
    createTask(chatId, target, args);
  });

  router.onText(async (text, { chatId }) => {
    const trimmed = text.trim();
    if (!trimmed) return false;
    await offer(chatId, trimmed, trimmed.length > LONG_TEXT ? t('task.longOffer') : t('task.offer'));
    return true;
  });
}
