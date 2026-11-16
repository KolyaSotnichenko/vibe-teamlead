/**
 * Notifications to the owner's chat, from app events in the main process. Each kind has its
 * switch in Settings → Telegram (all on by default):
 *
 * - reviewWaiting: a task reached Human Review, QA approved (completed) or not (qa_rejected)
 * - taskFailed:    Human Review with errors, the error status, or a task stopped as stuck
 * - ciFailed:      a failed GitHub Actions run of the app's own push on main
 * - taskMerged:    a task was merged into the project
 * - regression:    the app's checks found a regression when merging, or fail on main
 *
 * Agent questions are sent by the question flow (questions.ts). A task's state is said once;
 * it is said again only after the task moved on. Stage 2 adds buttons through `buttonsFor`.
 * Sending never throws into the event source.
 */

import type { ReviewReason, TaskStatus } from '../../shared/types';
import type { TelegramNotificationKind, TelegramNotificationSettings } from '../../shared/types/telegram';
import type { AppEventMap } from '../app-events';
import type { BotApi, InlineButton } from './bot-api';
import type { Translate } from './i18n';

export interface NotifierSources {
  onStatusChange: (listener: (taskId: string, status: TaskStatus, reviewReason?: ReviewReason) => void) => () => void;
  onAppEvent: <K extends keyof AppEventMap>(type: K, listener: (payload: AppEventMap[K]) => void) => () => void;
  onBaseFailures: (listener: (taskId: string, data: { baseCommit: string }, projectId?: string) => void) => () => void;
}

export interface Notification {
  kind: TelegramNotificationKind;
  text: string;
  taskId?: string;
  projectId?: string;
}

export interface NotifierDeps {
  api: () => BotApi | undefined;
  chatId: () => number | undefined;
  t: Translate;
  notifications: () => TelegramNotificationSettings;
  task: (taskId: string, projectId?: string) => { title: string; projectName?: string; projectId?: string } | undefined;
  projectName: (projectId: string) => string | undefined;
  /** Stage 2: buttons for a notification (review actions, Start/Stop) */
  buttonsFor?: (notification: Notification) => InlineButton[][] | undefined;
  onError?: (error: unknown) => void;
}

export function createNotifier(deps: NotifierDeps) {
  const offs: Array<() => void> = [];
  /** What was last said about each task (status:reason) */
  const said = new Map<string, string>();
  const brokenMains = new Set<string>();
  let queue: Promise<void> = Promise.resolve();

  const send = (notification: Notification) => {
    if (!deps.notifications()[notification.kind]) return;
    const chatId = deps.chatId();
    const api = deps.api();
    if (chatId === undefined || !api) return;
    // In order, one after another; a failure is reported, never thrown
    queue = queue.then(async () => {
      try {
        const buttons = deps.buttonsFor?.(notification);
        await api.sendMessage(chatId, notification.text, buttons ? { buttons } : undefined);
      } catch (error) {
        deps.onError?.(error);
      }
    });
  };

  const taskText = (key: string, taskId: string, projectId?: string): string => {
    const info = deps.task(taskId, projectId);
    const lines = [deps.t(key, { task: info?.title ?? taskId })];
    if (info?.projectName) lines.push(deps.t('notify.inProject', { project: info.projectName }));
    return lines.join('\n');
  };

  const taskNotification = (kind: TelegramNotificationKind, key: string, taskId: string, projectId?: string) =>
    send({ kind, text: taskText(key, taskId, projectId), taskId, projectId: projectId ?? deps.task(taskId)?.projectId });

  const onStatus = (taskId: string, status: TaskStatus, reason?: ReviewReason) => {
    let kind: TelegramNotificationKind | undefined;
    let key: string | undefined;
    if (status === 'human_review' && reason === 'completed') [kind, key] = ['reviewWaiting', 'notify.review'];
    else if (status === 'human_review' && reason === 'qa_rejected') [kind, key] = ['reviewWaiting', 'notify.reviewRejected'];
    else if (status === 'human_review' && reason === 'errors') [kind, key] = ['taskFailed', 'notify.failed'];
    else if (status === 'error') [kind, key] = ['taskFailed', 'notify.errored'];
    const state = `${status}:${reason ?? ''}`;
    if (!kind || !key) {
      said.delete(taskId);
      return;
    }
    if (said.get(taskId) === state) return;
    said.set(taskId, state);
    taskNotification(kind, key, taskId);
  };

  return {
    start(sources: NotifierSources): void {
      this.stop();
      offs.push(
        sources.onStatusChange((taskId, status, reason) => {
          try {
            onStatus(taskId, status, reason);
          } catch (error) {
            deps.onError?.(error);
          }
        }),
        sources.onAppEvent('task-stuck', ({ taskId, projectId }) => taskNotification('taskFailed', 'notify.stuck', taskId, projectId)),
        sources.onAppEvent('task-merged', ({ taskId, projectId }) => taskNotification('taskMerged', 'notify.merged', taskId, projectId)),
        sources.onAppEvent('verification-regression', ({ taskId, projectId }) => taskNotification('regression', 'notify.regression', taskId, projectId)),
        sources.onAppEvent('main-run-failed', ({ projectId, name, url }) =>
          send({ kind: 'ciFailed', projectId, text: deps.t('notify.ciFailed', { project: deps.projectName(projectId) ?? '', run: name, url }) }),
        ),
        sources.onBaseFailures((_taskId, data, projectId) => {
          const key = `${projectId ?? ''}|${data.baseCommit}`;
          if (brokenMains.has(key)) return;
          brokenMains.add(key);
          send({ kind: 'regression', projectId, text: deps.t('notify.baseBroken', { project: (projectId && deps.projectName(projectId)) || '' }) });
        }),
      );
    },
    stop(): void {
      for (const off of offs.splice(0)) off();
    },
    /** Resolves when every queued message was sent (tests) */
    idle: () => queue,
  };
}

export type Notifier = ReturnType<typeof createNotifier>;
