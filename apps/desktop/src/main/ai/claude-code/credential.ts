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

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  const apiKey = parsed?.apiKey?.trim() || undefined;
  const subscriptionToken = parsed?.subscriptionToken?.trim() || undefined;
  if (apiKey && isSubscriptionToken(apiKey)) return { subscriptionToken: subscriptionToken ?? apiKey };
  return { apiKey, subscriptionToken };
}

function loadStored(): StoredCredential {
  const path = storePath();
  if (!existsSync(path)) return {};
  try {
    const raw = decryptToken(readFileSync(path, 'utf-8'));
    return normalizeStoredCredential(raw ? (JSON.parse(raw) as Partial<StoredCredential>) : undefined);
  } catch {
    return {};
  }
}

function writeStored(stored: StoredCredential): void {
  const path = storePath();
  if (!stored.apiKey && !stored.subscriptionToken) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, encryptToken(JSON.stringify(stored)), { mode: 0o600 });
}

/** The API key saved in the app, if any. */
export function loadStoredClaudeKey(): string | undefined {
  return loadStored().apiKey;
}

/** Save a key into its slot (a subscription token goes to the subscription slot); the other slot is kept. */
export function saveClaudeKey(key: string): ClaudeCredentialSlot {
  const value = key.trim();
  if (!value) throw new Error('The key is empty');
  const stored = loadStored();
  const slot: ClaudeCredentialSlot = isSubscriptionToken(value) ? 'subscription' : 'api';
  writeStored(slot === 'subscription' ? { ...stored, subscriptionToken: value } : { ...stored, apiKey: value });
  return slot;
}

/** Remove one saved credential (default: the one the current mode uses). */
export function clearClaudeKey(slot: ClaudeCredentialSlot = isSubscriptionModeEnabled() ? 'subscription' : 'api'): void {
  const stored = loadStored();
  writeStored(slot === 'subscription' ? { ...stored, subscriptionToken: undefined } : { ...stored, apiKey: undefined });
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
