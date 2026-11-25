import { describe, expect, it, vi } from 'vitest';

import type { ScreenCatalog } from '../screen-catalog';
import { accountFor, builtElementsOf, capturePages, elementRefusal, isFound, normalizeLabel, unfoundElements, type BuiltElement } from '../element-check';

const el = (kind: string, ...names: string[]): BuiltElement => ({ kind, names });
const page = (file: string, items: string[], elements: BuiltElement[], width = 1280) => ({ file, width, items, elements });

describe('the labels, normalised', () => {
  it('ignores case, spacing and the dots or colon at the end', () => {
    expect(normalizeLabel('  Додати   задачу… ')).toBe('додати задачу');
    expect(normalizeLabel('Пошук:')).toBe('пошук');
    expect(normalizeLabel('Ще...')).toBe('ще');
  });

  it('reads every apostrophe the same', () => {
    const forms = ['Обʼєкти', 'Об’єкти', "Об'єкти", 'Об`єкти'].map(normalizeLabel);
    expect(new Set(forms).size).toBe(1);
  });
});

describe('a mockup element found on the built page', () => {
  it('by the same name, or a name that holds the other', () => {
    expect(isFound('Виконавці', ['виконавці'])).toBe(true);
    expect(isFound('Додати задачу', ['Додати задачу до колонки'])).toBe(true);
    expect(isFound('Налаштування колонки «Готово»', ['Налаштування колонки'])).toBe(true);
    expect(isFound('Видалити план', ['Зберегти'])).toBe(false);
  });

  // «Плани» in the navigation is not the page's «Плани команди та відділів»: a small part of a label is another element
  it('a built name that is only a small part of the label is not it', () => {
    expect(isFound('Плани команди та відділів', ['Плани'])).toBe(false);
    expect(isFound('Історія плану', ['Історія'])).toBe(true);
    expect(isFound('Додати', ['Додати задачу в колонку «До виконання»'])).toBe(true);
  });

  it('a short name must be the whole name', () => {
    expect(isFound('Так', ['Так, видалити'])).toBe(false);
    expect(isFound('Так', ['так'])).toBe(true);
  });

  it('a "prefix: sample" label by any name with the same prefix', () => {
    expect(isFound('Меню користувача: Олена Коваленко-Шевчук', ['Меню користувача: Іван Петренко'])).toBe(true);
    expect(isFound('Перетягнути пункт: Запросити прайс', ['Перетягнути пункт: Купити насіння'])).toBe(true);
    expect(isFound('Перетягнути пункт: Запросити прайс', ['Перетягнути: Купити насіння'])).toBe(false);
  });

  it('with the apostrophe the app uses', () => {
    expect(isFound("Обʼєкти обліку", ['Об’єкти обліку'])).toBe(true);
  });
});

// The list comes from a page the agents built: only its strings are kept, and not without end
describe('what the built page reported', () => {
  it('is kept as kinds and names: anything else is dropped, a list that is not one is no page', () => {
    expect(builtElementsOf([{ kind: 'button', names: ['Зберегти', 7, '', 'x'.repeat(500)] }, { kind: 3, names: ['a'] }, null, { kind: 'link', names: 'no' }, { kind: 'link', names: [] }])).toEqual([
      { kind: 'button', names: ['Зберегти', 'x'.repeat(200)] },
      { kind: 'field', names: ['a'] },
    ]);
    expect(builtElementsOf('nope')).toBeNull();
    expect(builtElementsOf({ length: 2 })).toBeNull();
  });

  it('is cut at a number of elements and of names', () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ kind: 'button', names: Array.from({ length: 30 }, (_, n) => `b${i}-${n}`) }));
    const kept = builtElementsOf(many) as BuiltElement[];
    expect(kept).toHaveLength(2000);
    expect(kept[0].names).toHaveLength(8);
  });
});

describe('the elements of the mockups not on the built pages', () => {
  it('lists one the page lacks, with its frame', () => {
    const { looked, unfound } = unfoundElements([page('screens/board.html', ['button «Додати задачу»', 'field «Виконавці»'], [el('button', 'Додати задачу')])]);
    expect(looked).toBe(2);
    expect(unfound).toEqual([{ file: 'screens/board.html', width: 1280, item: 'field «Виконавці»', label: 'Виконавці' }]);
  });

  it('ignores the kind: a link of the mockup may be a button in the app', () => {
    const { unfound } = unfoundElements([page('screens/board.html', ['link «Налаштування плану» → plan-settings.html', 'tab «Історія»'], [el('button', 'Налаштування плану'), el('link', 'Історія')])]);
    expect(unfound).toEqual([]);
  });

  it('never asks for sample rows', () => {
    const { looked, unfound } = unfoundElements([page('screens/board.html', ['link «Запросити прайс» → task-card.html (and 10 more like it)'], [])]);
    expect(looked).toBe(0);
    expect(unfound).toEqual([]);
  });

  it('an element of several screens is looked for once, and found on any of them', () => {
    const shell = 'button «Меню користувача: Олена Коваленко-Шевчук»';
    const found = unfoundElements([
      page('screens/board.html', [shell, 'button «Додати задачу»'], [el('button', 'Додати задачу')]),
      page('screens/card.html', [shell], [el('button', 'Меню користувача: Іван')]),
    ]);
    expect(found).toEqual({ looked: 2, unfound: [] });
    const missing = unfoundElements([page('screens/board.html', [shell], []), page('screens/card.html', [shell], [])]);
    expect(missing.unfound).toEqual([{ file: 'screens/board.html', width: 1280, item: shell, label: 'Меню користувача: Олена Коваленко-Шевчук' }]);
  });

  it('a screen at two widths: found at either', () => {
    const { unfound } = unfoundElements([
      page('screens/board.html', ['field «Виконавці»'], [], 390),
      page('screens/board.html', ['field «Виконавці»'], [el('field', 'Виконавці')], 1280),
    ]);
    expect(unfound).toEqual([]);
  });
});

describe('what the reviewer accounted for', () => {
  const unfound = [
    { file: 'screens/board.html', width: 1280, item: 'field «Виконавці»', label: 'Виконавці' },
    { file: 'screens/board.html', width: 1280, item: 'button «Налаштування колонки»', label: 'Налаштування колонки' },
  ];

  it('an element a difference of its frame names is accounted for; the rest are not', () => {
    const differences = new Map([['screens/board.html', ['«виконавці…» is sample data of the mockup: the plan has no assignees']]]);
    expect(accountFor(unfound, differences)).toEqual({ accounted: [unfound[0]], unaccounted: [unfound[1]] });
  });

  it('a difference of another screen does not count', () => {
    const differences = new Map([['screens/card.html', ['Виконавці: sample data']]]);
    expect(accountFor(unfound, differences).unaccounted).toEqual(unfound);
  });
});

describe('the refusal', () => {
  it('lists the elements per frame and says what to do', () => {
    const text = elementRefusal({
      unaccounted: [{ file: 'screens/board.html', width: 1280, item: 'field «Виконавці»', label: 'Виконавці' }],
      unreachable: [],
    });
    expect(text).toMatch(/^Error: approval not recorded/);
    expect(text).toContain('screens/board.html at 1280 px: field «Виконавці»');
    expect(text).toMatch(/blocking difference/);
    expect(text).toMatch(/minor difference/);
    expect(text).toContain('design_compare.json');
  });

  it('asks for a fixed recipe for a frame the app could not open', () => {
    const text = elementRefusal({ unaccounted: [], unreachable: [{ file: 'screens/card.html', width: 390, error: 'not found: "#card"' }] });
    expect(text).toContain('screens/card.html at 390 px');
    expect(text).toContain('not found: "#card"');
    expect(text).toContain('screens.json');
  });

  it('keeps the list short', () => {
    const many = Array.from({ length: 45 }, (_, i) => ({ file: 'screens/board.html', width: 1280, item: `button «Кнопка ${i}»`, label: `Кнопка ${i}` }));
    const text = elementRefusal({ unaccounted: many, unreachable: [] });
    expect(text).toContain('Кнопка 29»');
    expect(text).not.toContain('Кнопка 30»');
    expect(text).toContain('…and 15 more');
  });
});

describe('the pages the app opens, by the reviewer\'s recipes', () => {
  const catalog: ScreenCatalog = {
    signIn: { path: '/login', steps: [] },
    screens: [
      { id: 'screens/board.html', width: 1280, path: '/board', steps: [], mask: ['.due'] },
      { id: 'screens/plan-board.html', width: 1280, path: '/plans/1', steps: [], mask: [] },
    ],
  };

  it('opens each frame by the recipe of its library id and width, and says which has none', async () => {
    const capture = vi.fn(async (_url: string, c: ScreenCatalog) => c.screens.map((s) => ({ id: s.id, width: s.width, elements: [el('button', s.path)] })));
    const pages = await capturePages('http://localhost:3000', catalog, [
      { file: 'screens/board.html', width: 1280 },
      { file: 'base/screens/plan-board.html', width: 1280 },
      { file: 'screens/board.html', width: 390 },
    ], capture);
    expect(capture.mock.calls[0][1].signIn).toEqual(catalog.signIn);
    expect(capture.mock.calls[0][1].screens.map((s: { id: string }) => s.id)).toEqual(['screens/board.html', 'screens/plan-board.html']);
    expect(pages[0]).toEqual({ file: 'screens/board.html', width: 1280, elements: [el('button', '/board')] });
    expect(pages[1]).toEqual({ file: 'base/screens/plan-board.html', width: 1280, elements: [el('button', '/plans/1')] });
    expect(pages[2].elements).toBeUndefined();
    expect(pages[2].error).toMatch(/screens\.json has no recipe for screens\/board\.html at 390 px/);
  });

  it('passes on why a frame could not be reached', async () => {
    const capture = async () => [{ id: 'screens/board.html', width: 1280, error: 'sign-in failed: not found: "#login"' }];
    const pages = await capturePages('http://localhost:3000', catalog, [{ file: 'screens/board.html', width: 1280 }], capture);
    expect(pages).toEqual([{ file: 'screens/board.html', width: 1280, error: 'sign-in failed: not found: "#login"' }]);
  });
});
