/**
 * Language-servers switch (Settings → Agent Settings). Main process only:
 * reads the app settings file. On unless turned off.
 */

import { readSettingsFile } from '../../settings-utils';

export function isLspEnabled(): boolean {
  try {
    return readSettingsFile()?.lspEnabled !== false;
  } catch {
    return true;
  }
}
