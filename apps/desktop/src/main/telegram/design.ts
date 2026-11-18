/**
 * Design approval from the chat (design item 4). When the designer's frames wait for the owner
 * (design approval = owner: the task is in Human Review for design_review), the frames come as an
 * album, then a message with Approve / Comment:
 *
 * - Approve → the Design tab's approval of the stage that waits (checked again at the press).
 * - Comment → a force-reply → the Design tab's comment on the whole set, back to the designer.
 *
 * Decided on the computer first → the message says so and its buttons expire. Said once per
 * stage. Switched with "A task waits for your review".
 *
 * A design that couldn't be made (design_failed): the notifier's message comes with the
 * designer's error and the Design tab's two buttons, Try the design again and Build without
 * design, which run the same functions (checked again at the press: the task must still wait for
 * this decision); the message is edited with the result.
 */

import type { ReviewReason, TaskStatus } from '../../shared/types';
import type { BotApi, InlineButton } from './bot-api';
import { b, type Html, html, htmlText, joinHtml } from './format';
import type { Translate } from './i18n';
import type { Notification } from './notifier';
import { MAX_ALBUM } from './review';
import type { Router } from './router';

export type DesignStage = 'wireframes' | 'design';

export interface DesignActions {
  /** The stage that waits for the owner's approval, if any */
  waiting: (taskId: string, projectId?: string) => { stage: DesignStage } | undefined;
  /** Pictures of the frames that wait, ready to send */
  frames: (taskId: string, projectId?: string) => Promise<Buffer[]>;
  approve: (taskId: string, stage: DesignStage, projectId?: string) => Promise<{ success: boolean; error?: string }>;
  comment: (taskId: string, text: string, projectId?: string) => Promise<{ success: boolean; error?: string }>;
  /** The designer's error while the task waits for the owner's decision (design_failed); undefined otherwise */
  failure?: (taskId: string, projectId?: string) => { error: string } | undefined;
  /** The Design tab's Try the design again */
  retry?: (taskId: string, projectId?: string) => Promise<{ success: boolean; error?: string }>;
  /** The Design tab's Build without design */
  skip?: (taskId: string, projectId?: string) => Promise<{ success: boolean; error?: string }>;
}

/** "Design couldn't be made" gets the design flow's buttons */
export function isDesignFailureMessage(notification: { kind: string; taskId?: string; reviewReason?: ReviewReason }): boolean {
  return notification.kind === 'reviewWaiting' && !!notification.taskId && notification.reviewReason === 'design_failed';
}

export interface DesignFlowDeps {
  api: () => BotApi | undefined;
  router: Router;
  t: Translate;
  chatId: () => number | undefined;
  /** The "waits for your review" switch */
  enabled: () => boolean;
  taskTitle: (taskId: string, projectId?: string) => string;
  projectName?: (taskId: string, projectId?: string) => string | undefined;
  actions: DesignActions;
  onError?: (error: unknown) => void;
}

interface Entry {
  taskId: string;
  projectId?: string;
  /** The stage that waits for approval, or 'failed': the owner decides after the designer stopped */
  stage: DesignStage | 'failed';
  chatId: number;
  messageId?: number;
  text: Html;
  group: string;
  handledHere: boolean;
}

export function createDesignFlow(deps: DesignFlowDeps) {
  const { router, t } = deps;
  const h = htmlText(t);
  const entries = new Map<string, Entry>();
  let queue: Promise<void> = Promise.resolve();
  let counter = 0;

  const edit = async (entry: Entry, note: Html, buttons?: InlineButton[][]) => {
    if (entry.messageId === undefined) return;
    await deps.api()?.editMessageText(entry.chatId, entry.messageId, html`${entry.text}\n\n${note}`, buttons ? { buttons } : undefined);
  };

  const close = (entry: Entry) => {
    router.forgetGroup(entry.group);
    if (entries.get(entry.taskId) === entry) entries.delete(entry.taskId);
  };

  const stillWaits = (entry: Entry) =>
    entry.stage === 'failed' ? !!deps.actions.failure?.(entry.taskId, entry.projectId) : deps.actions.waiting(entry.taskId, entry.projectId)?.stage === entry.stage;

  const refuse = async (entry: Entry) => {
    close(entry);
    await edit(entry, h(entry.stage === 'failed' ? 'design.decisionGone' : 'design.noLongerWaiting'));
  };

  const failureButtons = (entry: Entry): InlineButton[][] => [
    [router.button(t('design.retry'), () => decide(entry, 'retry'), entry.group, 'success'), router.button(t('design.skip'), () => decide(entry, 'skip'), entry.group)],
  ];

  /** Try the design again / Build without design: the Design tab's functions, in the background */
  const decide = async (entry: Entry, choice: 'retry' | 'skip') => {
    router.forgetGroup(entry.group);
    if (!stillWaits(entry)) return refuse(entry);
    entry.handledHere = true;
    await edit(entry, h(choice === 'retry' ? 'design.retrying' : 'design.skipping'));
    void (async () => {
      let result: { success: boolean; error?: string };
      try {
        const action = choice === 'retry' ? deps.actions.retry : deps.actions.skip;
        result = action ? await action(entry.taskId, entry.projectId) : { success: false };
      } catch (error) {
        result = { success: false, error: error instanceof Error ? error.message : String(error) };
      }
      try {
        if (result.success) {
          close(entry);
          await edit(entry, h(choice === 'retry' ? 'design.retried' : 'design.skippedHere'));
        } else {
          entry.handledHere = false;
          await edit(entry, h('design.failed', { reason: result.error || t('review.unknownReason') }), failureButtons(entry));
        }
      } catch (error) {
        deps.onError?.(error);
      }
    })();
  };

  const buttons = (entry: Entry): InlineButton[][] => [
    [router.button(t('design.approve'), () => approve(entry), entry.group, 'success'), router.button(t('design.comment'), () => askComment(entry), entry.group)],
  ];

  const approve = async (entry: Entry) => {
    router.forgetGroup(entry.group);
    const stage = entry.stage;
    if (stage === 'failed' || !stillWaits(entry)) return refuse(entry);
    entry.handledHere = true;
    await edit(entry, h('design.approving'));
    // In the background: the approval renders QA's pictures and starts the task again
    void (async () => {
      let result: { success: boolean; error?: string };
      try {
        result = await deps.actions.approve(entry.taskId, stage, entry.projectId);
      } catch (error) {
        result = { success: false, error: error instanceof Error ? error.message : String(error) };
      }
      try {
        if (result.success) {
          close(entry);
          await edit(entry, h('design.approved'));
        } else {
          entry.handledHere = false;
          await edit(entry, h('design.failed', { reason: result.error || t('review.unknownReason') }), buttons(entry));
        }
      } catch (error) {
        deps.onError?.(error);
      }
    })();
  };

  const askComment = async (entry: Entry) => {
    if (!stillWaits(entry)) return refuse(entry);
    const api = deps.api();
    if (!api) return;
    const prompt = await api.sendMessage(entry.chatId, h('design.commentPrompt'), { forceReply: true, placeholder: t('design.commentPlaceholder') });
    router.awaitReply(prompt.message_id, async (text) => {
      const comment = text.trim();
      if (!comment) return;
      if (!stillWaits(entry)) return refuse(entry);
      entry.handledHere = true;
      router.forgetGroup(entry.group);
      const result = await deps.actions.comment(entry.taskId, comment, entry.projectId);
      if (result.success) {
        close(entry);
        await edit(entry, h('design.commented', { comment }));
      } else {
        entry.handledHere = false;
        await edit(entry, h('design.failed', { reason: result.error || t('review.unknownReason') }), buttons(entry));
      }
    });
  };

  const present = async (entry: Entry) => {
    const api = deps.api();
    if (!api) return;
    let photos: Buffer[] = [];
    try {
      photos = (await deps.actions.frames(entry.taskId, entry.projectId)).slice(0, MAX_ALBUM);
    } catch (error) {
      deps.onError?.(error);
    }
    const title = deps.taskTitle(entry.taskId, entry.projectId);
    try {
      if (photos.length === 1) await api.sendPhoto(entry.chatId, photos[0], title);
      else if (photos.length > 1) await api.sendMediaGroup(entry.chatId, photos, title);
    } catch (error) {
      // the message goes without them
      deps.onError?.(error);
    }
    if (entries.get(entry.taskId) !== entry) return;
    const sent = await api.sendMessage(entry.chatId, entry.text, { buttons: buttons(entry) });
    entry.messageId = sent.message_id;
  };

  return {
    /** The "design couldn't be made" notification, with the designer's error and the two buttons */
    async presentFailure(notification: Notification, chatId: number): Promise<void> {
      const api = deps.api();
      const taskId = notification.taskId;
      if (!api || !taskId) return;
      const failure = deps.actions.failure?.(taskId, notification.projectId);
      const text = failure?.error ? html`${notification.text}\n${h('design.failureError', { error: failure.error })}` : notification.text;
      const previous = entries.get(taskId);
      if (previous) close(previous);
      const entry: Entry = { taskId, projectId: notification.projectId, stage: 'failed', chatId, text, group: `design-failed:${taskId}:${++counter}`, handledHere: false };
      entries.set(taskId, entry);
      const sent = await api.sendMessage(chatId, text, { buttons: failureButtons(entry) });
      entry.messageId = sent.message_id;
    },
    /** Every status change of a task: a design that starts waiting is sent, one decided elsewhere closed */
    statusChanged(taskId: string, status: TaskStatus, reason?: ReviewReason, projectId?: string): void {
      const entry = entries.get(taskId);
      // The failure message is sent by the notifier (presentFailure); it stays while the task waits
      if (status === 'human_review' && reason === 'design_failed' && entry?.stage === 'failed') return;
      if (status === 'human_review' && reason === 'design_review') {
        const waiting = deps.actions.waiting(taskId, projectId);
        const chatId = deps.chatId();
        if (!waiting || (entry && entry.stage === waiting.stage) || !deps.enabled() || chatId === undefined) return;
        if (entry) close(entry);
        const project = deps.projectName?.(taskId, projectId);
        const text = joinHtml([
          project ? html`${h('design.waiting')} · ${project}` : h('design.waiting'),
          b(deps.taskTitle(taskId, projectId)),
          h(`design.stage.${waiting.stage}`),
        ]);
        const next: Entry = { taskId, projectId, stage: waiting.stage, chatId, text, group: `design:${taskId}:${++counter}`, handledHere: false };
        entries.set(taskId, next);
        queue = queue.then(() => present(next)).catch((error) => deps.onError?.(error));
        return;
      }
      if (!entry) return;
      close(entry);
      if (!entry.handledHere) void edit(entry, h('design.decidedOnComputer')).catch((error) => deps.onError?.(error));
    },
    /** Resolves when every queued album and message was sent (tests) */
    idle: () => queue,
    reset(): void {
      for (const entry of entries.values()) router.forgetGroup(entry.group);
      entries.clear();
    },
  };
}

export type DesignFlow = ReturnType<typeof createDesignFlow>;
