/**
 * The scripts the screen check runs in the app's page to reach a screen: a click, typing into a
 * field, waiting for an element, hiding the parts that change on their own, and moving to a path
 * inside the app. Each is a self-contained expression that resolves to { ok, error? }; selectors and
 * text go in as JSON, never as code. Pure (the strings are run by screen-check.ts).
 */

import type { ScreenStep } from '../ai/design/screen-catalog';

/** How long a step waits for its element */
export const STEP_WAIT_MS = 8000;

/** Finds an element by selector or by what it says, waiting for it to appear. Shared by the scripts. */
const FIND = `
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const byText = (text) => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const want = norm(text);
  const all = [...document.querySelectorAll('a, button, [role="button"], [role="tab"], [role="link"], [role="menuitem"], [role="option"], label, summary, li, td, h1, h2, h3')];
  return all.find((el) => norm(el.innerText ?? el.textContent) === want || norm(el.getAttribute('aria-label')) === want)
    || all.find((el) => norm(el.innerText ?? el.textContent).includes(want));
};
const find = async (target, wait) => {
  const until = Date.now() + wait;
  for (;;) {
    let el = null;
    try { el = typeof target === 'string' ? document.querySelector(target) : byText(target.text); } catch (e) { return { error: 'bad selector ' + JSON.stringify(target) }; }
    if (el) return { el };
    if (Date.now() > until) return { error: 'not found: ' + JSON.stringify(target) };
    await sleep(100);
  }
};`;

/** The script for one step. */
export function stepScript(step: ScreenStep, waitMs = STEP_WAIT_MS): string {
  const data = JSON.stringify({ step, waitMs });
  return `(async () => {
${FIND}
  const { step, waitMs } = ${data};
  try {
    if ('click' in step) {
      const found = await find(step.click, waitMs);
      if (found.error) return { ok: false, error: found.error };
      found.el.scrollIntoView?.({ block: 'center' });
      found.el.click();
    } else if ('fill' in step) {
      const found = await find(step.fill.selector, waitMs);
      if (found.error) return { ok: false, error: found.error };
      const el = found.el;
      el.focus?.();
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, step.fill.text); else el.value = step.fill.text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if ('wait' in step) {
      const found = await find(step.wait, waitMs);
      if (found.error) return { ok: false, error: found.error };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
})()`;
}

/** The script that hides the parts that change on their own, before the picture. */
export function maskScript(selectors: string[]): string {
  return `(async () => {
  const hidden = new Set();
  for (const selector of ${JSON.stringify(selectors)}) {
    try { document.querySelectorAll(selector).forEach((el) => hidden.add(el)); } catch (e) {}
  }
  // A mask that hides most of the page would hide every difference with it: the screen fails instead
  const page = Math.max(1, document.documentElement.scrollWidth * document.documentElement.scrollHeight);
  let covered = 0;
  for (const el of hidden) {
    if (el === document.documentElement || el === document.body) return { ok: false, error: 'a mask hides the whole page' };
    const r = el.getBoundingClientRect();
    covered += Math.max(0, r.width) * Math.max(0, r.height);
  }
  if (covered > page / 2) return { ok: false, error: 'the masks hide most of the page' };
  const kept = (window.__vtMasked = window.__vtMasked || []);
  hidden.forEach((el) => { kept.push([el, el.style.visibility]); el.style.visibility = 'hidden'; });
  return { ok: true };
})()`;
}

/** The script that shows again what the masks hid: the app is not reloaded between screens. */
export function unmaskScript(): string {
  return `(async () => {
  for (const [el, visibility] of (window.__vtMasked || [])) el.style.visibility = visibility;
  window.__vtMasked = [];
  return { ok: true };
})()`;
}

/** The script that moves the app to a path the way its router does, without reloading the page. */
export function navigateScript(appPath: string): string {
  return `(async () => {
  history.pushState(null, '', ${JSON.stringify(appPath)});
  dispatchEvent(new PopStateEvent('popstate', { state: null }));
  return { ok: true };
})()`;
}
