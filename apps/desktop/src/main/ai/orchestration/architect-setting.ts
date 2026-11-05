/**
 * Architect setting. Main process only: reads the app settings file.
 */

import { readSettingsFile } from '../../settings-utils';
import { ARCHITECT_MODES, DEFAULT_ARCHITECT_MODE, type ArchitectMode } from '../../../shared/types/settings';

export function readArchitectMode(): ArchitectMode {
  try {
    const mode = (readSettingsFile() ?? {}).architectMode;
    return ARCHITECT_MODES.includes(mode as ArchitectMode) ? (mode as ArchitectMode) : DEFAULT_ARCHITECT_MODE;
  } catch {
    return DEFAULT_ARCHITECT_MODE;
  }
}
