import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { catalogPlace, mergeCatalog, parseScreens, readCatalog, screenFile, screenId, writeCatalog } from '../screen-catalog';

describe('parseScreens', () => {
  it('keeps the sign-in and each screen recipe QA recorded: path, width, steps, parts left out', () => {
    const catalog = parseScreens({
      signIn: { path: '/sign-in', steps: [{ click: { text: 'Увійти як адміністратор' } }] },
      screens: [
        {
          id: 'design/base/screens/plan-board.html',
          width: 1280,
          path: '/plans',
          steps: [{ click: { text: 'Агрономія: посівна 2027' } }, { wait: '[aria-label="Board columns"]' }, { fill: { selector: '#q', text: 'насіння' } }],
          mask: ['.due-date'],
        },
      ],
    });
    expect(catalog).toEqual({
      signIn: { path: '/sign-in', steps: [{ click: { text: 'Увійти як адміністратор' } }] },
      screens: [
        {
          id: 'screens/plan-board.html',
          width: 1280,
          path: '/plans',
          steps: [{ click: { text: 'Агрономія: посівна 2027' } }, { wait: '[aria-label="Board columns"]' }, { fill: { selector: '#q', text: 'насіння' } }],
          mask: ['.due-date'],
        },
      ],
    });
  });

  it('drops what it cannot replay safely: another site, a script, an unknown step, a bad width or id', () => {
    const catalog = parseScreens({
      signIn: { path: 'https://evil.example/login', steps: [] },
      screens: [
        { id: 'screens/a.html', width: 1280, path: '//evil.example/x' },
        { id: 'screens/b.html', width: 1280, path: 'javascript:alert(1)' },
        { id: 'screens/c.html', width: 99999, path: '/c' },
        { id: '../../etc/passwd', width: 1280, path: '/d' },
        { id: 'screens/e.html', width: 390, path: '/e', steps: [{ eval: 'x' }, { click: '#ok' }] },
      ],
    });
    expect(catalog.signIn).toBeUndefined();
    expect(catalog.screens).toEqual([{ id: 'screens/e.html', width: 390, path: '/e', steps: [{ click: '#ok' }], mask: [] }]);
  });

  it('is empty for anything that is not a catalog', () => {
    expect(parseScreens(null)).toEqual({ screens: [] });
    expect(parseScreens('x')).toEqual({ screens: [] });
  });
});

describe('screenId', () => {
  it("is the library's name for a design file, from the task's design or the library", () => {
    expect(screenId('design/base/screens/plan-board.html')).toBe('screens/plan-board.html');
    expect(screenId('base/screens/plan-board.html')).toBe('screens/plan-board.html');
    expect(screenId('screens/plan-board.html')).toBe('screens/plan-board.html');
    expect(screenId('src/App.tsx')).toBeNull();
  });
});

describe('mergeCatalog', () => {
  it("adds a task's recipes, replacing the same screen at the same width, and takes its newer sign-in", () => {
    const old = { signIn: { path: '/old', steps: [] }, screens: [{ id: 'screens/a.html', width: 1280, path: '/a', steps: [], mask: [] }, { id: 'screens/b.html', width: 1280, path: '/b', steps: [], mask: [] }] };
    const task = { signIn: { path: '/sign-in', steps: [] }, screens: [{ id: 'screens/a.html', width: 1280, path: '/a2', steps: [], mask: [] }, { id: 'screens/c.html', width: 390, path: '/c', steps: [], mask: [] }] };
    expect(mergeCatalog(old, task)).toEqual({
      signIn: { path: '/sign-in', steps: [] },
      screens: [
        { id: 'screens/a.html', width: 1280, path: '/a2', steps: [], mask: [] },
        { id: 'screens/b.html', width: 1280, path: '/b', steps: [], mask: [] },
        { id: 'screens/c.html', width: 390, path: '/c', steps: [], mask: [] },
      ],
    });
    expect(mergeCatalog(old, { screens: [] }).signIn).toEqual({ path: '/old', steps: [] });
  });
});

describe('the catalog on disk', () => {
  it("lives outside the project, one folder per project, and reads back what was written", () => {
    const home = mkdtempSync(path.join(tmpdir(), 'vt-catalog-'));
    const place = catalogPlace('/Users/x/project', home);
    expect(place.dir.startsWith(home)).toBe(true);
    expect(catalogPlace('/Users/x/other', home).dir).not.toBe(place.dir);
    expect(readCatalog(place)).toEqual({ screens: [] });
    const catalog = { screens: [{ id: 'screens/a.html', width: 1280, path: '/a', steps: [], mask: [] }] };
    writeCatalog(place, catalog);
    expect(readCatalog(place)).toEqual(catalog);
    writeFileSync(place.catalog, 'not json');
    expect(readCatalog(place)).toEqual({ screens: [] });
  });

  it('names each picture by its screen and width, safely', () => {
    expect(screenFile({ id: 'screens/plan-board.html', width: 390 })).toBe('screens_plan-board.html@390.png');
  });
});
