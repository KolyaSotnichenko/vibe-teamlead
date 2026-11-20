/**
 * The app's Claude credential.
 *
 * Two are kept — an Anthropic API key (with an optional gateway base URL) and,
 * for personal mode, a Claude subscription token (see `auth.ts`). The mode in
 * Settings → Claude decides which one every agent and utility task uses.
 *
 * - The key is kept outside settings.json, encrypted with Electron safeStorage
 *   (macOS Keychain), in `<userData>/claude-credential.json`.
 * - The base URL is a plain setting (`anthropicBaseUrl`).
 * - Developers can use the environment instead: ANTHROPIC_API_KEY,
 *   ANTHROPIC_BASE_URL, and CLAUDE_CODE_OAUTH_TOKEN (personal mode only).
 *
 * Main process only.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { app } from 'electron';

import type { ClaudeCredentialSlotStatus, ClaudeCredentialStatus } from '../../../shared/types/claude-credential';
import { readSettingsFile } from '../../settings-utils';
import { decryptToken, encryptToken } from '../../utils/token-encryption';
import type { ClaudeAuth } from '../session/types';
import { isSubscriptionToken, toClaudeAuth } from './auth';
import { isSubscriptionModeEnabled } from './subscription-setting';

/** Both credentials are kept; the mode (Settings → Claude) picks which one sessions use. */
interface StoredCredential {
  /** Anthropic API key (or a gateway's key), used with the base URL */
  apiKey?: string;
  /** Claude subscription token (`sk-ant-oat…`), personal mode only */
  subscriptionToken?: string;
}

export type ClaudeCredentialSlot = 'api' | 'subscription';

export interface ResolvedClaudeCredential {
  key?: string;
  baseURL?: string;
  source: ClaudeCredentialStatus['source'];
}

function storePath(): string {
  return join(app.getPath('userData'), 'claude-credential.json');
}

/**
 * Old files held one key in `apiKey`, whatever it was: a subscription token
 * there belongs to the subscription slot. Pure — tested directly.
 */
export function normalizeStoredCredential(parsed: Partial<StoredCredential> | undefined): StoredCredential {
  // Cleaned in this one place every reader goes through: a key saved before keys were cleaned on paste may hold line breaks
  const apiKey = (parsed?.apiKey && cleanCredential(parsed.apiKey)) || undefined;
  const subscriptionToken = (parsed?.subscriptionToken && cleanCredential(parsed.subscriptionToken)) || undefined;
  if (apiKey && isSubscriptionToken(apiKey)) return { subscriptionToken: subscriptionToken ?? apiKey };
  return { apiKey, subscriptionToken };
}

/**
 * What the file holds, and whether it is there but could not be read (the keychain refused, or
 * the file is damaged). Unreadable is not "no keys": a save must not put one key over both.
 */
function readStored(): { stored: StoredCredential; unreadable: boolean } {
  const path = storePath();
  if (!existsSync(path)) return { stored: {}, unreadable: false };
  try {
    const raw = decryptToken(readFileSync(path, 'utf-8'));
    // decryptToken gives an empty string when decryption failed
    if (!raw) return { stored: {}, unreadable: true };
    return { stored: normalizeStoredCredential(JSON.parse(raw) as Partial<StoredCredential>), unreadable: false };
  } catch {
    return { stored: {}, unreadable: true };
  }
}

function loadStored(): StoredCredential {
  return readStored().stored;
}

/**
 * Writes the credentials (a new file renamed into place, readable by the owner only), or removes
 * the file when none is left. A file that could not be read is first moved to
 * `claude-credential.json.unreadable`, so the keys in it are not lost for good.
 */
function writeStored(stored: StoredCredential, previousUnreadable: boolean): void {
  const path = storePath();
  if (previousUnreadable) {
    try {
      renameSync(path, `${path}.unreadable`);
    } catch {
      // Left in place; it is replaced or removed below
    }
  }
  if (!stored.apiKey && !stored.subscriptionToken) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${randomBytes(8).toString('hex')}.claude-credential.json`);
  try {
    writeFileSync(temporary, encryptToken(JSON.stringify(stored)), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** The API key saved in the app, if any. */
export function loadStoredClaudeKey(): string | undefined {
  return loadStored().apiKey;
}

/** Save a key into its slot (a subscription token goes to the subscription slot); the other slot is kept. */
/**
 * A key or token as pasted, without the spaces and line breaks a terminal can put inside it
 * (PowerShell wraps the long `claude setup-token` output): keys never contain whitespace.
 */
export function cleanCredential(key: string): string {
  return key.replace(/\s+/g, '');
}

export function saveClaudeKey(key: string): ClaudeCredentialSlot {
  const value = cleanCredential(key);
  if (!value) throw new Error('The key is empty');
  const { stored, unreadable } = readStored();
  const slot: ClaudeCredentialSlot = isSubscriptionToken(value) ? 'subscription' : 'api';
  writeStored(slot === 'subscription' ? { ...stored, subscriptionToken: value } : { ...stored, apiKey: value }, unreadable);
  return slot;
}

/** Remove one saved credential (default: the one the current mode uses). */
export function clearClaudeKey(slot: ClaudeCredentialSlot = isSubscriptionModeEnabled() ? 'subscription' : 'api'): void {
  const { stored, unreadable } = readStored();
  writeStored(slot === 'subscription' ? { ...stored, subscriptionToken: undefined } : { ...stored, apiKey: undefined }, unreadable);
}

/**
 * Pick the credential for the chosen mode — never the other one:
 * - API mode: the stored API key, then ANTHROPIC_API_KEY; with the base URL.
 * - Subscription mode: the stored subscription token, then CLAUDE_CODE_OAUTH_TOKEN;
 *   no base URL (subscription calls go to Anthropic).
 * Pure — the inputs are passed in so this can be tested without Electron.
 */
export function pickClaudeCredential(input: {
  storedKey?: string;
  storedSubscriptionToken?: string;
  baseUrlSetting?: string;
  env: Record<string, string | undefined>;
  subscriptionMode: boolean;
}): ResolvedClaudeCredential {
  if (input.subscriptionMode) {
    if (input.storedSubscriptionToken) return { key: input.storedSubscriptionToken, baseURL: undefined, source: 'stored' };
    const envToken = input.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
    if (envToken) return { key: envToken, baseURL: undefined, source: 'environment' };
    return { baseURL: undefined, source: 'none' };
  }
  const baseURL = input.baseUrlSetting?.trim() || input.env.ANTHROPIC_BASE_URL?.trim() || undefined;
  const storedKey = input.storedKey && !isSubscriptionToken(input.storedKey) ? input.storedKey : undefined;
  if (storedKey) return { key: storedKey, baseURL, source: 'stored' };
  const envKey = input.env.ANTHROPIC_API_KEY?.trim();
  if (envKey) return { key: envKey, baseURL, source: 'environment' };
  return { baseURL, source: 'none' };
}

function readBaseUrlSetting(): string | undefined {
  try {
    const value = readSettingsFile()?.anthropicBaseUrl;
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

function resolveFor(subscriptionMode: boolean): ResolvedClaudeCredential {
  const stored = loadStored();
  return pickClaudeCredential({
    storedKey: stored.apiKey,
    storedSubscriptionToken: stored.subscriptionToken,
    baseUrlSetting: readBaseUrlSetting(),
    env: process.env,
    subscriptionMode,
  });
}

/** The credential one slot would give, whatever the current mode (connection test). */
export function resolveClaudeCredentialFor(slot: ClaudeCredentialSlot): ResolvedClaudeCredential {
  return resolveFor(slot === 'subscription');
}

export function resolveClaudeCredential(): ResolvedClaudeCredential {
  return resolveFor(isSubscriptionModeEnabled());
}

/** Session auth for Claude Code: the credential of the chosen mode. */
export function resolveClaudeAuth(): ClaudeAuth {
  const subscriptionMode = isSubscriptionModeEnabled();
  const credential = resolveFor(subscriptionMode);
  return toClaudeAuth(credential.key, credential.baseURL, subscriptionMode);
}

/**
 * Environment variables for subprocesses that call Claude outside the
 * Agent SDK runner (legacy CLI-based features).
 */
export function getClaudeCredentialEnv(): Record<string, string> {
  const auth = resolveClaudeAuth();
  if (auth.oauthToken) return { CLAUDE_CODE_OAUTH_TOKEN: auth.oauthToken };
  if (!auth.apiKey) return {};
  return auth.baseURL
    ? { ANTHROPIC_API_KEY: auth.apiKey, ANTHROPIC_BASE_URL: auth.baseURL }
    : { ANTHROPIC_API_KEY: auth.apiKey };
}

function slotStatus(credential: ResolvedClaudeCredential, kind: ClaudeCredentialStatus['kind']): ClaudeCredentialSlotStatus {
  return credential.key
    ? { configured: true, source: credential.source, kind, hint: credential.key.slice(-4) }
    : { configured: false, source: 'none' };
}

/** What the settings UI shows: the active credential, and both slots. Never includes a key. */
export function getClaudeCredentialStatus(): ClaudeCredentialStatus {
  const subscriptionMode = isSubscriptionModeEnabled();
  const api = slotStatus(resolveFor(false), 'api-key');
  const subscription = slotStatus(resolveFor(true), 'subscription-token');
  const active = subscriptionMode ? subscription : api;
  return { ...active, mode: subscriptionMode ? 'subscription' : 'api', api, subscription };
}
