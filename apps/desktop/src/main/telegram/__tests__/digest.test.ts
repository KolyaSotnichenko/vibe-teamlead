import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Task } from '../../../shared/types';
import { buildDigest, createDigest, digestDue, localDate } from '../digest';
import { botText } from '../i18n';
import { createTelegramSettingsStore } from '../settings-store';
import { createFakeBot, OWNER } from './fake-bot';

const t = (k: string, v?: Record<string, string | number>) => botText('en', k, v);
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tg-digest-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** 2026-11-16 at hh:mm, local time */
const at = (hh: number, mm = 0, day = 16) => new Date(2026, 10, day, hh, mm).getTime();
const task = (id: string, status: Task['status'], over: Partial<Task> = {}) =>
  ({ id, title: `Task ${id}`, status, updatedAt: new Date(at(8)), ...over }) as Task;

describe('digestDue', () => {
  it('is due from the set time on, once a local day', () => {
    const digest = { enabled: true, time: '09:00' };
    expect(digestDue(digest, at(8, 59))).toBe(false);
    expect(digestDue(digest, at(9, 0))).toBe(true);
    // the app was closed at 9: sent at the next start the same day
    expect(digestDue(digest, at(17, 30))).toBe(true);
    expect(digestDue({ ...digest, lastSentDate: localDate(at(9)) }, at(17, 30))).toBe(false);
    expect(digestDue({ ...digest, lastSentDate: localDate(at(9, 0, 15)) }, at(9, 1))).toBe(true);
    expect(digestDue({ ...digest, enabled: false }, at(10))).toBe(false);
  });
});

describe('buildDigest', () => {
  it('tells what merged, waits, runs, failed and what it cost since the last digest', () => {
    const text = buildDigest(
      {
        projects: [{ id: 'p1', name: 'Shop & <Co>' }],
        tasks: () => [
          task('m1', 'done', { updatedAt: new Date(at(7)) }),
          task('m0', 'done', { updatedAt: new Date(at(1, 0, 14)) }),
          task('w1', 'human_review', { reviewReason: 'completed' }),
          task('w2', 'human_review', { reviewReason: 'design_review' }),
          task('s1', 'human_review', { reviewReason: 'stopped' }),
          task('r1', 'in_progress'),
          task('q1', 'queue'),
          task('f1', 'error'),
          task('f2', 'human_review', { reviewReason: 'errors' }),
          task('a1', 'done', { metadata: { archivedAt: 'x' } as never }),
        ],
        since: at(9, 0, 15),
        usage: { usd: 4.5, tokens: 10 },
      },
      t,
    ).value;
    expect(text).toMatch(/^☀️ <b>Good morning\.<\/b> Since the last digest:\n\n<b>Shop &amp; &lt;Co&gt;<\/b>\n✅ Merged: Task m1\n/);
    expect(text).not.toContain('Task m0');
    expect(text).toContain('Waiting for you: Task w1, Task w2');
    expect(text).toContain('Running: Task r1');
    expect(text).toContain('Queued: Task q1');
    expect(text).toContain('Failed: Task f1, Task f2');
    expect(text).toMatch(/\n\n💰 Spend since the last digest: <b>\$4\.50<\/b>$/);
    expect(text).not.toContain('Task a1');
  });

  it('says when nothing happened', () => {
    const text = buildDigest({ projects: [{ id: 'p1', name: 'Shop' }], tasks: () => [], since: 0, usage: { usd: 0, tokens: 0 } }, t).value;
    expect(text).toContain(t('digest.quiet'));
  });
});

describe('the digest timer', () => {
  function setup(now: { value: number }) {
    const bot = createFakeBot();
    const settings = createTelegramSettingsStore(dir);
    settings.update({ owner: OWNER });
    const usageSince = vi.fn(async () => ({ usd: 1, tokens: 5 }));
    const digest = createDigest({
      api: () => bot.api,
      settings,
      t,
      now: () => now.value,
      projects: () => [{ id: 'p1', name: 'Shop' }],
      tasks: () => [],
      usageSince,
    });
    return { bot, settings, digest, usageSince };
  }

  it('sends once a day after the set time and remembers the date in the settings file', async () => {
    const now = { value: at(8) };
    const { bot, settings, digest, usageSince } = setup(now);
    await digest.check();
    expect(bot.sent).toHaveLength(0);
    now.value = at(9, 1);
    await digest.check();
    await digest.check();
    expect(bot.sent).toHaveLength(1);
    expect(createTelegramSettingsStore(dir).get().digest).toMatchObject({ lastSentDate: localDate(at(9)), lastSentAt: at(9, 1) });
    // the first digest looks back a day
    expect(usageSince).toHaveBeenCalledWith(at(9, 1) - 24 * 60 * 60_000, at(9, 1));
    now.value = at(9, 5, 17);
    await digest.check();
    expect(bot.sent).toHaveLength(2);
    expect(usageSince).toHaveBeenLastCalledWith(at(9, 1), at(9, 5, 17));
    expect(settings.get().digest.lastSentDate).toBe(localDate(at(9, 0, 17)));
  });

  it('two checks at once send one digest', async () => {
    const now = { value: at(10) };
    const { bot, digest } = setup(now);
    await Promise.all([digest.check(), digest.check()]);
    expect(bot.sent).toHaveLength(1);
  });

  it('tries again later when sending failed', async () => {
    const now = { value: at(10) };
    const { bot, digest, settings } = setup(now);
    const send = bot.api.sendMessage;
    bot.api.sendMessage = async () => {
      throw new Error('offline');
    };
    await digest.check();
    expect(settings.get().digest.lastSentDate).toBeUndefined();
    bot.api.sendMessage = send;
    await digest.check();
    expect(bot.sent).toHaveLength(1);
  });

  it('sends nothing when off or not paired', async () => {
    const now = { value: at(10) };
    const { bot, digest, settings } = setup(now);
    settings.update({ digest: { enabled: false, time: '09:00' } });
    await digest.check();
    settings.update({ digest: { enabled: true, time: '09:00' }, owner: undefined });
    await digest.check();
    expect(bot.sent).toHaveLength(0);
  });
});
