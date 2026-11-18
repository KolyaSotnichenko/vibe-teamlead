/**
 * Cloud architecture diagrams (TerraVision) switch, Settings → Agents.
 * Experimental, on unless turned off. Main process only: reads the app settings file.
 */

import { findOnPath } from '../../platform/exec';
import { readSettingsFile } from '../../settings-utils';
import type { CloudDiagramsLaunch } from './architect-session';
import { detectCloudTools, terravisionCommand } from './terravision';

export function isCloudDiagramsEnabled(): boolean {
  try {
    return readSettingsFile()?.cloudDiagramsEnabled !== false;
  } catch {
    return true;
  }
}

/** The architect's TerraVision launch, or undefined when the setting is off or it can't run. */
export function cloudDiagramsLaunch(
  enabled: boolean = isCloudDiagramsEnabled(),
  find: (name: string) => string | undefined = (name) => findOnPath(name),
): CloudDiagramsLaunch | undefined {
  if (!enabled) return undefined;
  const tools = detectCloudTools(find);
  const command = terravisionCommand(tools, true);
  return command ? { command, drawFromCode: tools.drawFromCode } : undefined;
}
