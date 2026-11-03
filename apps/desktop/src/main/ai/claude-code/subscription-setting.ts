/**
 * Personal-mode switch (Settings → "Use my Claude subscription").
 * Main process only: reads the app settings file.
 */

import { readSettingsFile } from '../../settings-utils';

export function isSubscriptionModeEnabled(): boolean {
  try {
    return readSettingsFile()?.useClaudeSubscription === true;
  } catch {
    // Settings unavailable (tests, early startup) — personal mode stays off.
    return false;
  }
}
