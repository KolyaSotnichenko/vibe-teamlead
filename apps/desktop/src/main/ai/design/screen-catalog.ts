/**
 * The project's catalog of screens the app can open by itself: for each screen of the design
 * library (at a width), the path in the running app, the steps that reach the state (click, fill,
 * wait) and the parts that change on their own (dates, counters), plus how to sign in. The QA
 * reviewer records it in the spec directory (screens.json) as it shows its frames; when the task
 * merges the app adds it to the project's catalog, kept outside every folder an agent writes
 * (~/.vibe-teamlead/screens/<project>). The screen check (preview/screen-check.ts) replays it
 * without a model and compares the pictures with the last merge's. No Electron imports.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { writeFileReplacingSync } from '../safe-write';
import { designFileRef } from './visual-evidence';

/** One action on the page: click an element (by selector or by its text), type into a field, wait for an element */
export type ScreenStep =
  | { click: string | { text: string } }
  | { fill: { selector: string; text: string } }
  | { wait: string };

export interface ScreenRecipe {
  /** The library's name for the design file, e.g. screens/plan-board.html */
  id: string;
  width: number;
  /** Path in the app, from its root */
  path: string;
  steps: ScreenStep[];
  /** Selectors of parts that change on their own; hidden before the picture */
  mask: string[];
}

export interface ScreenCatalog {
  signIn?: { path: string; steps: ScreenStep[] };
  screens: ScreenRecipe[];
}

/** The file QA writes in the spec directory */
export const TASK_SCREENS_FILE = 'screens.json';

const MAX_SCREENS = 400;
const MAX_STEPS = 25;
const MAX_SELECTOR = 300;
const MAX_TEXT = 500;
const MAX_MASKS = 20;

/** Masks that would hide the whole page, and with it every difference */
const WHOLE_PAGE = /^\s*(html|body|:root|\*|#root|#app|#__next|main)\s*$/i;

const text = (value: unknown, max: number): string | undefined => (typeof value === 'string' && value.trim() && value.length <= max ? value : undefined);

/** A path inside the app: from its root, no scheme, no other host. */
function appPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2000) return undefined;
  if (!value.startsWith('/') || value.startsWith('//') || /[\\\s]/.test(value.split('?')[0])) return undefined;
  return value;
}

function step(raw: unknown): ScreenStep | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const s = raw as Record<string, unknown>;
  if ('click' in s) {
    const selector = text(s.click, MAX_SELECTOR);
    if (selector) return { click: selector };
    const byText = s.click && typeof s.click === 'object' ? text((s.click as Record<string, unknown>).text, MAX_TEXT) : undefined;
    return byText ? { click: { text: byText } } : undefined;
  }
  if ('fill' in s && s.fill && typeof s.fill === 'object') {
    const f = s.fill as Record<string, unknown>;
    const selector = text(f.selector, MAX_SELECTOR);
    const value = typeof f.text === 'string' && f.text.length <= MAX_TEXT ? f.text : undefined;
    return selector && value !== undefined ? { fill: { selector, text: value } } : undefined;
  }
  if ('wait' in s) {
    const selector = text(s.wait, MAX_SELECTOR);
    return selector ? { wait: selector } : undefined;
  }
  return undefined;
}

const steps = (raw: unknown): ScreenStep[] =>
  (Array.isArray(raw) ? raw : []).slice(0, MAX_STEPS).map(step).filter((s): s is ScreenStep => s !== undefined);

/** The library's name for a design file, from the task's design or the library; null for anything else. Pure. */
export function screenId(raw: unknown): string | null {
  const ref = designFileRef(raw);
  return ref ? ref.replace(/^base\//, '') : null;
}

/** A catalog from what QA or the app wrote, keeping only what can be replayed safely. Pure. */
export function parseScreens(raw: unknown): ScreenCatalog {
  if (!raw || typeof raw !== 'object') return { screens: [] };
  const r = raw as Record<string, unknown>;
  const catalog: ScreenCatalog = { screens: [] };
  if (r.signIn && typeof r.signIn === 'object') {
    const s = r.signIn as Record<string, unknown>;
    const at = appPath(s.path);
    if (at) catalog.signIn = { path: at, steps: steps(s.steps) };
  }
  for (const item of (Array.isArray(r.screens) ? r.screens : []).slice(0, MAX_SCREENS)) {
    if (!item || typeof item !== 'object') continue;
    const s = item as Record<string, unknown>;
    const id = screenId(s.id);
    const at = appPath(s.path);
    const width = typeof s.width === 'number' && Number.isInteger(s.width) && s.width >= 320 && s.width <= 2560 ? s.width : undefined;
    if (!id || !at || !width) continue;
    const mask = (Array.isArray(s.mask) ? s.mask : []).map((m) => text(m, MAX_SELECTOR)).filter((m): m is string => !!m && !WHOLE_PAGE.test(m)).slice(0, MAX_MASKS);
    catalog.screens.push({ id, width, path: at, steps: steps(s.steps), mask });
  }
  return catalog;
}

/** The catalog with a task's recipes: the same screen at the same width is replaced, a newer sign-in taken. Pure. */
export function mergeCatalog(current: ScreenCatalog, task: ScreenCatalog): ScreenCatalog {
  const key = (s: ScreenRecipe) => `${s.id}@${s.width}`;
  const incoming = new Map(task.screens.map((s) => [key(s), s]));
  const screens = current.screens.map((s) => incoming.get(key(s)) ?? s);
  const known = new Set(current.screens.map(key));
  for (const s of task.screens) if (!known.has(key(s))) screens.push(s);
  const signIn = task.signIn ?? current.signIn;
  return { ...(signIn ? { signIn } : {}), screens: screens.slice(0, MAX_SCREENS) };
}

/** Where a project's catalog and pictures are kept, outside the project */
export interface CatalogPlace {
  dir: string;
  catalog: string;
  /** The pictures of the last merge: what the next tasks are compared with */
  baseline: string;
  /** The pictures of a merge in progress, made the baseline when it succeeds */
  pending: string;
}

export function catalogPlace(projectDir: string, home = homedir()): CatalogPlace {
  const id = createHash('sha256').update(path.resolve(projectDir)).digest('hex').slice(0, 32);
  const dir = path.join(home, '.vibe-teamlead', 'screens', id);
  return { dir, catalog: path.join(dir, 'catalog.json'), baseline: path.join(dir, 'baseline'), pending: path.join(dir, 'pending') };
}

/** Never throws: an unreadable catalog is an empty one. */
export function readCatalog(place: CatalogPlace): ScreenCatalog {
  try {
    return parseScreens(JSON.parse(readFileSync(place.catalog, 'utf-8')));
  } catch {
    return { screens: [] };
  }
}

export function writeCatalog(place: CatalogPlace, catalog: ScreenCatalog): void {
  mkdirSync(place.dir, { recursive: true });
  writeFileReplacingSync(place.catalog, JSON.stringify(catalog, null, 2));
}

/** What QA recorded for this task (spec dir screens.json); empty without it. Never throws. */
export function readTaskScreens(specDir: string): ScreenCatalog {
  try {
    return parseScreens(JSON.parse(readFileSync(path.join(specDir, TASK_SCREENS_FILE), 'utf-8')));
  } catch {
    return { screens: [] };
  }
}

/** The picture's file name for a screen at a width. Pure. */
export function screenFile(screen: { id: string; width: number }): string {
  return `${screen.id.replace(/[^\w.-]/g, '_')}@${screen.width}.png`;
}
