/**
 * Security QA (Strix) settings. Main process only: reads the app settings file.
 */

import { readSettingsFile } from '../../settings-utils';
import { DEFAULT_STRIX_SETTINGS, type StrixSettings } from './strix';

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
