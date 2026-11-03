/**
 * The app's one Claude credential.
 *
 * Every agent and utility task authenticates with the same credential:
 * an Anthropic API key (or, in personal mode, a Claude subscription token —
 * see `auth.ts`) plus an optional base URL for gateways.
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

import type { ClaudeCredentialStatus } from '../../../shared/types/claude-credential';
import { readSettingsFile } from '../../settings-utils';
import { decryptToken, encryptToken } from '../../utils/token-encryption';
import type { ClaudeAuth } from '../session/types';
import { isSubscriptionToken, toClaudeAuth } from './auth';
import { isSubscriptionModeEnabled } from './subscription-setting';

interface StoredCredential {
  apiKey: string;
}

export interface ResolvedClaudeCredential {
  key?: string;
  baseURL?: string;
  source: ClaudeCredentialStatus['source'];
}

function storePath(): string {
  return join(app.getPath('userData'), 'claude-credential.json');
}

/** The key saved in the app, if any. */
export function loadStoredClaudeKey(): string | undefined {
  const path = storePath();
  if (!existsSync(path)) return undefined;
  try {
    const raw = decryptToken(readFileSync(path, 'utf-8'));
    const parsed = raw ? (JSON.parse(raw) as Partial<StoredCredential>) : undefined;
    return parsed?.apiKey?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function saveClaudeKey(apiKey: string): void {
  const key = apiKey.trim();
  if (!key) throw new Error('The key is empty');
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });
  const stored: StoredCredential = { apiKey: key };
  writeFileSync(path, encryptToken(JSON.stringify(stored)), { mode: 0o600 });
}

export function clearClaudeKey(): void {
  rmSync(storePath(), { force: true });
}

/**
 * Pick the credential: the stored key first, then the environment.
 * Pure — the inputs are passed in so this can be tested without Electron.
 */
export function pickClaudeCredential(input: {
  storedKey?: string;
  baseUrlSetting?: string;
  env: Record<string, string | undefined>;
  subscriptionMode: boolean;
}): ResolvedClaudeCredential {
  const baseURL = input.baseUrlSetting?.trim() || input.env.ANTHROPIC_BASE_URL?.trim() || undefined;
  if (input.storedKey) return { key: input.storedKey, baseURL, source: 'stored' };
  const envKey = input.env.ANTHROPIC_API_KEY?.trim();
  if (envKey) return { key: envKey, baseURL, source: 'environment' };
  const envToken = input.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (input.subscriptionMode && envToken) return { key: envToken, baseURL, source: 'environment' };
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

export function resolveClaudeCredential(): ResolvedClaudeCredential {
  return pickClaudeCredential({
    storedKey: loadStoredClaudeKey(),
    baseUrlSetting: readBaseUrlSetting(),
    env: process.env,
    subscriptionMode: isSubscriptionModeEnabled(),
  });
}

/** Session auth for Claude Code (subscription tokens only in personal mode). */
export function resolveClaudeAuth(): ClaudeAuth {
  const credential = resolveClaudeCredential();
  return toClaudeAuth(credential.key, credential.baseURL, isSubscriptionModeEnabled());
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

/** What the settings UI shows. Never includes the key itself. */
export function getClaudeCredentialStatus(): ClaudeCredentialStatus {
  const credential = resolveClaudeCredential();
  if (!credential.key) return { configured: false, source: 'none' };
  return {
    configured: true,
    source: credential.source,
    kind: isSubscriptionToken(credential.key) ? 'subscription-token' : 'api-key',
    hint: credential.key.slice(-4),
  };
}
