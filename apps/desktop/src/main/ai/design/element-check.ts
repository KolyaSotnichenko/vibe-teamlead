/**
 * The element check: after the QA reviewer approves a task with a design, the app itself opens
 * each frame the reviewer showed in the running app, by the reviewer's recipes (screens.json), and
 * looks on the built page for every element a person can use on the mockup (design-inventory.ts).
 * In one project an assignee picker and column controls drawn on the mockups were never built,
 * and every task passed: finding them was left to the reviewer's judgement, and agents' own reports
 * never count as proof. An element not found must be named by a difference of its frame in
 * design_compare.json (minor, with why: sample data, or another name), or the approval is refused.
 * The pictures are Electron's (preview/screen-capture.ts, in the main process), passed in; this
 * file has no Electron imports.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { writeFileReplacingSync } from '../safe-write';
import { screenInventoryStrict } from './design-inventory';
import { designDir, designFile, realFileInside } from './design-step';
import { type ScreenCatalog, type ScreenRecipe, TASK_SCREENS_FILE, screenId } from './screen-catalog';
import { COMPARE_FILE, type EvidenceFrame, type NotShownFrame } from './visual-evidence';

/** Something a person can use on the built page: its kind and its names (the accessible name first) */
export interface BuiltElement {
  kind: string;
  names: string[];
}

/** One frame opened in the running app: what its page had, or why it could not be reached */
export interface FramePage extends EvidenceFrame {
  elements?: BuiltElement[];
  error?: string;
}

/** An element of a frame's mockup the app did not find on the built page */
export interface UnfoundElement extends EvidenceFrame {
  /** As the inventory lists it, e.g. field «Виконавці» */
  item: string;
  label: string;
}

export interface ElementCheckOutcome {
  /** Not found, and named by no difference of the frame: the approval is refused */
  unaccounted: UnfoundElement[];
  /** Frames the app could not open by their recipe, for the first time: the reviewer fixes the recipe */
  unreachable: Array<EvidenceFrame & { error: string }>;
  /** Frames the app could not open again: carried to the owner like a frame QA could not show */
  notShown: NotShownFrame[];
}

const MAX_LISTED = 30;
/** The shortest name that counts when it is only part of the other */
const MIN_PART = 4;
/** What the app writes for a frame it could not open twice; only the app's own notes are ever removed */
const UNREACHABLE_NOTE = 'the app could not open it by the recorded steps: ';
/** And for a frame it could not look at at all: the check did not run, or the mockup could not be read */
const NOT_LOOKED_NOTE = 'the app could not look at it itself: ';
const APP_NOTES = [UNREACHABLE_NOTE, NOT_LOOKED_NOTE];

/** An error as text of a bounded length: what comes back from a page or another process is not always a string. Never throws. */
function errorText(error: unknown, fallback = 'the page could not be read'): string {
  try {
    const text = typeof error === 'string' ? error : error instanceof Error ? error.message : typeof error === 'number' ? String(error) : '';
    return text.replace(/\s+/g, ' ').trim().slice(0, 300) || fallback;
  } catch {
    return fallback;
  }
}

/** The most elements of one page, names of one element and characters of one name that are kept */
const MAX_ELEMENTS = 2000;
const MAX_NAMES = 8;
const MAX_NAME = 200;

/**
 * What a built page reported as its elements, as kinds and names. The page is the agents' work
 * and the list crosses into the app's processes: only strings are kept, cut to a size; a list
 * that is not one is no page (null). Pure.
 */
export function builtElementsOf(raw: unknown): BuiltElement[] | null {
  if (!Array.isArray(raw)) return null;
  const out: BuiltElement[] = [];
  for (const item of raw.slice(0, MAX_ELEMENTS * 2)) {
    if (out.length >= MAX_ELEMENTS) break;
    const entry = item as { kind?: unknown; names?: unknown } | null;
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.names)) continue;
    const names = entry.names
      .filter((name): name is string => typeof name === 'string' && name.trim() !== '')
      .slice(0, MAX_NAMES)
      .map((name) => name.slice(0, MAX_NAME));
    if (names.length) out.push({ kind: typeof entry.kind === 'string' ? entry.kind.slice(0, 40) : 'field', names });
  }
  return out;
}

const label = (f: EvidenceFrame) => `${f.file} at ${f.width} px`;
const key = (f: EvidenceFrame) => `${f.file}@${f.width}`;

/** Lower case, one space, one apostrophe and one quote mark. Pure. */
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[ʼ’‘′`]/g, "'")
    .replace(/[«»“”„]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A label as it is compared: normalised, without the dots or colon at its end. Pure. */
export function normalizeLabel(text: string): string {
  return normalizeText(text).replace(/(\s*(…|\.|:))+$/, '').trim();
}

/** Whether one of the built page's names is the mockup's label (see the rules in the file's comment). Pure. */
export function isFound(mockup: string, builtNames: string[]): boolean {
  const want = normalizeLabel(mockup);
  if (!want) return true;
  const colon = want.indexOf(':');
  const prefix = colon > 0 ? want.slice(0, colon).trim() : '';
  return builtNames.some((raw) => {
    const name = normalizeLabel(raw);
    if (!name) return false;
    if (name === want) return true;
    // The page's name holds the label ("Додати задачу до колонки"), or is most of it ("Історія" for
    // "Історія плану"); a small part of a label is another element ("Плани" in the navigation)
    if (name.length >= want.length ? want.length >= MIN_PART && name.includes(want) : name.length >= MIN_PART && name.length * 2 >= want.length && want.includes(name)) return true;
    // "Меню користувача: Олена Коваленко-Шевчук": the part after the colon is the mockup's sample data
    return !!prefix && name.startsWith(`${prefix}:`);
  });
}

/** An inventory item's label, or null for a collapsed row of sample data. Pure. */
function itemLabel(item: string): string | null {
  const match = /^.+? «(.*)»(?: → \S+)?( \(and \d+ more like it\))?$/.exec(item);
  if (!match || match[2]) return null;
  return match[1];
}

/**
 * The mockup elements not on the built pages. Each item is looked for once in the task: on every
 * opened page whose mockup lists it (any width, any screen), and listed under the first. Pure.
 */
export function unfoundElements(pages: Array<EvidenceFrame & { items: string[]; elements: BuiltElement[] }>): { looked: number; unfound: UnfoundElement[] } {
  const where = new Map<string, Array<(typeof pages)[number]>>();
  for (const page of pages) {
    for (const item of page.items) {
      const text = itemLabel(item);
      if (text === null || !normalizeLabel(text)) continue;
      where.set(item, [...(where.get(item) ?? []), page]);
    }
  }
  const unfound: UnfoundElement[] = [];
  for (const [item, on] of where) {
    const text = itemLabel(item) as string;
    if (on.some((page) => isFound(text, page.elements.flatMap((e) => e.names)))) continue;
    unfound.push({ file: on[0].file, width: on[0].width, item, label: text });
  }
  return { looked: where.size, unfound };
}

/** The elements a difference of their screen's entries names, and the rest. Pure. */
export function accountFor(unfound: UnfoundElement[], differences: Map<string, string[]>): { accounted: UnfoundElement[]; unaccounted: UnfoundElement[] } {
  const accounted: UnfoundElement[] = [];
  const unaccounted: UnfoundElement[] = [];
  for (const u of unfound) {
    const want = normalizeLabel(u.label);
    const named = (differences.get(u.file) ?? []).some((text) => normalizeText(text).includes(want));
    (named ? accounted : unaccounted).push(u);
  }
  return { accounted, unaccounted };
}

/** The refusal for the reviewer, or undefined when the approval may stand. Pure. */
export function elementRefusal(outcome: Pick<ElementCheckOutcome, 'unaccounted' | 'unreachable'>): string | undefined {
  const lines = elementProblems(outcome);
  if (!lines.length) return undefined;
  return [
    'Error: approval not recorded. After your approval the app opened each frame you showed in the running app, by your recipes in screens.json, and looked for every element of its mockup on the built page:',
    ...lines.map((line) => `- ${line}`),
    'Then record the verdict again.',
  ].join('\n');
}

/** The problems, capped, each followed by what to do. Pure. */
export function elementProblems(outcome: Pick<ElementCheckOutcome, 'unaccounted' | 'unreachable'>): string[] {
  const all = [
    ...outcome.unaccounted.map((u) => `${label(u)}: ${u.item.replace(/ → \S+$/, '')} not found`),
    ...outcome.unreachable.map((u) => `${label(u)} could not be opened by its recipe in screens.json: ${errorText(u.error)}`),
  ];
  if (!all.length) return [];
  const lines = all.slice(0, MAX_LISTED);
  if (all.length > MAX_LISTED) lines.push(`…and ${all.length - MAX_LISTED} more`);
  if (outcome.unaccounted.length) {
    lines.push(
      `For each element not found: if the page lacks it, it is a blocking difference: reject the task with it as an issue. If it is not needed, add a minor difference to that frame's entry in ${COMPARE_FILE} that names the element by the label above and says why (the mockup's sample data, or the page has it under another name: which).`,
    );
  }
  if (outcome.unreachable.length) {
    lines.push(
      'For each frame not opened: fix its recipe in screens.json (its path from the app\'s root after signing in, and steps that reach the state the frame shows). If the app still cannot open it, the frame goes to the owner as not shown and the task waits for the owner before it merges.',
    );
  }
  return lines;
}

/** The pages of the frames, opened by the catalog's recipes: one capture for all, the frames with no recipe say so. Never throws past `capture`. */
export async function capturePages(
  baseUrl: string,
  catalog: ScreenCatalog,
  frames: EvidenceFrame[],
  capture: (baseUrl: string, catalog: ScreenCatalog) => Promise<Array<{ id: string; width: number; elements?: BuiltElement[]; error?: string }>>,
): Promise<FramePage[]> {
  const recipes = new Map<string, ScreenRecipe>();
  for (const f of frames) {
    const id = screenId(f.file);
    const recipe = id ? catalog.screens.find((s) => s.id === id && s.width === f.width) : undefined;
    if (recipe) recipes.set(`${recipe.id}@${recipe.width}`, recipe);
  }
  const shots = recipes.size ? await capture(baseUrl, { ...(catalog.signIn ? { signIn: catalog.signIn } : {}), screens: [...recipes.values()] }) : [];
  return frames.map((f) => {
    const id = screenId(f.file) ?? f.file;
    const shot = shots.find((s) => s.id === id && s.width === f.width);
    if (!recipes.has(`${id}@${f.width}`)) return { ...f, error: `${TASK_SCREENS_FILE} has no recipe for ${id} at ${f.width} px` };
    if (!shot) return { ...f, error: 'the app did not open it' };
    return shot.elements ? { ...f, elements: shot.elements } : { ...f, error: errorText(shot.error) };
  });
}

/** design_compare.json as written, or null. Never throws. */
function readCompare(specDir: string): { raw: Record<string, unknown>; screens: Array<Record<string, unknown>> } | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(specDir, COMPARE_FILE), 'utf-8')) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.screens)) return null;
    return { raw, screens: raw.screens.map((s) => (s && typeof s === 'object' ? (s as Record<string, unknown>) : {})) };
  } catch {
    return null;
  }
}

const textOf = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/** The frames the reviewer showed (a screenshot in design_compare.json). Never throws. */
export function shownFrames(specDir: string, frames: EvidenceFrame[]): EvidenceFrame[] {
  const compare = readCompare(specDir);
  if (!compare) return [];
  return frames.filter((f) => compare.screens.some((e) => e.file === f.file && e.width === f.width && textOf(e.built)));
}

/** The texts of the differences of each screen file in design_compare.json. Never throws. */
function differencesByFile(specDir: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const entry of readCompare(specDir)?.screens ?? []) {
    if (typeof entry.file !== 'string') continue;
    const texts = (Array.isArray(entry.differences) ? entry.differences : []).map((d) => textOf((d as Record<string, unknown> | null)?.text)).filter(Boolean);
    out.set(entry.file, [...(out.get(entry.file) ?? []), ...texts]);
  }
  return out;
}

/** A screen's elements to look for, or why the app cannot tell what they are (the frame then goes to the owner) */
export type FrameInventory = { items: string[] } | { hold: string };

/** The project's design library, where the owner's approved screens are kept, outside the task's folder */
export interface InventoryLibrary {
  /** <project>/.vibe-teamlead/design/library */
  dir: string;
  /** Its frames (design-library.ts readLibrary), each with the task it came from */
  frames: Array<{ file: string; taskId?: string }>;
  /** This task: a screen of the library that came from it is its own design, as approved */
  taskId: string;
}

/** A file's elements, or null when it is not a real file inside `root` or cannot be read whole. Never throws. */
function inventoryOfFile(root: string, full: string | null): string[] | null {
  if (!full || !realFileInside(root, full)) return null;
  try {
    return screenInventoryStrict(readFileSync(full, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * The mockup's elements of each screen file of the frames (not deduplicated across screens:
 * unfoundElements does that). Read once, before any review. The mockups in the task's folder are
 * the agents' to write, from the design's approval on, so each is compared with the project's
 * library: a screen of the library the plan rebuilds (base/…), and the task's own screen when the
 * library's came from this task. A copy that lists other elements than the library's screen, or
 * cannot be read, is not looked for at all: its frame goes to the owner. Never throws.
 */
export function frameInventories(specDir: string, frames: EvidenceFrame[], library?: InventoryLibrary): Map<string, FrameInventory> {
  const out = new Map<string, FrameInventory>();
  for (const { file } of frames) {
    if (out.has(file)) continue;
    const copy = inventoryOfFile(designDir(specDir), designFile(specDir, file));
    const inLibrary = file.startsWith('base/') ? file.slice('base/'.length) : file;
    const approved = library?.frames.find((f) => f.file === inLibrary && (file.startsWith('base/') || f.taskId === library.taskId));
    const theirs = approved && library ? inventoryOfFile(library.dir, path.resolve(library.dir, inLibrary)) : null;
    if (theirs && (!copy || copy.join('\n') !== theirs.join('\n'))) {
      out.set(file, { hold: "its mockup in the task's folder differs from the project's design library" });
    } else if (!copy) {
      out.set(file, { hold: 'its mockup could not be read' });
    } else {
      out.set(file, { items: copy });
    }
  }
  return out;
}

/**
 * The app's note on the frames it could not open twice, in their entries of design_compare.json,
 * so the owner is told which and why (task-design.ts unseenScreensOf); its note is removed from a
 * frame it opened again. Never throws.
 */
function noteUnreachable(specDir: string, carried: NotShownFrame[], reached: EvidenceFrame[]): void {
  const compare = readCompare(specDir);
  if (!compare) return;
  let changed = false;
  for (const entry of compare.screens) {
    const frame = { file: entry.file, width: entry.width } as EvidenceFrame;
    const note = carried.find((c) => key(c) === key(frame));
    if (note && entry.notShown !== note.reason) {
      entry.notShown = note.reason;
      changed = true;
    } else if (!note && reached.some((r) => key(r) === key(frame)) && APP_NOTES.some((own) => textOf(entry.notShown).startsWith(own))) {
      delete entry.notShown;
      changed = true;
    }
  }
  if (!changed) return;
  try {
    writeFileReplacingSync(path.join(specDir, COMPARE_FILE), JSON.stringify({ ...compare.raw, screens: compare.screens }, null, 2));
  } catch {
    // the approval record still holds the task for the owner
  }
}

export interface ElementCheckDeps {
  specDir: string;
  /** The task's app, the one QA started if it still runs (dev-servers/task-app.ts) */
  startApp: () => Promise<{ ok: true; url: string } | { ok: false; reason: string }>;
  /** The frames' pages in the running app, opened by screens.json in the main process; an error when that could not run */
  capture: (url: string, frames: EvidenceFrame[]) => Promise<FramePage[] | { error: string }>;
  /** HEAD of the task's worktree: pages are opened again only when the code or the recipes changed */
  commit: () => Promise<string | undefined>;
  /** A line in the task's QA log */
  log: (line: string) => void;
  /** The mockups' elements, read before any review of this QA run (frameInventories) */
  inventories: Map<string, FrameInventory>;
}

/**
 * The element check of one QA run. It keeps, outside every file an agent writes, which frames the
 * app could not open already (a frame not opened twice goes to the owner) and the last pages it
 * opened, for the commit and the recipes they were opened with. `check` never throws; undefined
 * only when there was nothing to look at. A check that could not run is not one that passed: its
 * frames go to the owner as not shown, so the task waits for the owner before it merges.
 */
export function createElementCheck(deps: ElementCheckDeps) {
  const triedRecipe = new Set<string>();
  let last: { key: string; pages: FramePage[] } | undefined;

  const reason = (error: unknown) => errorText(error, 'unknown error');

  /** Nothing was looked at: every frame is the owner's to look at before the merge */
  function held(frames: EvidenceFrame[], why: string): ElementCheckOutcome {
    deps.log(`Element check did not run: ${why}. The frames it would have opened go to the owner as not shown`);
    const notShown = frames.map((f) => ({ file: f.file, width: f.width, reason: `${NOT_LOOKED_NOTE}${why}`.slice(0, 500) }));
    noteUnreachable(deps.specDir, notShown, []);
    return { unaccounted: [], unreachable: [], notShown };
  }

  async function pagesOf(frames: EvidenceFrame[]): Promise<FramePage[] | { notRun: string }> {
    let recipes = '';
    try {
      recipes = readFileSync(path.join(deps.specDir, TASK_SCREENS_FILE), 'utf-8');
    } catch {
      // no recipes: every frame says so
    }
    const commit = await deps.commit().catch(() => undefined);
    const runKey = commit ? [commit, recipes, ...frames.map(key)].join('\n') : undefined;
    if (runKey && last?.key === runKey) return last.pages;
    const notRun = (why: string) => ({ notRun: why });
    let url: string;
    try {
      const app = await deps.startApp();
      if (!app.ok) return notRun(`the app could not start (${errorText(app.reason.split('\n')[0])})`);
      url = app.url;
    } catch (error) {
      return notRun(`the app could not start (${reason(error)})`);
    }
    let pages: FramePage[] | { error: string };
    try {
      pages = await deps.capture(url, frames);
    } catch (error) {
      pages = { error: reason(error) };
    }
    if (!Array.isArray(pages)) return notRun(errorText(pages.error, 'no pages'));
    if (runKey) last = { key: runKey, pages };
    return pages;
  }

  async function check(frames: EvidenceFrame[]): Promise<ElementCheckOutcome | undefined> {
    let shown: EvidenceFrame[] = [];
    try {
      // Frames with a reason instead of a screenshot are the owner's to look at already
      shown = shownFrames(deps.specDir, frames);
      if (!shown.length) return undefined;
      const opened = await pagesOf(shown);
      if (!Array.isArray(opened)) return held(shown, opened.notRun);

      // A frame whose mockup could not be read before the review has nothing to be compared with
      const itemsOf = (f: EvidenceFrame) => {
        const inventory = deps.inventories.get(f.file);
        return inventory && 'items' in inventory ? inventory.items : undefined;
      };
      const readable = (f: EvidenceFrame) => itemsOf(f) !== undefined;
      const heldFor = (f: EvidenceFrame) => {
        const inventory = deps.inventories.get(f.file);
        return inventory && 'hold' in inventory ? inventory.hold : 'its mockup could not be read';
      };
      const pages = opened.filter(readable);
      const reached = pages.filter((p): p is FramePage & { elements: BuiltElement[] } => Array.isArray(p.elements));
      const { looked, unfound } = unfoundElements(reached.map((p) => ({ file: p.file, width: p.width, items: itemsOf(p) ?? [], elements: p.elements })));
      const { accounted, unaccounted } = accountFor(unfound, differencesByFile(deps.specDir));

      const unreachable: ElementCheckOutcome['unreachable'] = [];
      const notShown: NotShownFrame[] = opened
        .filter((p) => !readable(p))
        .map((p) => ({ file: p.file, width: p.width, reason: `${NOT_LOOKED_NOTE}${heldFor(p)}` }));
      for (const p of pages) {
        if (p.elements) continue;
        const error = errorText(p.error);
        if (triedRecipe.has(key(p))) notShown.push({ file: p.file, width: p.width, reason: `${UNREACHABLE_NOTE}${error}`.slice(0, 500) });
        else {
          triedRecipe.add(key(p));
          unreachable.push({ file: p.file, width: p.width, error });
        }
      }
      noteUnreachable(deps.specDir, notShown, reached);

      deps.log(
        `Element check: the app opened ${reached.length} of ${shown.length} frame(s) by screens.json and looked for ${looked} element(s) of the mockups; ${unfound.length} not found, ${accounted.length} of them accounted for by the reviewer` +
          (pages.length > reached.length ? `; ${pages.length - reached.length} frame(s) could not be opened by the recorded steps (${notShown.length} go to the owner as not shown)` : ''),
      );
      return { unaccounted, unreachable, notShown };
    } catch (error) {
      return shown.length ? held(shown, reason(error)) : undefined;
    }
  }

  return { check };
}
