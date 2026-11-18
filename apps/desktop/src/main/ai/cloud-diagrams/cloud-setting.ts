/**
 * Cloud architecture diagrams (TerraVision) switch, Settings → Agents.
 * Experimental and optional: off unless turned on (users install uv and Graphviz themselves).
 * Main process only: reads the app settings file.
 */

import { findOnPath } from '../../platform/exec';
import { readSettingsFile } from '../../settings-utils';
import type { CloudDiagramsLaunch } from './architect-session';
import { detectCloudTools, terravisionCommand } from './terravision';

/**
 * On only when turned on after it became off by default: an "on" saved while it was
 * on by default (before the one-time migration below) counts as off.
 */
export function isCloudDiagramsEnabled(): boolean {
  try {
    const settings = readSettingsFile();
    return settings?._migratedCloudDiagramsOff === true && settings.cloudDiagramsEnabled === true;
  } catch {
    return false;
  }
}

/** One-time: everyone starts with it off (it is experimental). True when it changed the settings. */
export function migrateCloudDiagramsOff(settings: Record<string, unknown>): boolean {
  if (settings._migratedCloudDiagramsOff === true) return false;
  settings.cloudDiagramsEnabled = false;
  settings._migratedCloudDiagramsOff = true;
  return true;
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
