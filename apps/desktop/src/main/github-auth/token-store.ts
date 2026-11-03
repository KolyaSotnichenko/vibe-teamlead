/**
 * Encrypted storage for the GitHub App user token (macOS Keychain via
 * Electron safeStorage), with transparent refresh.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { app } from 'electron';

import { decryptToken, encryptToken } from '../utils/token-encryption';
import { setGitHubTokenProvider } from '../env-utils';
import { type GitHubTokens, refreshTokens } from './device-flow';

export interface StoredGitHubAuth extends GitHubTokens {
  login?: string;
}

/** Refresh when the access token has less than this left. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

function storePath(): string {
  return join(app.getPath('userData'), 'github-auth.json');
}

export function loadGitHubAuth(): StoredGitHubAuth | null {
  const path = storePath();
  if (!existsSync(path)) return null;
  try {
    const raw = decryptToken(readFileSync(path, 'utf-8'));
    return raw ? (JSON.parse(raw) as StoredGitHubAuth) : null;
  } catch {
    return null;
  }
}

export function saveGitHubAuth(auth: StoredGitHubAuth): void {
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, encryptToken(JSON.stringify(auth)), { mode: 0o600 });
}

export function clearGitHubAuth(): void {
  rmSync(storePath(), { force: true });
}

/** Whether a stored token can still be used as-is (no network). */
export function isUsable(auth: StoredGitHubAuth | null, now = Date.now()): boolean {
  return !!auth?.accessToken && (!auth.expiresAt || auth.expiresAt - now > REFRESH_MARGIN_MS);
}

/** Current token without refreshing (for synchronous callers). */
export function getStoredAccessTokenSync(): string | null {
  const auth = loadGitHubAuth();
  return auth && isUsable(auth) ? auth.accessToken : null;
}

let refreshing: Promise<string | null> | null = null;

/**
 * A valid access token, refreshing it when it is about to expire.
 * Returns null when the user is not signed in or must sign in again.
 */
export async function getValidAccessToken(): Promise<string | null> {
  const auth = loadGitHubAuth();
  if (!auth) return null;
  if (isUsable(auth)) return auth.accessToken;
  if (!auth.refreshToken || (auth.refreshExpiresAt && auth.refreshExpiresAt <= Date.now())) {
    clearGitHubAuth();
    return null;
  }
  refreshing ??= refreshTokens(auth.refreshToken)
    .then((tokens) => {
      saveGitHubAuth({ ...tokens, login: auth.login });
      return tokens.accessToken;
    })
    .catch(() => {
      clearGitHubAuth();
      return null;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

// gh/git subprocesses authenticate as the signed-in app user.
setGitHubTokenProvider(getStoredAccessTokenSync);
