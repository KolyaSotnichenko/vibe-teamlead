import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTelegramSettingsStore, DEFAULT_DIGEST, DEFAULT_NOTIFICATIONS } from '../settings-store';
import { createTokenStore } from '../token-store';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tg-store-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const crypto = {
  encrypt: (text: string) => `enc:${Buffer.from(text).toString('base64')}`,
  decrypt: (text: string) => (text.startsWith('enc:') ? Buffer.from(text.slice(4), 'base64').toString() : ''),
};

describe('token store', () => {
  it('saves the token encrypted, loads and clears it', () => {
    const store = createTokenStore(dir, crypto);
    expect(store.load()).toBeUndefined();
    store.save('  123:ABC  ');
    const raw = readFileSync(join(dir, 'telegram-token.json'), 'utf-8');
    expect(raw).not.toContain('123:ABC');
    expect(store.load()).toBe('123:ABC');
    store.clear();
    expect(store.load()).toBeUndefined();
    expect(existsSync(join(dir, 'telegram-token.json'))).toBe(false);
  });

  it('keeps an unreadable file aside instead of losing it', () => {
    writeFileSync(join(dir, 'telegram-token.json'), 'garbage');
    const store = createTokenStore(dir, crypto);
    expect(store.load()).toBeUndefined();
    store.save('9:Z');
    expect(readFileSync(join(dir, 'telegram-token.json.unreadable'), 'utf-8')).toBe('garbage');
    expect(store.load()).toBe('9:Z');
  });

  it('refuses an empty token', () => {
    expect(() => createTokenStore(dir, crypto).save('  ')).toThrow();
  });
});

describe('telegram settings store', () => {
  it('starts with no owner and every notification on', () => {
    const store = createTelegramSettingsStore(dir);
    expect(store.get()).toEqual({ notifications: DEFAULT_NOTIFICATIONS, digest: DEFAULT_DIGEST });
    expect(DEFAULT_DIGEST).toEqual({ enabled: true, time: '09:00' });
    expect(Object.values(DEFAULT_NOTIFICATIONS).every(Boolean)).toBe(true);
  });

  it('records and forgets the owner, keeps switches and the current project', () => {
    const store = createTelegramSettingsStore(dir);
    store.update({ owner: { userId: 1, chatId: 2, name: 'Nick' } });
    store.update({ notifications: { ...DEFAULT_NOTIFICATIONS, taskMerged: false }, currentProjectId: 'p1' });
    const again = createTelegramSettingsStore(dir).get();
    expect(again.owner).toEqual({ userId: 1, chatId: 2, name: 'Nick' });
    expect(again.notifications.taskMerged).toBe(false);
    expect(again.currentProjectId).toBe('p1');
    store.update({ owner: undefined });
    expect(createTelegramSettingsStore(dir).get().owner).toBeUndefined();
  });

  it('fills switches added later with their defaults', () => {
    writeFileSync(join(dir, 'telegram.json'), JSON.stringify({ notifications: { agentQuestion: false } }));
    const got = createTelegramSettingsStore(dir).get();
    expect(got.notifications.agentQuestion).toBe(false);
    expect(got.notifications.ciFailed).toBe(true);
  });

  it('keeps the morning digest settings and the last sent date; a bad time falls back to 09:00', () => {
    const store = createTelegramSettingsStore(dir);
    store.update({ digest: { enabled: false, time: '07:30', lastSentDate: '2026-11-16', lastSentAt: 1000 } });
    expect(createTelegramSettingsStore(dir).get().digest).toEqual({ enabled: false, time: '07:30', lastSentDate: '2026-11-16', lastSentAt: 1000 });
    writeFileSync(join(dir, 'telegram.json'), JSON.stringify({ digest: { enabled: 'yes', time: '25:00', lastSentDate: 'x' } }));
    expect(createTelegramSettingsStore(dir).get().digest).toEqual(DEFAULT_DIGEST);
  });
});
