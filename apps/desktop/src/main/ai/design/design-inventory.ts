/**
 * What a person can use on each screen of a task's design: buttons, links (and the screen each
 * opens), fields by their label, tabs and switches. Read from the designer's HTML by the app, so
 * the planner can give every element to a subtask and QA can look for each one in the built page.
 * A feature drawn on a screen but named by no acceptance criterion was dropped at every step in one
 * project (an assignee picker: the API had it, the app never did). No Electron imports.
 */

import { readFileSync } from 'node:fs';

import { designDir, designFile, realFileInside } from './design-step';

const MAX_LABEL = 80;
const MAX_ITEMS = 60;
const ROLES = new Set(['tab', 'switch', 'checkbox', 'radio', 'menuitem', 'button', 'link']);

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };

function decode(text: string): string {
  return text
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, name: string) => ENTITIES[name])
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
}

/** The text a person sees in a piece of markup, on one line. */
function visibleText(html: string): string {
  const text = decode(html.replace(/<(select|textarea)\b[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[^>]*>/g, ' '));
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL);
}

function attr(attrs: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs);
  if (!match) return undefined;
  return decode(match[1] ?? match[2] ?? match[3] ?? '').replace(/\s+/g, ' ').trim();
}

/** The markup a person never sees as part of the screen: scripts, styles, comments, the prototype's notes. */
function withoutNotes(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<aside\b([^>]*)>[\s\S]*?<\/aside\s*>/gi, (whole, attrs: string) => {
      const cls = attr(attrs, 'class') ?? '';
      const label = attr(attrs, 'aria-label') ?? '';
      return /(^|\s)proto(\s|$)/.test(cls) || /prototype|прототип/i.test(label) ? ' ' : whole;
    });
}

/** Where a link goes, when it is another screen of the design. */
function screenTarget(href: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('#')) return undefined;
  const file = href.split(/[?#]/)[0];
  return /\.html$/i.test(file) ? file : undefined;
}

/** The elements of one screen a person can use, in page order, each once. Never throws. */
export function screenInventory(html: string): string[] {
  const items: string[] = [];
  try {
    const page = withoutNotes(html);
    const labelled = new Set<string>();
    const insideLabel: Array<[number, number]> = [];
    // Labels first: the controls they name are listed by the label's text
    for (const m of page.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label\s*>/gi)) {
      const forId = attr(m[1], 'for');
      if (forId) labelled.add(forId);
      insideLabel.push([m.index, m.index + m[0].length]);
    }
    const inLabel = (at: number) => insideLabel.some(([from, to]) => at > from && at < to);

    const tag = /<([a-zA-Z][\w-]*)\b([^>]*)>/g;
    for (const m of page.matchAll(tag)) {
      const name = m[1].toLowerCase();
      const attrs = m[2];
      const start = m.index + m[0].length;
      const inner = () => {
        const close = new RegExp(`</${name}\\s*>`, 'i').exec(page.slice(start));
        return close ? page.slice(start, start + close.index) : '';
      };
      const role = attr(attrs, 'role')?.toLowerCase();
      const aria = attr(attrs, 'aria-label');
      const add = (kind: string, text: string | undefined, suffix = '') => {
        if (text) items.push(`${kind} «${text.slice(0, MAX_LABEL)}»${suffix}`);
      };

      if (name === 'label') {
        add('field', visibleText(inner()));
      } else if (name === 'a' && attr(attrs, 'href') !== undefined) {
        const text = aria || visibleText(inner());
        if (role === 'tab') add('tab', text);
        else {
          const target = screenTarget(attr(attrs, 'href') ?? '');
          add('link', text, target ? ` → ${target}` : '');
        }
      } else if (name === 'button' || name === 'summary') {
        add(role === 'switch' || role === 'tab' ? role : 'button', aria || visibleText(inner()));
      } else if (name === 'input' || name === 'select' || name === 'textarea') {
        const type = (attr(attrs, 'type') ?? '').toLowerCase();
        if (type === 'hidden' || inLabel(m.index)) continue;
        const id = attr(attrs, 'id');
        if (id && labelled.has(id)) continue;
        if (type === 'submit' || type === 'button') add('button', aria || attr(attrs, 'value'));
        else add(role === 'switch' ? 'switch' : 'field', aria || attr(attrs, 'placeholder') || attr(attrs, 'title'));
      } else if (role && ROLES.has(role)) {
        add(role === 'menuitem' ? 'menu item' : role, aria || visibleText(inner()));
      }
    }
  } catch {
    // a page the regexes can't read lists what was found so far
  }
  return collapseRows([...new Set(items)]).slice(0, MAX_ITEMS);
}

/** Rows of sample data (cards, table rows) that all open one screen: the first, and how many more. Pure. */
function collapseRows(items: string[]): string[] {
  const target = (item: string) => /^link «.*» → (\S+)$/.exec(item)?.[1];
  const counts = new Map<string, number>();
  for (const item of items) {
    const t = target(item);
    if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const listed = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const t = target(item);
    const count = t ? (counts.get(t) ?? 0) : 0;
    if (!t || count <= 2) {
      out.push(item);
    } else if (!listed.has(t)) {
      listed.add(t);
      out.push(`${item} (and ${count - 1} more like it)`);
    }
  }
  return out;
}

/**
 * The inventory of each screen file of the frames, in order. An element already listed for an
 * earlier screen (the app shell, a shared toolbar) is not repeated. Never throws.
 */
export function designInventories(specDir: string, frames: Array<{ file: string }>): Array<{ file: string; items: string[] }> {
  const seen = new Set<string>();
  const files = [...new Set(frames.map((f) => f.file))];
  const out: Array<{ file: string; items: string[] }> = [];
  for (const file of files) {
    const full = designFile(specDir, file);
    if (!full || !realFileInside(designDir(specDir), full)) continue;
    let html: string;
    try {
      html = readFileSync(full, 'utf-8');
    } catch {
      continue;
    }
    const items = screenInventory(html).filter((item) => !seen.has(item));
    for (const item of items) seen.add(item);
    if (items.length) out.push({ file, items });
  }
  return out;
}
