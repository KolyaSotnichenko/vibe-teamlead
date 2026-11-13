/**
 * Shared settings utilities for main process
 *
 * This module provides low-level settings file operations used by both
 * the main process startup (index.ts) and the IPC handlers (settings-handlers.ts).
 *
 * NOTE: This module intentionally does NOT perform migrations or auto-detection.
 * Those are handled by the IPC handlers where they have full context.
 */

import { app } from 'electron';
import { existsSync, readFileSync, mkdirSync, renameSync } from 'fs';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { writeFileAtomicSync } from './utils/atomic-file';

/**
 * Get the path to the settings file
 */
export function getSettingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

/**
 * Read and parse settings from disk.
 * Returns the raw parsed settings object, or undefined if the file doesn't exist or fails to parse
 * (a file that doesn't parse is moved to `settings.json.corrupt`, never overwritten).
 *
 * This function does NOT merge with defaults or perform any migrations.
 * Callers are responsible for merging with DEFAULT_APP_SETTINGS.
 */
export function readSettingsFile(): Record<string, unknown> | undefined {
  const settingsPath = getSettingsPath();
  if (!existsSync(settingsPath)) {
    return undefined;
  }
  let content: string;
  try {
    content = readFileSync(settingsPath, 'utf-8');
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(content);
  } catch {
    // Unreadable settings are not "no settings": the next save would put the defaults over them
    setAsideCorruptSettings(settingsPath);
    return undefined;
  }
}

/** Moves a settings file that doesn't parse to `settings.json.corrupt`, so it can be recovered by hand. Never throws. */
function setAsideCorruptSettings(settingsPath: string): void {
  try {
    renameSync(settingsPath, `${settingsPath}.corrupt`);
  } catch {
    // Left where it is; the caller still gets "no settings"
  }
}

/**
 * Write settings to disk.
 *
 * @param settings - The settings object to write
 */
export function writeSettingsFile(settings: object): void {
  const settingsPath = getSettingsPath();

  // Ensure the directory exists
  const dir = path.dirname(settingsPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // A temporary file renamed into place: a crash mid-write can't leave half a file
  writeFileAtomicSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
}

/**
 * Read and parse settings from disk asynchronously.
 * Returns the raw parsed settings object, or undefined if the file doesn't exist or fails to parse.
 *
 * This is the non-blocking version of readSettingsFile, safe to use in Electron main process
 * without blocking the event loop.
 *
 * This function does NOT merge with defaults or perform any migrations.
 * Callers are responsible for merging with DEFAULT_APP_SETTINGS.
 */
export async function readSettingsFileAsync(): Promise<Record<string, unknown> | undefined> {
  const settingsPath = getSettingsPath();

  let content: string;
  try {
    // Read directly — no separate access() check to avoid TOCTOU race
    content = await fsPromises.readFile(settingsPath, 'utf-8');
  } catch {
    // No file yet (or unreadable): the caller uses the defaults
    return undefined;
  }
  try {
    return JSON.parse(content);
  } catch {
    setAsideCorruptSettings(settingsPath);
    return undefined;
  }
}
