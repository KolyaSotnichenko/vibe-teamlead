/**
 * Security QA's own secrets (API keys, the AWS secret access key, the Azure key),
 * per provider, encrypted with Electron safeStorage (Keychain on macOS, DPAPI on
 * Windows) in `<userData>/strix-credentials.json`. Written atomically (a new file
 * renamed into place, owner-only); a file that can't be read is moved to
 * `.unreadable`, not overwritten. Never logged; the renderer only learns which
 * secrets are saved. Main process only.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  isStrixProviderId,
  isStrixSecretName,
  type StrixProviderId,
  type StrixSecretName,
  type StrixSecretStatus,
} from '../../../shared/constants/strix-providers';
import { decryptToken, encryptToken } from '../../utils/token-encryption';

export const STRIX_SECRETS_FILE = 'strix-credentials.json';

type Secrets = Partial<Record<StrixSecretName, string>>;
type Stored = Partial<Record<StrixProviderId, Secrets>>;

export interface StrixSecretCrypto {
  encrypt: (text: string) => string;
  /** '' when the text could not be decrypted */
  decrypt: (text: string) => string;
}

export interface StrixSecretStore {
  load(provider: StrixProviderId): Secrets;
  save(provider: StrixProviderId, name: StrixSecretName, value: string): void;
  clear(provider: StrixProviderId, name: StrixSecretName): void;
  status(): StrixSecretStatus;
}

const defaultCrypto: StrixSecretCrypto = { encrypt: encryptToken, decrypt: decryptToken };

/** Only known providers and names, with non-empty string values. */
function clean(parsed: unknown): Stored {
  const stored: Stored = {};
  if (!parsed || typeof parsed !== 'object') return stored;
  for (const [provider, secrets] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isStrixProviderId(provider) || !secrets || typeof secrets !== 'object') continue;
    const kept: Secrets = {};
    for (const [name, value] of Object.entries(secrets as Record<string, unknown>)) {
      if (isStrixSecretName(name) && typeof value === 'string' && value) kept[name] = value;
    }
    if (Object.keys(kept).length) stored[provider] = kept;
  }
  return stored;
}

export function createStrixSecretStore(dir: string, crypto: StrixSecretCrypto = defaultCrypto): StrixSecretStore {
  const path = join(dir, STRIX_SECRETS_FILE);

  const read = (): { stored: Stored; unreadable: boolean } => {
    if (!existsSync(path)) return { stored: {}, unreadable: false };
    try {
      const raw = crypto.decrypt(readFileSync(path, 'utf-8'));
      if (!raw) return { stored: {}, unreadable: true };
      return { stored: clean(JSON.parse(raw)), unreadable: false };
    } catch {
      return { stored: {}, unreadable: true };
    }
  };

  const write = (stored: Stored, unreadable: boolean) => {
    if (unreadable) {
      try {
        renameSync(path, `${path}.unreadable`);
      } catch {
        // replaced or removed below
      }
    }
    const kept = clean(stored);
    if (!Object.keys(kept).length) {
      rmSync(path, { force: true });
      return;
    }
    mkdirSync(dir, { recursive: true });
    const temporary = join(dir, `.${randomBytes(8).toString('hex')}.${STRIX_SECRETS_FILE}`);
    try {
      writeFileSync(temporary, crypto.encrypt(JSON.stringify(kept)), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, path);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  };

  const check = (provider: unknown, name: unknown) => {
    if (!isStrixProviderId(provider)) throw new Error('Unknown provider');
    if (!isStrixSecretName(name)) throw new Error('Unknown secret');
  };

  return {
    load: (provider) => ({ ...(read().stored[provider] ?? {}) }),
    save(provider, name, value) {
      check(provider, name);
      const secret = String(value ?? '').trim();
      if (!secret) throw new Error('The value is empty');
      const { stored, unreadable } = read();
      write({ ...stored, [provider]: { ...stored[provider], [name]: secret } }, unreadable);
    },
    clear(provider, name) {
      check(provider, name);
      const { stored, unreadable } = read();
      write({ ...stored, [provider]: { ...stored[provider], [name]: undefined } }, unreadable);
    },
    status() {
      const status: StrixSecretStatus = {};
      for (const [provider, secrets] of Object.entries(read().stored) as [StrixProviderId, Secrets][]) {
        status[provider] = Object.fromEntries(Object.keys(secrets).map((name) => [name, true]));
      }
      return status;
    },
  };
}
