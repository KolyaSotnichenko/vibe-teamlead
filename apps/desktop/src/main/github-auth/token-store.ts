/**
 * Encrypted storage for the GitHub App user token (macOS Keychain via
 * Electron safeStorage), with refresh.
 *
 * - The decoded auth is cached in memory; the file is read once.
 * - A timer refreshes the access token shortly before it expires, so the
 *   synchronous token provider used for gh/git subprocesses never lapses.
 * - The user is signed out only when GitHub rejects the refresh token, never
 *   on a network error.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { app } from 'electron';

import { decryptToken, encryptToken } from '../claude-profile/token-encryption';
import { setGitHubTokenProvider } from '../env-utils';
import { DeviceFlowError, type GitHubTokens, refreshTokens } from './device-flow';

export interface StoredGitHubAuth extends GitHubTokens {
  login?: string;
}

/** Refresh when the access token has less than this left. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** Retry delay after a refresh failed for a transient reason (offline, 5xx). */
const RETRY_DELAY_MS = 60 * 1000;
/** GitHub error codes that mean the refresh token is no longer valid. */
const REVOKED_CODES = new Set(['bad_refresh_token', 'invalid_grant', 'unauthorized_client']);

function storePath(): string {
  return join(app.getPath('userData'), 'github-auth.json');
}

/** undefined = not loaded yet; null = signed out. */
let cached: StoredGitHubAuth | null | undefined;
/** Bumped on every save/clear so a refresh that started earlier can't overwrite newer state. */
let generation = 0;
let refreshing: Promise<string | null> | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function readStore(): StoredGitHubAuth | null {
  const path = storePath();
  if (!existsSync(path)) return null;
  try {
    const raw = decryptToken(readFileSync(path, 'utf-8'));
    return raw ? (JSON.parse(raw) as StoredGitHubAuth) : null;
  } catch {
    return null;
  }
}

export function loadGitHubAuth(): StoredGitHubAuth | null {
  if (cached === undefined) cached = readStore();
  return cached;
}

export function saveGitHubAuth(auth: StoredGitHubAuth): void {
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, encryptToken(JSON.stringify(auth)), { mode: 0o600 });
  cached = auth;
  generation++;
  scheduleRefresh(auth);
}

export function clearGitHubAuth(): void {
  rmSync(storePath(), { force: true });
  cached = null;
  generation++;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
}

/** Whether a stored token can still be used as-is (no network). */
export function isUsable(auth: StoredGitHubAuth | null, now = Date.now()): boolean {
  return !!auth?.accessToken && (!auth.expiresAt || auth.expiresAt - now > REFRESH_MARGIN_MS);
}

/** Current token without refreshing (for synchronous callers such as subprocess env). */
export function getStoredAccessTokenSync(): string | null {
  const auth = loadGitHubAuth();
  return auth && isUsable(auth) ? auth.accessToken : null;
}

function scheduleRefresh(auth: StoredGitHubAuth, delayMs?: number): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
  if (!auth.expiresAt || !auth.refreshToken) return;
  const delay = delayMs ?? Math.max(0, auth.expiresAt - REFRESH_MARGIN_MS - Date.now());
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void getValidAccessToken();
  }, delay);
  refreshTimer.unref?.();
}

/**
 * A valid access token, refreshing it when it is about to expire.
 * Returns null when the user is not signed in, must sign in again, or the
 * refresh failed for a transient reason (it is retried shortly).
 */
export async function getValidAccessToken(): Promise<string | null> {
  const auth = loadGitHubAuth();
  if (!auth) return null;
  if (isUsable(auth)) return auth.accessToken;
  if (!auth.refreshToken || (auth.refreshExpiresAt && auth.refreshExpiresAt <= Date.now())) {
    clearGitHubAuth();
    return null;
  }
  if (refreshing) return refreshing;

  const startedAt = generation;
  refreshing = refreshTokens(auth.refreshToken)
    .then((tokens) => {
      // A sign-in or sign-out happened meanwhile: keep the newer state.
      if (generation !== startedAt) return getStoredAccessTokenSync();
      saveGitHubAuth({ ...tokens, login: auth.login });
      return tokens.accessToken;
    })
    .catch((error: unknown) => {
      if (generation !== startedAt) return getStoredAccessTokenSync();
      if (error instanceof DeviceFlowError && REVOKED_CODES.has(error.code)) {
        clearGitHubAuth();
      } else {
        scheduleRefresh(auth, RETRY_DELAY_MS);
      }
      return null;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

/**
 * Register the token provider for gh/git subprocesses and start the refresh
 * schedule. Called once from main-process startup.
 */
export function initGitHubAuth(): void {
  setGitHubTokenProvider(getStoredAccessTokenSync);
  const auth = loadGitHubAuth();
  if (auth) scheduleRefresh(auth);
}

/** Test hook: forget the in-memory state. */
export function resetGitHubAuthCacheForTests(): void {
  cached = undefined;
  refreshing = null;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
}
