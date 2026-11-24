/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';

import { maskScript, navigateScript, stepScript } from '../screen-replay';

const run = (script: string) => (0, eval)(script) as Promise<{ ok: boolean; error?: string }>;

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
