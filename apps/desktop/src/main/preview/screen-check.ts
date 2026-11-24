/**
 * The screen check: the app opens each screen of the project's catalog in the running app (no
 * model), and compares the picture with the last merge's. A task can break a screen it never
 * touched (a shared component, a global style); checking every screen with the QA agent would cost
 * a picture per screen per review, so the app does it and the agent judges only what changed. The
 * capture itself is Electron's (screen-capture.ts), passed in; this file has no Electron imports.
 */

import { copyFileSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { type ScreenCatalog, screenFile } from '../ai/design/screen-catalog';
import { type Bitmap, isChanged } from './screen-compare';

export interface ScreenShot {
  id: string;
  width: number;
  png?: Buffer;
  /** Why the screen could not be reached (a step's element never appeared, the page failed) */
  error?: string;
}

export interface ScreenCheckDeps {
  /** Opens the app at `baseUrl`, signs in, and takes each screen's picture */
  capture: (baseUrl: string, catalog: ScreenCatalog, signal?: AbortSignal) => Promise<ScreenShot[]>;
  /** A PNG's pixels */
  bitmap: (png: Buffer) => Bitmap;
}

export interface ScreenCheckResult {
  /** Screens that look different from the last merge's picture */
  changed: Array<{ id: string; width: number; before: string; after: string }>;
  unchanged: number;
  /** Screens with no picture from the last merge yet */
  added: Array<{ id: string; width: number }>;
  failed: Array<{ id: string; width: number; error: string }>;
}

/**
 * Captures the catalog's screens (all but `exclude`, the task's own) into `outDir/after`, and, with
 * a baseline, copies the last merge's picture of each changed screen into `outDir/before`.
 */
export async function runScreenCheck(
  input: { baseUrl: string; catalog: ScreenCatalog; baselineDir?: string; outDir: string; exclude?: Set<string>; signal?: AbortSignal },
  deps: ScreenCheckDeps,
): Promise<ScreenCheckResult> {
  const result: ScreenCheckResult = { changed: [], unchanged: 0, added: [], failed: [] };
  const screens = input.catalog.screens.filter((s) => !input.exclude?.has(s.id));
  if (!screens.length) return result;

  // The folder is in the spec directory, which agents write: a link put in its place is removed, never followed
  if (lstatSync(input.outDir, { throwIfNoEntry: false })?.isSymbolicLink()) rmSync(input.outDir, { force: true });
  mkdirSync(input.outDir, { recursive: true });
  if (!lstatSync(input.outDir).isDirectory()) throw new Error(`${input.outDir} is not a folder`);
  const afterDir = path.join(input.outDir, 'after');
  const beforeDir = path.join(input.outDir, 'before');
  rmSync(afterDir, { recursive: true, force: true });
  rmSync(beforeDir, { recursive: true, force: true });
  mkdirSync(afterDir, { recursive: true });

  const shots = await deps.capture(input.baseUrl, { ...input.catalog, screens }, input.signal);
  for (const shot of shots) {
    if (!shot.png) {
      result.failed.push({ id: shot.id, width: shot.width, error: shot.error ?? 'no picture' });
      continue;
    }
    const file = screenFile(shot);
    const after = path.join(afterDir, file);
    writeFileSync(after, shot.png);
    let previous: Buffer | null = null;
    try {
      previous = input.baselineDir ? readFileSync(path.join(input.baselineDir, file)) : null;
    } catch {
      previous = null;
    }
    if (!previous) {
      result.added.push({ id: shot.id, width: shot.width });
      continue;
    }
    if (!isChanged(deps.bitmap(previous), deps.bitmap(shot.png))) {
      result.unchanged++;
      continue;
    }
    mkdirSync(beforeDir, { recursive: true });
    const before = path.join(beforeDir, file);
    copyFileSync(path.join(input.baselineDir as string, file), before);
    result.changed.push({ id: shot.id, width: shot.width, before, after });
  }
  return result;
}
