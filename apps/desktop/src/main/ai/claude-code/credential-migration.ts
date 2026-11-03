/**
 * One-time migration from the removed multi-provider / multi-account layer.
 *
 * Older settings kept Claude credentials in several places: provider accounts
 * (`providerAccounts` in settings.json), the global Anthropic key, API profiles
 * (`auto-claude/profiles.json`, Anthropic-compatible endpoints) and Claude
 * profiles (`config/claude-profiles.json`, subscription tokens). The first
 * usable key becomes the app's one credential (see `credential.ts`), so users
 * keep their key; then the dead fields are dropped from settings.json.
 *
 * Main process only.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { app } from 'electron';

import { readSettingsFile, writeSettingsFile } from '../../settings-utils';
import { decryptToken } from '../../utils/token-encryption';
import { loadStoredClaudeKey, saveClaudeKey } from './credential';

/** Settings fields that belonged to the removed layer. */
export const LEGACY_SETTINGS_FIELDS = [
  'providerAccounts',
  'globalPriorityOrder',
  'crossProviderPriorityOrder',
  'modelOverrides',
  'providerAgentConfig',
  'customMixedProfileActive',
  'customMixedPhaseConfig',
  'customMixedFeatureConfig',
  'globalAnthropicApiKey',
  'globalGroqApiKey',
  'globalMistralApiKey',
  'globalXAIApiKey',
  'globalAzureApiKey',
  'globalAzureBaseUrl',
  'globalBedrockRegion',
  'globalZAIApiKey',
  'globalOpenRouterApiKey',
  '_migratedProviderAccounts',
  '_migratedToPerProviderConfig',
  'seenVersionWarnings',
] as const;

interface LegacyAccount {
  provider?: string;
  authType?: string;
  apiKey?: string;
  baseUrl?: string;
  isActive?: boolean;
}

interface LegacyApiProfile {
  id?: string;
  apiKey?: string;
  baseUrl?: string;
}

interface LegacyClaudeProfile {
  id?: string;
  oauthToken?: string;
}

export interface LegacySources {
  settings: Record<string, unknown>;
  apiProfiles?: { profiles?: LegacyApiProfile[]; activeProfileId?: string | null };
  claudeProfiles?: { profiles?: LegacyClaudeProfile[]; activeProfileId?: string | null };
  decrypt?: (value: string) => string;
}

export interface LegacyCredential {
  apiKey: string;
  baseUrl?: string;
}

function activeFirst<T extends { id?: string }>(items: T[], activeId: string | null | undefined): T[] {
  return [...items].sort((a, b) => Number(b.id === activeId) - Number(a.id === activeId));
}

/** The first usable legacy Claude key, in order of how specific it was. */
export function pickLegacyClaudeCredential(sources: LegacySources): LegacyCredential | undefined {
  const { settings } = sources;

  const accounts = Array.isArray(settings.providerAccounts) ? (settings.providerAccounts as LegacyAccount[]) : [];
  const anthropic = accounts
    .filter((a) => a.provider === 'anthropic' && a.authType === 'api-key' && a.apiKey?.trim())
    .sort((a, b) => Number(!!b.isActive) - Number(!!a.isActive));
  if (anthropic[0]?.apiKey) {
    return { apiKey: anthropic[0].apiKey.trim(), baseUrl: anthropic[0].baseUrl?.trim() || undefined };
  }

  if (typeof settings.globalAnthropicApiKey === 'string' && settings.globalAnthropicApiKey.trim()) {
    return { apiKey: settings.globalAnthropicApiKey.trim() };
  }

  const apiProfiles = activeFirst(sources.apiProfiles?.profiles ?? [], sources.apiProfiles?.activeProfileId);
  const apiProfile = apiProfiles.find((p) => p.apiKey?.trim());
  if (apiProfile?.apiKey) {
    return { apiKey: apiProfile.apiKey.trim(), baseUrl: apiProfile.baseUrl?.trim() || undefined };
  }

  const decrypt = sources.decrypt ?? ((value: string) => value);
  const claudeProfiles = activeFirst(sources.claudeProfiles?.profiles ?? [], sources.claudeProfiles?.activeProfileId);
  for (const profile of claudeProfiles) {
    const token = profile.oauthToken ? decrypt(profile.oauthToken).trim() : '';
    if (token) return { apiKey: token };
  }

  return undefined;
}

/** Settings without the removed fields; `changed` tells whether any were present. */
export function stripLegacySettings(settings: Record<string, unknown>): {
  settings: Record<string, unknown>;
  changed: boolean;
} {
  const next = { ...settings };
  let changed = false;
  for (const field of LEGACY_SETTINGS_FIELDS) {
    if (field in next) {
      delete next[field];
      changed = true;
    }
  }
  return { settings: next, changed };
}

function readJson<T>(path: string): T | undefined {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf-8')) as T) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run once at startup, before anything reads the credential.
 * Safe to run on every launch: it only acts when legacy data is present.
 */
export function migrateLegacyClaudeCredential(): void {
  const settings = readSettingsFile();
  if (!settings) return;

  const { settings: cleaned, changed } = stripLegacySettings(settings);
  if (!changed) return;

  if (!loadStoredClaudeKey()) {
    const userData = app.getPath('userData');
    const legacy = pickLegacyClaudeCredential({
      settings,
      apiProfiles: readJson(join(userData, 'auto-claude', 'profiles.json')),
      claudeProfiles: readJson(join(userData, 'config', 'claude-profiles.json')),
      decrypt: decryptToken,
    });
    if (legacy) {
      saveClaudeKey(legacy.apiKey);
      if (legacy.baseUrl && !cleaned.anthropicBaseUrl) cleaned.anthropicBaseUrl = legacy.baseUrl;
    }
  }

  writeSettingsFile(cleaned);
}
