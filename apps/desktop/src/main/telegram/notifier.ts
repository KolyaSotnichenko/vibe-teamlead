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
 *
 * Layout (HTML): an emoji header with the project, the task title in bold (its spec id in code),
 * a detail line. A merge comes with the 🎉 message effect; a failed CI run lists its failed jobs
 * and the end of the log in an expandable quote.
 */

import type { ReviewReason, TaskStatus } from '../../shared/types';
import type { TelegramNotificationKind, TelegramNotificationSettings } from '../../shared/types/telegram';
import type { AppEventMap } from '../app-events';
import type { BotApi, InlineButton } from './bot-api';
import { b, code, type Html, html, htmlText, joinHtml, link, quote } from './format';
import type { Translate } from './i18n';

/** Telegram's 🎉 message effect */
export const CELEBRATE_EFFECT = '5046509860389126442';
/** The end of a failed CI log shown in the chat */
const LOG_TAIL_CHARS = 1500;

export interface NotifierSources {
  onStatusChange: (listener: (taskId: string, status: TaskStatus, reviewReason?: ReviewReason) => void) => () => void;
  onAppEvent: <K extends keyof AppEventMap>(type: K, listener: (payload: AppEventMap[K]) => void) => () => void;
  onBaseFailures: (listener: (taskId: string, data: { baseCommit: string }, projectId?: string) => void) => () => void;
}

export interface Notification {
  kind: TelegramNotificationKind;
  text: Html;
  /** A message effect (private chats) */
  effect?: string;
  taskId?: string;
  projectId?: string;
  /** The task's title, when it is about a task */
  title?: string;
  /** For a task in Human Review: why it is there */
  reviewReason?: ReviewReason;
}

export interface NotifierDeps {
  api: () => BotApi | undefined;
  chatId: () => number | undefined;
  t: Translate;
  notifications: () => TelegramNotificationSettings;
  task: (taskId: string, projectId?: string) => { title: string; specId?: string; projectName?: string; projectId?: string } | undefined;
  projectName: (projectId: string) => string | undefined;
  /** Stage 2: buttons for a notification (review actions, Start/Stop) */
  buttonsFor?: (notification: Notification) => InlineButton[][] | undefined;
  /** Sends a notification its own way (the review message); true when it did */
  deliver?: (notification: Notification, chatId: number) => Promise<boolean>;
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
        if (deps.deliver && (await deps.deliver(notification, chatId))) return;
        const buttons = deps.buttonsFor?.(notification);
        const options = { ...(buttons ? { buttons } : {}), ...(notification.effect ? { effect: notification.effect } : {}) };
        await api.sendMessage(chatId, notification.text, Object.keys(options).length ? options : undefined);
      } catch (error) {
        deps.onError?.(error);
      }
    });
  };

  const h = htmlText(deps.t);
  const header = (key: string, project: string | undefined) => (project ? html`${h(key)} · ${project}` : h(key));

  const taskText = (key: string, taskId: string, projectId?: string, detail?: string): Html => {
    const info = deps.task(taskId, projectId);
    const title = info?.title ?? taskId;
    const titleLine = info?.specId && info.specId !== title ? html`${b(title)} · ${code(info.specId)}` : b(title);
    return joinHtml([header(key, info?.projectName), titleLine, ...(detail ? [h(detail)] : [])]);
  };

  const taskNotification = (
    kind: TelegramNotificationKind,
    key: string,
    taskId: string,
    projectId?: string,
    extra: { detail?: string; reviewReason?: ReviewReason; effect?: string } = {},
  ) => {
    const info = deps.task(taskId, projectId);
    send({
      kind,
      text: taskText(key, taskId, projectId, extra.detail),
      taskId,
      projectId: projectId ?? info?.projectId,
      title: info?.title ?? taskId,
      ...(extra.reviewReason ? { reviewReason: extra.reviewReason } : {}),
      ...(extra.effect ? { effect: extra.effect } : {}),
    });
  };

  const ciText = (payload: AppEventMap['main-run-failed']): Html => {
    const lines = [header('notify.ciFailed', deps.projectName(payload.projectId))];
    if (payload.failedJobs?.length) lines.push(h('notify.ciJobs', { jobs: joinHtml(payload.failedJobs.map(code), ', ') }));
    const tail = payload.logTail?.trim();
    if (tail) lines.push(quote(tail.length > LOG_TAIL_CHARS ? `…${tail.slice(-LOG_TAIL_CHARS)}` : tail, { expandable: true }));
    lines.push(h('notify.ciRun', { run: link(payload.url, payload.name) }));
    return joinHtml(lines);
  };

  const onStatus = (taskId: string, status: TaskStatus, reason?: ReviewReason) => {
    let kind: TelegramNotificationKind | undefined;
    let key: string | undefined;
    let detail: string | undefined;
    if (status === 'human_review' && reason === 'completed') [kind, key, detail] = ['reviewWaiting', 'notify.review', 'notify.qaApproved'];
    else if (status === 'human_review' && reason === 'qa_rejected') [kind, key, detail] = ['reviewWaiting', 'notify.review', 'notify.qaRejected'];
    else if (status === 'human_review' && reason === 'errors') [kind, key] = ['taskFailed', 'notify.failed'];
    else if (status === 'error') [kind, key] = ['taskFailed', 'notify.errored'];
    const state = `${status}:${reason ?? ''}`;
    if (!kind || !key) {
      said.delete(taskId);
      return;
    }
    if (said.get(taskId) === state) return;
    said.set(taskId, state);
    taskNotification(kind, key, taskId, undefined, { detail, reviewReason: reason });
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
        sources.onAppEvent('task-merged', ({ taskId, projectId }) => taskNotification('taskMerged', 'notify.merged', taskId, projectId, { effect: CELEBRATE_EFFECT })),
        sources.onAppEvent('verification-regression', ({ taskId, projectId }) =>
          taskNotification('regression', 'notify.regression', taskId, projectId, { detail: 'notify.regressionDetail' }),
        ),
        sources.onAppEvent('main-run-failed', (payload) => send({ kind: 'ciFailed', projectId: payload.projectId, text: ciText(payload) })),
        sources.onBaseFailures((_taskId, data, projectId) => {
          const key = `${projectId ?? ''}|${data.baseCommit}`;
          if (brokenMains.has(key)) return;
          brokenMains.add(key);
          const project = (projectId && deps.projectName(projectId)) || undefined;
          send({ kind: 'regression', projectId, text: joinHtml([header('notify.baseBroken', project), h('notify.baseBrokenDetail')]) });
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
