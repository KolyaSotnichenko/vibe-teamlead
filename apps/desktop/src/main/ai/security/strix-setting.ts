/**
 * Security QA (Strix) settings. Main process only: reads the app settings file
 * and, for Strix's own model, its secret store.
 */

import { app } from 'electron';

import { isStrixProviderId, type StrixFieldName, type StrixProviderFields } from '../../../shared/constants/strix-providers';
import { readSettingsFile } from '../../settings-utils';
import { DEFAULT_STRIX_SETTINGS, type StrixSettings } from './strix';
import type { StrixLlmChoice } from './strix-llm';
import { createStrixSecretStore, type StrixSecretStore } from './strix-secrets';

export function readStrixSettings(): StrixSettings {
  try {
    const s = readSettingsFile() ?? {};
    const budget = Number(s.securityQaMaxBudgetUsd);
    return {
      enabled: s.securityQaEnabled === true,
      scanMode: (['quick', 'standard', 'deep'] as const).includes(s.securityQaScanMode as never)
        ? (s.securityQaScanMode as StrixSettings['scanMode'])
        : DEFAULT_STRIX_SETTINGS.scanMode,
      failOn: (['critical', 'high', 'medium', 'low'] as const).includes(s.securityQaFailOn as never)
        ? (s.securityQaFailOn as StrixSettings['failOn'])
        : DEFAULT_STRIX_SETTINGS.failOn,
      maxBudgetUsd: budget > 0 ? budget : DEFAULT_STRIX_SETTINGS.maxBudgetUsd,
    };
  } catch {
    return DEFAULT_STRIX_SETTINGS;
  }
}

const FIELD_NAMES: StrixFieldName[] = [
  'apiBase',
  'azureApiBase',
  'azureApiVersion',
  'awsAccessKeyId',
  'awsProfile',
  'awsRegion',
  'vertexProject',
  'vertexLocation',
  'vertexCredentialsFile',
];

/** Strix's model from the settings, with the chosen provider's secrets (and no other's). Pure. */
export function strixLlmChoiceFrom(settings: Record<string, unknown>, secrets: Pick<StrixSecretStore, 'load'>): StrixLlmChoice {
  const provider = isStrixProviderId(settings.securityQaProvider) ? settings.securityQaProvider : 'agents';
  if (provider === 'agents') return { provider, model: '', fields: {}, secrets: {} };
  const raw = (settings.securityQaProviderFields && typeof settings.securityQaProviderFields === 'object'
    ? settings.securityQaProviderFields
    : {}) as Record<string, unknown>;
  const fields: StrixProviderFields = {};
  if (raw.awsAuth === 'keys' || raw.awsAuth === 'profile') fields.awsAuth = raw.awsAuth;
  for (const name of FIELD_NAMES) {
    const value = raw[name];
    if (typeof value === 'string' && value.trim()) fields[name] = value.trim();
  }
  return {
    provider,
    model: typeof settings.securityQaModel === 'string' ? settings.securityQaModel.trim() : '',
    fields,
    secrets: loadSecrets(secrets, provider),
  };
}

/** Secrets that can't be read are missing secrets (the scan is skipped), never the Claude key. */
function loadSecrets(secrets: Pick<StrixSecretStore, 'load'>, provider: StrixLlmChoice['provider']): StrixLlmChoice['secrets'] {
  try {
    return secrets.load(provider);
  } catch {
    return {};
  }
}

let store: StrixSecretStore | undefined;

/** The secret store in the app's data folder. */
export function strixSecretStore(): StrixSecretStore {
  store ??= createStrixSecretStore(app.getPath('userData'));
  return store;
}

/** Strix's model and credentials, as Settings → Security QA has them. */
export function readStrixLlmChoice(): StrixLlmChoice {
  let settings: Record<string, unknown> = {};
  try {
    settings = readSettingsFile() ?? {};
  } catch {
    // No settings (as when the file does not parse): the default
  }
  return strixLlmChoiceFrom(settings, { load: (provider) => strixSecretStore().load(provider) });
}
