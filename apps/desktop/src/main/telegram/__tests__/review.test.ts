import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReviewReason, TaskStatus } from '../../../shared/types';
import type { BotApi } from '../bot-api';
import { botText } from '../i18n';
import { createPairing } from '../pairing';
import { createReviewFlow, type ReviewActions } from '../review';
import { createRouter } from '../router';
import { createTelegramSettingsStore } from '../settings-store';
import { createFakeBot, OWNER, pressUpdate, textUpdate } from './fake-bot';

const t = (k: string, v?: Record<string, string | number>) => botText('en', k, v);
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tg-review-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const settle = () => new Promise((r) => setTimeout(r, 0));

function setup(over: Partial<ReviewActions> = {}) {
  const bot = createFakeBot();
  const photos: Array<{ kind: 'photo' | 'album'; count: number; caption?: string }> = [];
  bot.api.sendPhoto = async (chatId, _photo, caption) => {
    photos.push({ kind: 'photo', count: 1, caption });
    return { message_id: 900, date: 0, chat: { id: chatId } };
  };
  bot.api.sendMediaGroup = async (_chatId, list, caption) => {
    photos.push({ kind: 'album', count: list.length, caption });
    return [];
  };
  const settings = createTelegramSettingsStore(dir);
  settings.update({ owner: OWNER });
  const router = createRouter({ api: () => bot.api, settings, pairing: createPairing(), t });
  const state: { status: TaskStatus; reviewReason?: ReviewReason } = { status: 'human_review', reviewReason: 'completed' };
  const actions: ReviewActions = {
    details: vi.fn(async () => ({ criteria: { passed: 2, total: 2 }, files: { files: 3, additions: 10, deletions: 1 } })),
    screenshots: vi.fn(async () => []),
    state: vi.fn(() => state),
    merge: vi.fn(async () => ({ kind: 'merged' as const })),
    sendBack: vi.fn(async () => ({ success: true })),
    ...over,
  };
  const errors: unknown[] = [];
  const flow = createReviewFlow({ api: () => bot.api as BotApi, router, t, actions, onError: (e) => void errors.push(e) });
  const notification = { kind: 'reviewWaiting' as const, text: t('notify.review', { task: 'Add login' }), taskId: 't1', projectId: 'p1', title: 'Add login', reviewReason: 'completed' as const };
  const present = async () => {
    await flow.present(notification, OWNER.chatId);
    return bot.last();
  };
  const press = async (messageId: number, label: string, rows = bot.sent.find((s) => s.messageId === messageId)?.options?.buttons) => {
    const lastEdit = [...bot.edits].reverse().find((e) => e.messageId === messageId);
    const buttons = (lastEdit ? lastEdit.buttons : rows) ?? [];
    const button = buttons.flat().find((b) => b.text === label);
    if (!button) throw new Error(`no button ${label}`);
    await router.handleBatch([pressUpdate(button.data, { messageId })]);
    await settle();
  };
  return { bot, router, flow, actions, state, photos, present, press, errors };
}

describe('review in the chat', () => {
  it('the review message: title, QA result, details and Merge / Send back / Later', async () => {
    const { present } = setup();
    const message = await present();
    expect(message.text).toContain('Waiting for your review: Add login');
    expect(message.text).toContain('QA approved it.');
    expect(message.text).toContain('Acceptance criteria: 2 of 2 pass');
    expect(message.text).toContain('Files changed: 3 (+10 −1)');
    expect(message.options?.buttons?.flat().map((b) => b.text)).toEqual([t('review.merge'), t('review.sendBack'), t('review.later')]);
  });

  it('Merge asks first, then runs the same merge as the app and says it merged', async () => {
    const { present, press, actions, bot } = setup();
    const message = await present();
    await press(message.messageId, t('review.merge'));
    expect(actions.merge).not.toHaveBeenCalled();
    expect(bot.edits.at(-1)?.text).toContain(t('review.confirmMerge'));
    await press(message.messageId, t('review.confirmYes'));
    expect(actions.merge).toHaveBeenCalledWith('t1', 'p1');
    expect(bot.edits.at(-1)?.text).toContain(t('review.merged'));
    expect(bot.edits.at(-1)?.buttons ?? []).toEqual([]);
  });

  it('Cancel on the confirmation brings the buttons back', async () => {
    const { present, press, actions, bot } = setup();
    const message = await present();
    await press(message.messageId, t('review.merge'));
    await press(message.messageId, t('review.confirmNo'));
    expect(actions.merge).not.toHaveBeenCalled();
    expect(bot.edits.at(-1)?.buttons?.flat().map((b) => b.text)).toEqual([t('review.merge'), t('review.sendBack'), t('review.later')]);
  });

  it('a merge that needs the owner on the computer, and a failed merge with its reason', async () => {
    const needs = setup({ merge: vi.fn(async () => ({ kind: 'needs_review' as const })) });
    let message = await needs.present();
    await needs.press(message.messageId, t('review.merge'));
    await needs.press(message.messageId, t('review.confirmYes'));
    expect(needs.bot.edits.at(-1)?.text).toContain(t('review.mergeNeedsReview'));

    const failed = setup({ merge: vi.fn(async () => ({ kind: 'failed' as const, message: 'Could not merge: a.ts' })) });
    message = await failed.present();
    await failed.press(message.messageId, t('review.merge'));
    await failed.press(message.messageId, t('review.confirmYes'));
    const edit = failed.bot.edits.at(-1);
    expect(edit?.text).toContain(t('review.mergeFailed', { reason: 'Could not merge: a.ts' }));
    // it can be tried again
    expect(edit?.buttons?.flat().map((b) => b.text)).toContain(t('review.merge'));
  });

  it('re-checks at press time that the task still waits for review', async () => {
    const { present, press, actions, state, bot } = setup();
    const message = await present();
    await press(message.messageId, t('review.merge'));
    state.status = 'done';
    state.reviewReason = undefined;
    await press(message.messageId, t('review.confirmYes'));
    expect(actions.merge).not.toHaveBeenCalled();
    expect(bot.edits.at(-1)?.text).toContain(t('review.noLongerWaiting'));
  });

  it('Send back asks for a comment and sends it the way the app does', async () => {
    const { present, press, actions, bot, router } = setup();
    const message = await present();
    await press(message.messageId, t('review.sendBack'));
    const prompt = bot.last();
    expect(prompt.options?.forceReply).toBe(true);
    await router.handleBatch([textUpdate('Make the button blue', { replyTo: prompt.messageId })]);
    expect(actions.sendBack).toHaveBeenCalledWith('t1', 'Make the button blue', 'p1');
    expect(bot.edits.at(-1)?.text).toContain(t('review.sentBack', { comment: 'Make the button blue' }));
  });

  it('Later removes the buttons', async () => {
    const { present, press, bot } = setup();
    const message = await present();
    await press(message.messageId, t('review.later'));
    expect(bot.edits.at(-1)).toMatchObject({ messageId: message.messageId, text: message.text });
    expect(bot.edits.at(-1)?.buttons ?? []).toEqual([]);
  });

  it('handled on the computer first: the message says so and its buttons expire', async () => {
    const { present, flow, bot, router } = setup();
    const message = await present();
    flow.statusChanged('t1', 'done');
    expect(bot.edits.at(-1)?.text).toContain(t('review.handledOnComputer'));
    const merge = message.options?.buttons?.flat()[0];
    await router.handleBatch([pressUpdate(merge?.data ?? '', { messageId: message.messageId })]);
    expect(bot.callbackAnswers.at(-1)?.text).toBe(t('expired'));
  });

  it('attaches the latest QA screenshots: one photo, or an album of up to 10', async () => {
    const one = setup({ screenshots: vi.fn(async () => [Buffer.from('a')]) });
    await one.present();
    expect(one.photos).toEqual([{ kind: 'photo', count: 1, caption: 'Add login' }]);
    const many = setup({ screenshots: vi.fn(async () => Array.from({ length: 12 }, () => Buffer.from('a'))) });
    await many.present();
    expect(many.photos).toEqual([{ kind: 'album', count: 10, caption: 'Add login' }]);
    // the review message still comes after them
    expect(many.bot.last().text).toContain('Waiting for your review');
  });

  it('screenshots that fail to send are skipped quietly', async () => {
    const { bot, present, photos, errors } = setup({ screenshots: vi.fn(async () => [Buffer.from('a'), Buffer.from('b')]) });
    bot.api.sendMediaGroup = async () => {
      throw new Error('too big');
    };
    const message = await present();
    expect(photos).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(message.text).toContain('Waiting for your review');
  });
});
