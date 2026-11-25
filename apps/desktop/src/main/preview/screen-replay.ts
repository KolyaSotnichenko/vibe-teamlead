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

/** The most elements one page reports */
export const MAX_PAGE_ELEMENTS = 2000;

/**
 * The script that lists what a person can use on the page (element-check.ts): every visible
 * button, link, field, summary and element with a control's role, by its kind and its names (the
 * accessible name first: aria-label, aria-labelledby, its label, its text, placeholder, title, a
 * submit's value). Reads the page; changes nothing.
 */
export function elementsScript(): string {
  return `(async () => {
  const max = ${MAX_PAGE_ELEMENTS};
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim().slice(0, 200);
  const SKIP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'SELECT', 'TEXTAREA', 'OPTION', 'DATALIST']);
  const BLOCK = /^(DIV|P|LI|UL|OL|BR|TD|TH|TR|H[1-6]|SECTION|ARTICLE|HEADER|FOOTER|NAV|ASIDE|DL|DT|DD)$/;
  const ROLES = { tab: 'tab', switch: 'switch', checkbox: 'checkbox', radio: 'radio', menuitem: 'menu item', button: 'button', link: 'link' };
  const textOf = (node) => {
    let out = '';
    for (const child of node.childNodes) {
      if (child.nodeType === 3) out += child.nodeValue;
      else if (child.nodeType === 1 && !SKIP.has(child.tagName) && !child.hidden) {
        const text = child.tagName === 'IMG' ? child.getAttribute('alt') || '' : textOf(child);
        out += BLOCK.test(child.tagName) ? ' ' + text + ' ' : text;
      }
    }
    return out;
  };
  const shown = (el) => {
    if (el.closest('[hidden]')) return false;
    if (typeof el.checkVisibility === 'function') return el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true });
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (getComputedStyle(n).display === 'none') return false;
    }
    const visibility = getComputedStyle(el).visibility;
    return visibility !== 'hidden' && visibility !== 'collapse';
  };
  const kindOf = (el) => {
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (ROLES[role]) return ROLES[role];
    const tag = el.tagName;
    if (tag === 'A') return 'link';
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if (tag === 'INPUT') {
      const type = (el.type || '').toLowerCase();
      if (type === 'checkbox' || type === 'radio') return type;
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button';
    }
    return 'field';
  };
  try {
    const elements = [];
    const all = document.querySelectorAll('button, a[href], input, select, textarea, summary, [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], [role="menuitem"], [role="button"], [role="link"]');
    for (const el of all) {
      if (elements.length >= max) break;
      if (el.tagName === 'INPUT' && (el.type || '').toLowerCase() === 'hidden') continue;
      if (!shown(el)) continue;
      const names = [];
      const add = (s) => { const name = norm(s); if (name && !names.includes(name)) names.push(name); };
      add(el.getAttribute('aria-label'));
      const by = el.getAttribute('aria-labelledby');
      if (by) add(by.split(/\\s+/).map((id) => { const n = document.getElementById(id); return n ? textOf(n) : ''; }).join(' '));
      for (const l of el.labels || []) add(textOf(l));
      const control = el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA';
      if (!control) add(textOf(el));
      add(el.getAttribute('placeholder'));
      add(el.getAttribute('title'));
      if (el.tagName === 'INPUT' && kindOf(el) === 'button') add(el.value);
      if (names.length) elements.push({ kind: kindOf(el), names });
    }
    return { ok: true, elements };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
})()`;
}
