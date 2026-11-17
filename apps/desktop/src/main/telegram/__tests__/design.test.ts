import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDesignFlow, type DesignActions } from '../design';
import { botText } from '../i18n';
import { createPairing } from '../pairing';
import { createRouter } from '../router';
import { createTelegramSettingsStore } from '../settings-store';
import { createFakeBot, OWNER, pressUpdate, textUpdate } from './fake-bot';

const t = (k: string, v?: Record<string, string | number>) => botText('en', k, v);
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tg-design-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const settle = () => new Promise((r) => setTimeout(r, 0));

function setup(over: Partial<DesignActions> = {}, enabled = true) {
  const bot = createFakeBot();
  const albums: Array<{ count: number; caption?: string }> = [];
  bot.api.sendMediaGroup = async (_c, list, caption) => {
    albums.push({ count: list.length, caption: caption && String(caption) });
    return [];
  };
  bot.api.sendPhoto = async (chatId, _p, caption) => {
    albums.push({ count: 1, caption: caption && String(caption) });
    return { message_id: 900, date: 0, chat: { id: chatId } };
  };
  const settings = createTelegramSettingsStore(dir);
  settings.update({ owner: OWNER });
  const router = createRouter({ api: () => bot.api, settings, pairing: createPairing(), t });
  const waiting: { stage?: 'wireframes' | 'design' } = { stage: 'wireframes' };
  const actions: DesignActions = {
    waiting: vi.fn(() => (waiting.stage ? { stage: waiting.stage } : undefined)),
    frames: vi.fn(async () => [Buffer.from('a'), Buffer.from('b')]),
    approve: vi.fn(async () => ({ success: true })),
    comment: vi.fn(async () => ({ success: true })),
    ...over,
  };
  const flow = createDesignFlow({
    api: () => bot.api,
    router,
    t,
    chatId: () => OWNER.chatId,
    enabled: () => enabled,
    taskTitle: () => 'Checkout page',
    actions,
  });
  const press = async (messageId: number, label: string) => {
    const lastEdit = [...bot.edits].reverse().find((e) => e.messageId === messageId);
    const rows = lastEdit ? lastEdit.buttons : bot.sent.find((s) => s.messageId === messageId)?.options?.buttons;
    const button = (rows ?? []).flat().find((b) => b.text === label);
    if (!button) throw new Error(`no button ${label}`);
    await router.handleBatch([pressUpdate(button.data, { messageId })]);
    await settle();
  };
  const waitsNow = async () => {
    flow.statusChanged('t1', 'human_review', 'design_review', 'p1');
    await flow.idle();
    return bot.last();
  };
  return { bot, router, flow, actions, waiting, albums, press, waitsNow };
}

describe('design approval in the chat', () => {
  it('the screens come as an album, then a message with Approve / Comment', async () => {
    const { waitsNow, albums } = setup();
    const message = await waitsNow();
    expect(albums).toEqual([{ count: 2, caption: 'Checkout page' }]);
    expect(message.text).toBe('🎨 <b>The design waits for your approval</b>\n<b>Checkout page</b>\nStage: wireframes');
    expect(message.options?.buttons?.flat().map((b) => [b.text, b.style])).toEqual([
      [t('design.approve'), 'success'],
      [t('design.comment'), undefined],
    ]);
  });

  it('is sent once per stage, and not at all when switched off', async () => {
    const { waitsNow, flow, bot, waiting } = setup();
    await waitsNow();
    await waitsNow();
    expect(bot.sent).toHaveLength(1);
    waiting.stage = 'design';
    flow.statusChanged('t1', 'in_progress');
    await waitsNow();
    expect(bot.sent).toHaveLength(2);
    const off = setup({}, false);
    await off.waitsNow();
    expect(off.bot.sent).toHaveLength(0);
  });

  it('not when the designer approves its own work (nothing waits for the owner)', async () => {
    const { waitsNow, bot, waiting } = setup();
    waiting.stage = undefined;
    await waitsNow();
    expect(bot.sent).toHaveLength(0);
  });

  it('Approve runs the app\'s approval for the waiting stage', async () => {
    const { waitsNow, press, actions, bot } = setup();
    const message = await waitsNow();
    await press(message.messageId, t('design.approve'));
    expect(actions.approve).toHaveBeenCalledWith('t1', 'wireframes', 'p1');
    expect(bot.edits.at(-1)?.text).toContain(t('design.approved'));
  });

  it('Approve after the stage changed on the computer is refused', async () => {
    const { waitsNow, press, actions, bot, waiting } = setup();
    const message = await waitsNow();
    waiting.stage = undefined;
    await press(message.messageId, t('design.approve'));
    expect(actions.approve).not.toHaveBeenCalled();
    expect(bot.edits.at(-1)?.text).toContain(t('design.noLongerWaiting'));
  });

  it('Comment asks for the text and sends it to the designer like the Design tab', async () => {
    const { waitsNow, press, actions, bot, router } = setup();
    const message = await waitsNow();
    await press(message.messageId, t('design.comment'));
    const prompt = bot.last();
    expect(prompt.options?.forceReply).toBe(true);
    await router.handleBatch([textUpdate('Bigger buttons', { replyTo: prompt.messageId })]);
    expect(actions.comment).toHaveBeenCalledWith('t1', 'Bigger buttons', 'p1');
    expect(bot.edits.at(-1)?.text).toContain(t('design.commented', { comment: 'Bigger buttons' }));
  });

  it('decided on the computer first: the message is edited and its buttons expire', async () => {
    const { waitsNow, flow, bot, router } = setup();
    const message = await waitsNow();
    flow.statusChanged('t1', 'in_progress');
    expect(bot.edits.at(-1)).toMatchObject({ messageId: message.messageId });
    expect(bot.edits.at(-1)?.text).toContain(t('design.decidedOnComputer'));
    const approve = message.options?.buttons?.flat()[0];
    await router.handleBatch([pressUpdate(approve?.data ?? '', { messageId: message.messageId })]);
    expect(bot.callbackAnswers.at(-1)?.text).toBe(t('expired'));
  });

  it('no pictures: the message alone', async () => {
    const { waitsNow, albums } = setup({ frames: vi.fn(async () => []) });
    const message = await waitsNow();
    expect(albums).toEqual([]);
    expect(message.text).toContain(t('design.waiting', { task: 'Checkout page' }));
  });
});
