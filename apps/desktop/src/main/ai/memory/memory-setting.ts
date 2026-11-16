/**
 * Whether project memory is on (Settings → Memory, `memoryEnabled: false` turns it off).
 * Its own module so the worker bridge can read it without loading the memory database.
 */
import { readSettingsFile } from '../../settings-utils';

export function isMemoryEnabled(settings: { memoryEnabled?: unknown } | null | undefined = readSettings()): boolean {
  return settings?.memoryEnabled !== false;
}

function readSettings(): { memoryEnabled?: unknown } | undefined {
  try {
    return readSettingsFile() as { memoryEnabled?: unknown } | undefined;
  } catch {
    return undefined;
  }
}
