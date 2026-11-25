/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';

import { elementsScript, maskScript, navigateScript, stepScript, unmaskScript } from '../screen-replay';

// The scripts are expressions the app runs in the page; here they run in jsdom's
const run = (script: string) => new Function(`return ${script}`)() as Promise<{ ok: boolean; error?: string }>;

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the steps, run in the page', () => {
  it('clicks an element by selector, or the button or link that says a text', async () => {
    const clicked: string[] = [];
    document.body.innerHTML = '<button id="a">Перший</button><a href="#x">Агрономія: посівна 2027</a>';
    document.getElementById('a')!.addEventListener('click', () => clicked.push('a'));
    document.querySelector('a')!.addEventListener('click', (e) => {
      e.preventDefault();
      clicked.push('link');
    });
    expect(await run(stepScript({ click: '#a' }))).toEqual({ ok: true });
    expect(await run(stepScript({ click: { text: 'Агрономія: посівна 2027' } }))).toEqual({ ok: true });
    expect(clicked).toEqual(['a', 'link']);
  });

  it('types into a field the way a person does, so the app sees the change', async () => {
    document.body.innerHTML = '<input id="q">';
    const seen: string[] = [];
    document.getElementById('q')!.addEventListener('input', (e) => seen.push((e.target as HTMLInputElement).value));
    expect(await run(stepScript({ fill: { selector: '#q', text: 'насіння' } }))).toEqual({ ok: true });
    expect(seen).toEqual(['насіння']);
  });

  it('waits for an element that appears later, and says which one never did', async () => {
    setTimeout(() => {
      document.body.innerHTML = '<section aria-label="Board columns"></section>';
    }, 50);
    expect(await run(stepScript({ wait: '[aria-label="Board columns"]' }, 2000))).toEqual({ ok: true });
    const missing = await run(stepScript({ click: '#nope' }, 100));
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain('#nope');
  });

  it('hides the parts that change on their own', async () => {
    document.body.innerHTML = '<span class="due">24.11</span><span class="due">25.11</span><p>stays</p>';
    await run(maskScript(['.due']));
    expect([...document.querySelectorAll<HTMLElement>('.due')].map((e) => e.style.visibility)).toEqual(['hidden', 'hidden']);
    expect(document.querySelector('p')!.style.visibility).toBe('');
  });

  it("shows again what a screen's masks hid, so the next screen is pictured whole", async () => {
    document.body.innerHTML = '<span class="due">24.11</span><header>shell</header>';
    await run(maskScript(['.due']));
    await run(unmaskScript());
    expect(document.querySelector<HTMLElement>('.due')!.style.visibility).toBe('');
  });

  it('refuses a mask that hides the whole page', async () => {
    document.body.innerHTML = '<p>content</p>';
    expect((await run(maskScript(['body']))).ok).toBe(false);
    expect(document.body.style.visibility).toBe('');
  });

  it('moves to a path inside the app without reloading it, so a sign-in kept in memory stays', async () => {
    const seen: string[] = [];
    window.addEventListener('popstate', () => seen.push(location.pathname));
    await run(navigateScript('/plans?view=board'));
    expect(location.pathname).toBe('/plans');
    expect(location.search).toBe('?view=board');
    expect(seen).toEqual(['/plans']);
  });

  it('passes selectors and text as data: a quote in them cannot break out of the script', async () => {
    document.body.innerHTML = '<button>it\'s "fine"</button>';
    expect(await run(stepScript({ click: { text: 'it\'s "fine"' } }))).toEqual({ ok: true });
    expect((await run(stepScript({ click: "'); throw 1; ('" }, 50))).ok).toBe(false);
  });
});

describe('what a person can use on the built page, collected in the page', () => {
  type Collected = { ok: boolean; elements: Array<{ kind: string; names: string[] }> };
  const collect = () => new Function(`return ${elementsScript()}`)() as Promise<Collected>;
  const named = (result: Collected, name: string) => result.elements.find((e) => e.names.includes(name));

  it('names a field by its label, wrapping or by for, its aria-label or its placeholder', async () => {
    document.body.innerHTML = `
      <label for="who">Виконавці</label><select id="who"><option>Олена</option></select>
      <label>Назва задачі <input id="title"></label>
      <input aria-label="Пошук задач" placeholder="Пошук">
      <span id="due-label">Термін</span><input aria-labelledby="due-label">
      <textarea placeholder="Опис"></textarea>`;
    const result = await collect();
    expect(result.ok).toBe(true);
    expect(named(result, 'Виконавці')?.kind).toBe('field');
    expect(named(result, 'Назва задачі')?.kind).toBe('field');
    expect(named(result, 'Пошук задач')?.names).toEqual(['Пошук задач', 'Пошук']);
    expect(named(result, 'Термін')).toBeDefined();
    expect(named(result, 'Опис')).toBeDefined();
    // The options of a select are not the name of the field around it
    expect(result.elements.some((e) => e.names.some((n) => n.includes('Олена')))).toBe(false);
  });

  it('names buttons, links, tabs and switches by aria-label, text, an image\'s alt, title or a submit\'s value', async () => {
    document.body.innerHTML = `
      <button>Додати <b>задачу</b></button>
      <a href="/plans/1/settings">Налаштування плану</a>
      <div role="tab">Історія</div>
      <button role="switch" aria-label="Лише мої"></button>
      <button><img alt="Закрити"></button>
      <button title="Ще дії">⋯</button>
      <input type="submit" value="Зберегти">
      <details><summary>Фільтри</summary></details>`;
    const result = await collect();
    expect(named(result, 'Додати задачу')?.kind).toBe('button');
    expect(named(result, 'Налаштування плану')?.kind).toBe('link');
    expect(named(result, 'Історія')?.kind).toBe('tab');
    expect(named(result, 'Лише мої')?.kind).toBe('switch');
    expect(named(result, 'Закрити')).toBeDefined();
    expect(named(result, 'Ще дії')).toBeDefined();
    expect(named(result, 'Зберегти')?.kind).toBe('button');
    expect(named(result, 'Фільтри')).toBeDefined();
  });

  it('skips what a person cannot see, and a link with no address', async () => {
    document.body.innerHTML = `
      <div style="display:none"><button>У прихованому</button></div>
      <button hidden>Прихована</button>
      <button style="visibility:hidden">Невидима</button>
      <input type="hidden" value="x" aria-label="Схована">
      <a>Без адреси</a>
      <button>Видима</button>`;
    const result = await collect();
    expect(result.elements.flatMap((e) => e.names)).toEqual(['Видима']);
  });
});
