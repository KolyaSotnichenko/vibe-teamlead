/**
 * The bot's settings: the paired owner, the notification switches and the project later
 * commands act on. Kept in `<userData>/telegram.json`, apart from settings.json, which the
 * window saves as a whole (a save from an open Settings dialog would otherwise drop a pairing
 * made from the phone). Written atomically.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { TelegramDigestSettings, TelegramNotificationSettings, TelegramOwner } from '../../shared/types/telegram';

export const SETTINGS_FILE = 'telegram.json';

export const DEFAULT_NOTIFICATIONS: TelegramNotificationSettings = {
  agentQuestion: true,
  reviewWaiting: true,
  taskFailed: true,
  ciFailed: true,
  taskMerged: true,
  regression: true,
};

export const DEFAULT_DIGEST: TelegramDigestSettings = { enabled: true, time: '09:00' };

/** The digest switch and time, plus when it was last sent (once a day) */
export interface DigestState extends TelegramDigestSettings {
  /** Local date (YYYY-MM-DD) of the last digest */
  lastSentDate?: string;
  /** Epoch ms of the last digest: the next one tells what happened since */
  lastSentAt?: number;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function normalizeDigest(raw: unknown): DigestState {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Partial<DigestState>;
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : DEFAULT_DIGEST.enabled,
    time: typeof value.time === 'string' && TIME.test(value.time) ? value.time : DEFAULT_DIGEST.time,
    ...(typeof value.lastSentDate === 'string' && DATE.test(value.lastSentDate) ? { lastSentDate: value.lastSentDate } : {}),
    ...(typeof value.lastSentAt === 'number' && Number.isFinite(value.lastSentAt) ? { lastSentAt: value.lastSentAt } : {}),
  };
}

export interface TelegramSettings {
  owner?: TelegramOwner;
  notifications: TelegramNotificationSettings;
  /** The project `/project` chose for later commands */
  currentProjectId?: string;
  digest: DigestState;
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
    digest: normalizeDigest(value.digest),
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
