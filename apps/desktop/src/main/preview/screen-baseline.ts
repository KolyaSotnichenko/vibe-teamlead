/**
 * The screen check's baseline: the pictures the merge's check took of the code that becomes main.
 * They replace the baseline, and the task's recorded recipes join the project's catalog, only when
 * the merge succeeds. No Electron imports.
 */

import { existsSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';

import { type CatalogPlace, type ScreenCatalog, mergeCatalog, readCatalog, readTaskScreens, writeCatalog } from '../ai/design/screen-catalog';

/**
 * The project's catalog with what QA recorded for the task (the first spec folder that has it),
 * only for the task's own screens (`own`, library ids): a task can't rewrite how other screens are
 * reached. Never throws.
 */
export function mergedCatalogFor(place: CatalogPlace, specDirs: string[], own: Set<string>): ScreenCatalog {
  const current = readCatalog(place);
  for (const dir of specDirs) {
    const task = readTaskScreens(dir);
    const screens = task.screens.filter((s) => own.has(s.id));
    if (screens.length) return mergeCatalog(current, { ...task, screens });
  }
  return current;
}

/** After a successful merge: keep the catalog, and make the merge's pictures the baseline when it took them. Never throws. */
export function promoteMergeScreens(place: CatalogPlace, catalog: ScreenCatalog, captured: boolean): void {
  try {
    writeCatalog(place, catalog);
    const pictures = path.join(place.pending, 'after');
    if (captured && existsSync(pictures)) {
      rmSync(place.baseline, { recursive: true, force: true });
      renameSync(pictures, place.baseline);
    }
  } catch {
    // the next merge tries again
  } finally {
    rmSync(place.pending, { recursive: true, force: true });
  }
}
