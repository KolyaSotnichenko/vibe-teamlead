/**
 * Review from the chat (design item 3). The "waits for your review" notification becomes the
 * review message: title, QA result, criteria covered, app checks, files changed, a diff link,
 * the QA browser's latest screenshots before it, and the buttons:
 *
 * - Merge → "Are you sure?" → the same merge as the app's Merge button. Whether the task still
 *   waits for review is checked again at the press. The merge runs in the background (it can take
 *   minutes; the chat keeps working) and the message ends with its result.
 * - Send back → a force-reply for the instruction → the app's "send back with an instruction".
 * - Later → the buttons go; the task waits on the board.
 *
 * Handled on the computer first → the message says so and its buttons expire.
 */

import type { ReviewReason, TaskStatus } from '../../shared/types';
import type { BotApi, InlineButton } from './bot-api';
import { type Html, html, htmlText, joinHtml } from './format';
import type { Translate } from './i18n';
import type { Notification } from './notifier';
import { type ReviewDetails, reviewLines } from './review-details';
import type { Router } from './router';

export type MergeOutcome = { kind: 'merged' | 'needs_review' | 'failed'; message?: string };

export interface ReviewActions {
  details: (taskId: string, projectId?: string) => Promise<ReviewDetails>;
  /** The latest preview (QA browser) screenshots, ready to send; none for a task without UI */
  screenshots: (taskId: string, projectId?: string) => Promise<Buffer[]>;
  state: (taskId: string, projectId?: string) => { status: TaskStatus; reviewReason?: ReviewReason } | undefined;
  merge: (taskId: string, projectId?: string) => Promise<MergeOutcome>;
  sendBack: (taskId: string, comment: string, projectId?: string) => Promise<{ success: boolean; error?: string }>;
}

export interface ReviewFlowDeps {
  api: () => BotApi | undefined;
  router: Router;
  t: Translate;
  actions: ReviewActions;
  onError?: (error: unknown) => void;
}

/** Telegram takes 2–10 photos in an album */
export const MAX_ALBUM = 10;

interface Entry {
  taskId: string;
  projectId?: string;
  chatId: number;
  messageId: number;
  text: Html;
  group: string;
  /** A Merge or Send back from the chat is under way or done: no "handled on the computer" */
  handledHere: boolean;
}

const WAITING = new Set<ReviewReason | undefined>(['completed', 'qa_rejected']);

export function createReviewFlow(deps: ReviewFlowDeps) {
  const { router, t } = deps;
  const h = htmlText(t);
  const entries = new Map<string, Entry>();
  let counter = 0;

  const waits = (entry: Entry) => {
    const state = deps.actions.state(entry.taskId, entry.projectId);
    return state?.status === 'human_review' && WAITING.has(state.reviewReason);
  };

  const current = (entry: Entry) => entries.get(entry.taskId) === entry;

  const edit = async (entry: Entry, note: Html | undefined, buttons?: InlineButton[][]) => {
    await deps.api()?.editMessageText(entry.chatId, entry.messageId, note ? html`${entry.text}\n\n${note}` : entry.text, buttons ? { buttons } : undefined);
  };

  const close = (entry: Entry) => {
    router.forgetGroup(entry.group);
    if (current(entry)) entries.delete(entry.taskId);
  };

  const noLongerWaiting = async (entry: Entry) => {
    close(entry);
    await edit(entry, h('review.noLongerWaiting'));
  };

  const mainButtons = (entry: Entry): InlineButton[][] => [
    [router.button(t('review.merge'), () => askMerge(entry), entry.group, 'success'), router.button(t('review.sendBack'), () => askComment(entry), entry.group)],
    [router.button(t('review.later'), () => later(entry), entry.group)],
  ];

  const askMerge = async (entry: Entry) => {
    router.forgetGroup(entry.group);
    if (!waits(entry)) return noLongerWaiting(entry);
    await edit(entry, h('review.confirmMerge'), [
      [router.button(t('review.confirmYes'), () => merge(entry), entry.group, 'success'), router.button(t('review.confirmNo'), () => cancel(entry), entry.group)],
    ]);
  };

  const cancel = async (entry: Entry) => {
    router.forgetGroup(entry.group);
    await edit(entry, undefined, mainButtons(entry));
  };

  const merge = async (entry: Entry) => {
    router.forgetGroup(entry.group);
    if (!waits(entry)) return noLongerWaiting(entry);
    entry.handledHere = true;
    await deps.api()?.sendChatAction(entry.chatId, 'typing').catch(() => undefined);
    await edit(entry, h('review.merging'));
    // In the background: a merge can take minutes, and the chat must keep working meanwhile
    void (async () => {
      let outcome: MergeOutcome;
      try {
        outcome = await deps.actions.merge(entry.taskId, entry.projectId);
      } catch (error) {
        outcome = { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
      }
      try {
        if (outcome.kind === 'merged') {
          close(entry);
          await edit(entry, h('review.merged'));
        } else if (outcome.kind === 'needs_review') {
          close(entry);
          await edit(entry, h('review.mergeNeedsReview'));
        } else {
          entry.handledHere = false;
          await edit(entry, h('review.mergeFailed', { reason: outcome.message || t('review.unknownReason') }), mainButtons(entry));
        }
      } catch (error) {
        deps.onError?.(error);
      }
    })();
  };

  const askComment = async (entry: Entry) => {
    if (!waits(entry)) return noLongerWaiting(entry);
    const api = deps.api();
    if (!api) return;
    const prompt = await api.sendMessage(entry.chatId, h('review.commentPrompt'), { forceReply: true, placeholder: t('review.commentPlaceholder') });
    router.awaitReply(prompt.message_id, async (text) => {
      const comment = text.trim();
      if (!comment) return;
      if (!waits(entry)) return noLongerWaiting(entry);
      entry.handledHere = true;
      router.forgetGroup(entry.group);
      const result = await deps.actions.sendBack(entry.taskId, comment, entry.projectId);
      if (result.success) {
        close(entry);
        await edit(entry, h('review.sentBack', { comment }));
      } else {
        entry.handledHere = false;
        await edit(entry, h('review.sendBackFailed', { reason: result.error || t('review.unknownReason') }), mainButtons(entry));
      }
    });
  };

  const later = async (entry: Entry) => {
    close(entry);
    await edit(entry, undefined);
  };

  const sendPhotos = async (api: BotApi, chatId: number, photos: Buffer[], caption: string | undefined) => {
    if (!photos.length) return;
    try {
      if (photos.length === 1) await api.sendPhoto(chatId, photos[0], caption);
      else await api.sendMediaGroup(chatId, photos.slice(0, MAX_ALBUM), caption);
    } catch (error) {
      // the review message goes without them
      deps.onError?.(error);
    }
  };

  return {
    /** Sends the review message for a "waits for your review" notification */
    async present(notification: Notification, chatId: number): Promise<void> {
      const api = deps.api();
      const taskId = notification.taskId;
      if (!api || !taskId) return;
      const [details, photos] = await Promise.all([
        deps.actions.details(taskId, notification.projectId).catch(() => ({}) as ReviewDetails),
        deps.actions.screenshots(taskId, notification.projectId).catch(() => [] as Buffer[]),
      ]);
      await sendPhotos(api, chatId, photos, notification.title);
      const lines = reviewLines(details, t);
      const text = lines.length ? html`${notification.text}\n\n${joinHtml(lines)}` : notification.text;
      const previous = entries.get(taskId);
      if (previous) router.forgetGroup(previous.group);
      const entry: Entry = { taskId, projectId: notification.projectId, chatId, messageId: 0, text, group: `review:${taskId}:${++counter}`, handledHere: false };
      const sent = await api.sendMessage(chatId, text, { buttons: mainButtons(entry) });
      entry.messageId = sent.message_id;
      entries.set(taskId, entry);
    },
    /** A task's status changed: a review it left (on the computer) is closed in the chat */
    statusChanged(taskId: string, status: TaskStatus, reason?: ReviewReason): void {
      const entry = entries.get(taskId);
      if (!entry || (status === 'human_review' && WAITING.has(reason))) return;
      close(entry);
      if (entry.handledHere) return;
      void edit(entry, h('review.handledOnComputer')).catch((error) => deps.onError?.(error));
    },
    reset(): void {
      for (const entry of entries.values()) router.forgetGroup(entry.group);
      entries.clear();
    },
  };
}

export type ReviewFlow = ReturnType<typeof createReviewFlow>;
