/**
 * Personal-mode switch (Settings → "Use my Claude subscription").
 * Main process only: reads the app settings file.
 */

import { readSettingsFile } from '../../settings-utils';

export function isSubscriptionModeEnabled(): boolean {
  return readSettingsFile()?.useClaudeSubscription === true;
}
