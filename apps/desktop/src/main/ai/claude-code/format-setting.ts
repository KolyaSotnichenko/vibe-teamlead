/**
 * Format-and-lint-after-edit switch (Settings → Agent Settings). Main process
 * only: reads the app settings file. On unless turned off.
 */

import { readSettingsFile } from '../../settings-utils';

export function isFormatOnEditEnabled(): boolean {
  try {
    return readSettingsFile()?.formatOnEdit !== false;
  } catch {
    return true;
  }
}
