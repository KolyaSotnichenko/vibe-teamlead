/**
 * Helper subagent settings. Main process only: reads the app settings file.
 */

import { readSettingsFile } from '../../settings-utils';
import { DEFAULT_SUBAGENT_SETTINGS, type SubagentSettings } from './subagents';

export function readSubagentSettings(): SubagentSettings {
  try {
    const s = readSettingsFile() ?? {};
    return {
      enabled: s.subagentsEnabled !== false,
      model: typeof s.subagentModel === 'string' ? s.subagentModel.trim() : '',
    };
  } catch {
    return DEFAULT_SUBAGENT_SETTINGS;
  }
}
