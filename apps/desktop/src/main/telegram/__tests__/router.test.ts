import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { botText } from '../i18n';
import { createPairing } from '../pairing';
import { BUTTON_TTL_MS, createRouter, STALE_MS } from '../router';
import { createTelegramSettingsStore } from '../settings-store';
import { createFakeBot, OWNER, pressUpdate, textUpdate } from './fake-bot';

let dir: string;
let clock: number;
const now = () => clock;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tg-router-'));
  clock = Date.now();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(paired = true) {
  const bot = createFakeBot();
  const settings = createTelegramSettingsStore(dir);
  if (paired) settings.update({ owner: OWNER });
  const pairing = createPairing({ now });
  const onPaired = vi.fn();
  const router = createRouter({ api: () => bot.api, settings, pairing, t: (k, v) => botText('en', k, v), now, onPaired });
  return { bot, settings, pairing, router, onPaired };
}

describe('pairing', () => {
  it('/start with the valid code records the sender as the owner and greets them', async () => {
    const { bot, settings, pairing, router, onPaired } = setup(false);
    const { code } = pairing.issue();
    await router.handleBatch([textUpdate(`/start ${code}`, { from: 77 })]);
    expect(settings.get().owner).toMatchObject({ userId: 77, chatId: 77 });
    expect(onPaired).toHaveBeenCalled();
    expect(bot.last().text).toBe(botText('en', 'paired'));
    // The code works once
    expect(pairing.current()).toBeUndefined();
  });

  it('ignores a wrong or expired code silently', async () => {
    const { bot, settings, pairing, router } = setup(false);
    const { code } = pairing.issue();
    await router.handleBatch([textUpdate('/start WRONG123', { from: 77 })]);
    clock += 11 * 60_000;
    await router.handleBatch([textUpdate(`/start ${code}`, { from: 77 })]);
    expect(settings.get().owner).toBeUndefined();
    expect(bot.sent).toEqual([]);
  });

  it('ignores everyone but the owner, without a reply', async () => {
    const { bot, router } = setup();
    const handler = vi.fn();
    router.command('help', handler);
    await router.handleBatch([textUpdate('/help', { from: 99 }), pressUpdate('abc', { from: 99 })]);
    expect(handler).not.toHaveBeenCalled();
    expect(bot.sent).toEqual([]);
    expect(bot.callbackAnswers).toEqual([]);
  });

  it('ignores the owner writing from a group chat', async () => {
    const { bot, router } = setup();
    const handler = vi.fn();
    router.command('help', handler);
    await router.handleBatch([textUpdate('/help', { chat: -500 })]);
    expect(handler).not.toHaveBeenCalled();
    expect(bot.sent).toEqual([]);
  });
});

describe('commands', () => {
  it('routes /cmd and /cmd@bot with arguments', async () => {
    const { router } = setup();
    const handler = vi.fn(async () => undefined);
    router.command('status', handler);
    await router.handleBatch([textUpdate('/status'), textUpdate('/status@test_bot now')]);
    expect(handler).toHaveBeenCalledTimes(2);
    expect((handler.mock.calls[1] as unknown[])[0]).toMatchObject({ args: 'now', chatId: OWNER.chatId });
  });

  it('answers an unknown command and plain text with a hint', async () => {
    const { bot, router } = setup();
    await router.handleBatch([textUpdate('/nope'), textUpdate('hello')]);
    expect(bot.sent.map((s) => s.text)).toEqual([botText('en', 'unknown'), botText('en', 'unknown')]);
  });

  it('drops commands older than 15 minutes and tells the owner once what was skipped', async () => {
    const { bot, router } = setup();
    const handler = vi.fn();
    router.command('status', handler);
    router.command('stop_all', handler);
    const old = Math.floor((clock - STALE_MS - 1000) / 1000);
    await router.handleBatch([textUpdate('/status', { date: old }), textUpdate('/stop_all', { date: old })]);
    expect(handler).not.toHaveBeenCalled();
    expect(bot.sent).toHaveLength(1);
    expect(bot.sent[0].text).toContain('/status, /stop_all');
  });
});

describe('buttons', () => {
  it('maps a short id to an action and answers the press', async () => {
    const { bot, router } = setup();
    const action = vi.fn(async () => 'ok!');
    const button = router.button('Go', action);
    expect(Buffer.byteLength(button.data)).toBeLessThanOrEqual(64);
    await router.handleBatch([pressUpdate(button.data, { messageId: 5 })]);
    expect(action).toHaveBeenCalledWith(expect.objectContaining({ chatId: OWNER.chatId, messageId: 5 }));
    expect(bot.callbackAnswers).toEqual([{ id: expect.any(String), text: 'ok!' }]);
  });

  it('a button can carry a colour style', () => {
    const { router } = setup();
    expect(router.button('Stop', vi.fn(), 'g', 'danger').style).toBe('danger');
    expect(router.button('Go', vi.fn())).not.toHaveProperty('style');
  });

  it('expires buttons after 12 hours, and unknown ids (from before a restart)', async () => {
    const { bot, router } = setup();
    const action = vi.fn();
    const button = router.button('Go', action);
    clock += BUTTON_TTL_MS + 1;
    await router.handleBatch([pressUpdate(button.data), pressUpdate('unknown1')]);
    expect(action).not.toHaveBeenCalled();
    expect(bot.callbackAnswers.map((a) => a.text)).toEqual([botText('en', 'expired'), botText('en', 'expired')]);
  });

  it('drops presses in the first batch after the bot could not read the chat for over 15 minutes', async () => {
    const { bot, router } = setup();
    const action = vi.fn();
    const button = router.button('Go', action);
    await router.handleBatch([pressUpdate(button.data)], { offlineForMs: STALE_MS + 1 });
    expect(action).not.toHaveBeenCalled();
    expect(bot.sent[0].text).toContain('1 button press');
  });

  it('forgets a group of buttons together', async () => {
    const { router } = setup();
    const action = vi.fn();
    const a = router.button('A', action, 'g1');
    router.forgetGroup('g1');
    await router.handleBatch([pressUpdate(a.data)]);
    expect(action).not.toHaveBeenCalled();
  });
});

describe('force-reply answers', () => {
  it('sends a reply to the waiting handler once', async () => {
    const { router } = setup();
    const handler = vi.fn(async () => undefined);
    router.awaitReply(500, handler);
    await router.handleBatch([textUpdate('my answer', { replyTo: 500 })]);
    expect(handler).toHaveBeenCalledWith('my answer', expect.objectContaining({ chatId: OWNER.chatId }));
    await router.handleBatch([textUpdate('again', { replyTo: 500 })]);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
