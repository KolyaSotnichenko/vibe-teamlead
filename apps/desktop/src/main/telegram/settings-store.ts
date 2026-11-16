/**
 * The bot's settings: the paired owner, the notification switches and the project later
 * commands act on. Kept in `<userData>/telegram.json`, apart from settings.json, which the
 * window saves as a whole (a save from an open Settings dialog would otherwise drop a pairing
 * made from the phone). Written atomically.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { TelegramNotificationSettings, TelegramOwner } from '../../shared/types/telegram';

export const SETTINGS_FILE = 'telegram.json';

export const DEFAULT_NOTIFICATIONS: TelegramNotificationSettings = {
  agentQuestion: true,
  reviewWaiting: true,
  taskFailed: true,
  ciFailed: true,
  taskMerged: true,
  regression: true,
};

export interface TelegramSettings {
  owner?: TelegramOwner;
  notifications: TelegramNotificationSettings;
  /** The project `/project` chose for later commands */
  currentProjectId?: string;
}

export interface TelegramSettingsStore {
  get(): TelegramSettings;
  update(patch: Partial<TelegramSettings>): TelegramSettings;
}

function normalize(raw: unknown): TelegramSettings {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Partial<TelegramSettings>;
  const owner = value.owner;
  const validOwner = owner && typeof owner.userId === 'number' && typeof owner.chatId === 'number' ? owner : undefined;
  const notifications = { ...DEFAULT_NOTIFICATIONS };
  for (const key of Object.keys(DEFAULT_NOTIFICATIONS) as Array<keyof TelegramNotificationSettings>) {
    const v = value.notifications?.[key];
    if (typeof v === 'boolean') notifications[key] = v;
  }
  return {
    ...(validOwner ? { owner: validOwner } : {}),
    notifications,
    ...(typeof value.currentProjectId === 'string' ? { currentProjectId: value.currentProjectId } : {}),
  };
}

export function createTelegramSettingsStore(dir: string): TelegramSettingsStore {
  const path = join(dir, SETTINGS_FILE);
  let cache: TelegramSettings | undefined;

  const read = (): TelegramSettings => {
    if (cache) return cache;
    try {
      cache = normalize(JSON.parse(readFileSync(path, 'utf-8')));
    } catch {
      cache = normalize(undefined);
    }
    return cache;
  };

  return {
    get: read,
    update(patch) {
      const next = normalize({ ...read(), ...patch });
      if ('owner' in patch && !patch.owner) delete next.owner;
      mkdirSync(dir, { recursive: true });
      const temporary = join(dir, `.${randomBytes(8).toString('hex')}.${SETTINGS_FILE}`);
      try {
        writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600, flag: 'wx' });
        renameSync(temporary, path);
      } catch (error) {
        rmSync(temporary, { force: true });
        throw error;
      }
      cache = next;
      return next;
    },
  };
}
