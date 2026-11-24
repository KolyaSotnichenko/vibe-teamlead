import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { designInventories, screenInventory } from '../design-inventory';

const page = (body: string) => `<!doctype html><html><head><title>Card</title><style>button{color:red}</style></head><body>${body}<script>document.querySelector('button')</script></body></html>`;

describe('screenInventory', () => {
  it('lists what a person can use on the screen: buttons, links with where they go, fields by label, tabs, switches', () => {
    const html = page(`
      <header><a href="plans.html" class="back">← Назад</a></header>
      <main>
        <div role="tablist"><a role="tab" aria-selected="true" href="#">Деталі</a><button role="tab">Історія</button></div>
        <label for="title">Назва</label><input id="title" value="Звіт">
        <label>Колонка <select><option>До виконання</option></select></label>
        <label for="assignees">Виконавці</label><input id="assignees" role="combobox">
        <button type="button" aria-label="Додати виконавця"><svg></svg></button>
        <button class="mhp-btn">  Зберегти
          зміни </button>
        <input type="search" placeholder="Пошук за назвою">
        <button role="switch" aria-checked="true">Email</button>
        <a href="https://example.com/docs">Довідка</a>
      </main>`);
    expect(screenInventory(html)).toEqual([
      'link «← Назад» → plans.html',
      'tab «Деталі»',
      'tab «Історія»',
      'field «Назва»',
      'field «Колонка»',
      'field «Виконавці»',
      'button «Додати виконавця»',
      'button «Зберегти зміни»',
      'field «Пошук за назвою»',
      'switch «Email»',
      'link «Довідка»',
    ]);
  });

  it("leaves out the prototype's notes, scripts and styles, and lists each element once", () => {
    const html = page(`
      <main><button>Зберегти</button><button>Зберегти</button></main>
      <aside class="proto" aria-label="Нотатки прототипу"><p>Стани: <a href="card-empty.html">порожньо</a></p><button>Не частина</button></aside>
      <aside aria-label="Prototype notes"><a href="x.html">x</a></aside>
      <aside class="filters"><button>Фільтр</button></aside>`);
    expect(screenInventory(html)).toEqual(['button «Зберегти»', 'button «Фільтр»']);
  });

  it('lists rows of sample data that all open the same screen once, with how many there are', () => {
    const rows = ['Замовити насіння', 'Перевірити сівалки', 'Оновити карти'].map((t) => `<a href="task-card.html">${t}</a>`).join('');
    const html = page(`<nav><a href="plans.html">Плани</a></nav><main><a href="plans.html">Назад</a>${rows}</main>`);
    expect(screenInventory(html)).toEqual([
      'link «Плани» → plans.html',
      'link «Назад» → plans.html',
      'link «Замовити насіння» → task-card.html (and 2 more like it)',
    ]);
  });

  it('is empty for a page with nothing to use, and never throws', () => {
    expect(screenInventory(page('<main><h1>Порожньо</h1></main>'))).toEqual([]);
    expect(screenInventory('<button')).toEqual([]);
  });
});

describe('designInventories', () => {
  it("reads each frame's file once; elements an earlier screen listed (the app shell) are not repeated", () => {
    const specDir = mkdtempSync(path.join(tmpdir(), 'vt-inventory-'));
    const dir = path.join(specDir, 'design', 'screens');
    mkdirSync(dir, { recursive: true });
    const nav = '<nav><a href="my-tasks.html">Мої задачі</a></nav>';
    writeFileSync(path.join(dir, 'board.html'), page(`${nav}<main><button>Додати задачу</button></main>`));
    writeFileSync(path.join(dir, 'card.html'), page(`${nav}<main><label for="a">Виконавці</label><input id="a"></main>`));
    const frames = [
      { file: 'screens/board.html', width: 1280 },
      { file: 'screens/board.html', width: 390 },
      { file: 'screens/card.html', width: 1280 },
      { file: 'screens/missing.html', width: 1280 },
    ];
    expect(designInventories(specDir, frames)).toEqual([
      { file: 'screens/board.html', items: ['link «Мої задачі» → my-tasks.html', 'button «Додати задачу»'] },
      { file: 'screens/card.html', items: ['field «Виконавці»'] },
    ]);
  });
});
