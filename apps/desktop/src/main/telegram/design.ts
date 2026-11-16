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
 */

import type { ReviewReason, TaskStatus } from '../../shared/types';
import type { BotApi, InlineButton } from './bot-api';
import type { Translate } from './i18n';
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
  stage: DesignStage;
  chatId: number;
  messageId?: number;
  text: string;
  group: string;
  handledHere: boolean;
}

export function createDesignFlow(deps: DesignFlowDeps) {
  const { router, t } = deps;
  const entries = new Map<string, Entry>();
  let queue: Promise<void> = Promise.resolve();
  let counter = 0;

  const edit = async (entry: Entry, note: string, buttons?: InlineButton[][]) => {
    if (entry.messageId === undefined) return;
    await deps.api()?.editMessageText(entry.chatId, entry.messageId, `${entry.text}\n\n${note}`, buttons ? { buttons } : undefined);
  };

  const close = (entry: Entry) => {
    router.forgetGroup(entry.group);
    if (entries.get(entry.taskId) === entry) entries.delete(entry.taskId);
  };

  const stillWaits = (entry: Entry) => deps.actions.waiting(entry.taskId, entry.projectId)?.stage === entry.stage;

  const refuse = async (entry: Entry) => {
    close(entry);
    await edit(entry, t('design.noLongerWaiting'));
  };

  const buttons = (entry: Entry): InlineButton[][] => [
    [router.button(t('design.approve'), () => approve(entry), entry.group), router.button(t('design.comment'), () => askComment(entry), entry.group)],
  ];

  const approve = async (entry: Entry) => {
    router.forgetGroup(entry.group);
    if (!stillWaits(entry)) return refuse(entry);
    entry.handledHere = true;
    await edit(entry, t('design.approving'));
    // In the background: the approval renders QA's pictures and starts the task again
    void (async () => {
      let result: { success: boolean; error?: string };
      try {
        result = await deps.actions.approve(entry.taskId, entry.stage, entry.projectId);
      } catch (error) {
        result = { success: false, error: error instanceof Error ? error.message : String(error) };
      }
      try {
        if (result.success) {
          close(entry);
          await edit(entry, t('design.approved'));
        } else {
          entry.handledHere = false;
          await edit(entry, t('design.failed', { reason: result.error || t('review.unknownReason') }), buttons(entry));
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
    const prompt = await api.sendMessage(entry.chatId, t('design.commentPrompt'), { forceReply: true, placeholder: t('design.commentPlaceholder') });
    router.awaitReply(prompt.message_id, async (text) => {
      const comment = text.trim();
      if (!comment) return;
      if (!stillWaits(entry)) return refuse(entry);
      entry.handledHere = true;
      router.forgetGroup(entry.group);
      const result = await deps.actions.comment(entry.taskId, comment, entry.projectId);
      if (result.success) {
        close(entry);
        await edit(entry, t('design.commented', { comment }));
      } else {
        entry.handledHere = false;
        await edit(entry, t('design.failed', { reason: result.error || t('review.unknownReason') }), buttons(entry));
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
    /** Every status change of a task: a design that starts waiting is sent, one decided elsewhere closed */
    statusChanged(taskId: string, status: TaskStatus, reason?: ReviewReason, projectId?: string): void {
      const entry = entries.get(taskId);
      if (status === 'human_review' && reason === 'design_review') {
        const waiting = deps.actions.waiting(taskId, projectId);
        const chatId = deps.chatId();
        if (!waiting || (entry && entry.stage === waiting.stage) || !deps.enabled() || chatId === undefined) return;
        if (entry) close(entry);
        const project = deps.projectName?.(taskId, projectId);
        const text = [
          t('design.waiting', { task: deps.taskTitle(taskId, projectId) }),
          t(`design.stage.${waiting.stage}`),
          ...(project ? [t('notify.inProject', { project })] : []),
        ].join('\n');
        const next: Entry = { taskId, projectId, stage: waiting.stage, chatId, text, group: `design:${taskId}:${++counter}`, handledHere: false };
        entries.set(taskId, next);
        queue = queue.then(() => present(next)).catch((error) => deps.onError?.(error));
        return;
      }
      if (!entry) return;
      close(entry);
      if (!entry.handledHere) void edit(entry, t('design.decidedOnComputer')).catch((error) => deps.onError?.(error));
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
