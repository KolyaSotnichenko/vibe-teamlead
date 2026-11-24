import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { catalogPlace, readCatalog } from '../../ai/design/screen-catalog';
import { mergedCatalogFor, promoteMergeScreens } from '../screen-baseline';

describe("the merge's pictures", () => {
  it("become the baseline only when the merge succeeds, with the task's recipes added to the catalog", () => {
    const home = mkdtempSync(path.join(tmpdir(), 'vt-home-'));
    const place = catalogPlace('/p', home);
    mkdirSync(place.baseline, { recursive: true });
    writeFileSync(path.join(place.baseline, 'old.png'), 'old');
    mkdirSync(path.join(place.pending, 'after'), { recursive: true });
    writeFileSync(path.join(place.pending, 'after', 'new.png'), 'new');
    const specDir = mkdtempSync(path.join(tmpdir(), 'vt-spec-'));
    writeFileSync(path.join(specDir, 'screens.json'), JSON.stringify({ screens: [{ id: 'screens/a.html', width: 1280, path: '/a' }] }));

    const catalog = mergedCatalogFor(place, [specDir, '/nowhere']);
    expect(catalog.screens.map((s) => s.id)).toEqual(['screens/a.html']);
    // Nothing is kept before the merge has succeeded
    expect(readCatalog(place).screens).toEqual([]);

    promoteMergeScreens(place, catalog, true);
    expect(readCatalog(place).screens.map((s) => s.id)).toEqual(['screens/a.html']);
    expect(readFileSync(path.join(place.baseline, 'new.png'), 'utf-8')).toBe('new');
    expect(existsSync(path.join(place.baseline, 'old.png'))).toBe(false);
    expect(existsSync(place.pending)).toBe(false);
  });

  it('keeps the old baseline when the merge took no pictures (its check was not run again)', () => {
    const place = catalogPlace('/p', mkdtempSync(path.join(tmpdir(), 'vt-home-')));
    mkdirSync(place.baseline, { recursive: true });
    writeFileSync(path.join(place.baseline, 'old.png'), 'old');
    promoteMergeScreens(place, { screens: [] }, false);
    expect(existsSync(path.join(place.baseline, 'old.png'))).toBe(true);
  });
});
