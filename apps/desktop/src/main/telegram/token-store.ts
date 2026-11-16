/**
 * The Telegram bot token, encrypted with Electron safeStorage (Keychain on macOS, DPAPI on
 * Windows) in `<userData>/telegram-token.json`. Written atomically (a new file renamed into
 * place, owner-only); a file that can't be read is moved to `.unreadable`, not overwritten.
 * The token is never logged and never sent to the renderer.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { decryptToken, encryptToken } from '../utils/token-encryption';

export const TOKEN_FILE = 'telegram-token.json';

export interface TokenCrypto {
  encrypt: (text: string) => string;
  /** '' when the text could not be decrypted */
  decrypt: (text: string) => string;
}

export interface TokenStore {
  load(): string | undefined;
  save(token: string): void;
  clear(): void;
}

const defaultCrypto: TokenCrypto = { encrypt: encryptToken, decrypt: decryptToken };

export function createTokenStore(dir: string, crypto: TokenCrypto = defaultCrypto): TokenStore {
  const path = join(dir, TOKEN_FILE);

  const read = (): { token?: string; unreadable: boolean } => {
    if (!existsSync(path)) return { unreadable: false };
    try {
      const raw = crypto.decrypt(readFileSync(path, 'utf-8'));
      if (!raw) return { unreadable: true };
      const token = (JSON.parse(raw) as { token?: unknown }).token;
      return typeof token === 'string' && token ? { token, unreadable: false } : { unreadable: true };
    } catch {
      return { unreadable: true };
    }
  };

  return {
    load: () => read().token,
    save(token: string) {
      const value = token.trim();
      if (!value) throw new Error('The token is empty');
      if (read().unreadable) {
        try {
          renameSync(path, `${path}.unreadable`);
        } catch {
          // replaced below
        }
      }
      mkdirSync(dir, { recursive: true });
      const temporary = join(dir, `.${randomBytes(8).toString('hex')}.${TOKEN_FILE}`);
      try {
        writeFileSync(temporary, crypto.encrypt(JSON.stringify({ token: value })), { mode: 0o600, flag: 'wx' });
        renameSync(temporary, path);
      } catch (error) {
        rmSync(temporary, { force: true });
        throw error;
      }
    },
    clear() {
      rmSync(path, { force: true });
    },
  };
}
