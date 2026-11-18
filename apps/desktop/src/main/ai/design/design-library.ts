/**
 * The project's design library: the latest version of every wireframe and screen the tasks drew,
 * in the main project (not a worktree) at .vibe-teamlead/design/library/:
 *
 *   library/canvas.json            frames, each with the task it came from and when
 *   library/wireframes/*.html, library/screens/*.html
 *
 * A task's design goes in when its design step is done (approved, or gone on by itself); a frame
 * with the same file name replaces the older version. The next task's designer starts from a
 * copy of it (design/base/ in its spec folder): base/canvas.json lists only the frames the task
 * needs (the screens its spec and requirements name exactly, the pages it will touch, the app
 * shell; words only when nothing is named), base/index.md the rest, which stay there
 * to open on demand. Context → Design system → Screens shows it.
 */

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { type DesignFrame, designFile, frameFileOk, readDesignCanvas, realFileInside } from './design-step';

export interface LibraryFrame extends DesignFrame {
  taskId: string;
  updatedAt: string;
}

const ROW_GAP = 80;
const BAND_GAP = 1200;

export const libraryDir = (projectRoot: string) => path.join(projectRoot, '.vibe-teamlead', 'design', 'library');

export function readLibrary(projectRoot: string): { frames: LibraryFrame[] } {
  try {
    const parsed = JSON.parse(readFileSync(path.join(libraryDir(projectRoot), 'canvas.json'), 'utf-8')) as { frames?: LibraryFrame[] };
    const root = libraryDir(projectRoot);
    const frames = (Array.isArray(parsed?.frames) ? parsed.frames : []).filter(
      (f) => typeof f?.file === 'string' && frameFileOk(f.file) && realFileInside(root, path.join(root, f.file)),
    );
    return { frames };
  } catch {
    return { frames: [] };
  }
}

/** Wireframes in one band, screens in the band below, each in file order */
function layout(frames: LibraryFrame[]): LibraryFrame[] {
  const sorted = [...frames].sort((a, b) => a.file.localeCompare(b.file));
  const out: LibraryFrame[] = [];
  for (const [kind, y] of [['wireframe', 0], ['screen', BAND_GAP]] as const) {
    let x = 0;
    for (const f of sorted.filter((frame) => frame.kind === kind)) {
      out.push({ ...f, x, y });
      x += f.width + ROW_GAP;
    }
  }
  return out;
}

/** Put a task's frames into the library; returns how many. Never throws. */
export function publishToLibrary(projectRoot: string, specDir: string, opts: { taskId: string; now?: Date }): number {
  try {
    const frames = readDesignCanvas(specDir).frames;
    if (!frames.length) return 0;
    const dir = libraryDir(projectRoot);
    const library = readLibrary(projectRoot).frames;
    const at = (opts.now ?? new Date()).toISOString();
    for (const frame of frames) {
      // readDesignCanvas lists only regular files inside design/ with a wireframes|screens/<name>.html path
      const source = designFile(specDir, frame.file);
      if (!source || !frameFileOk(frame.file)) continue;
      mkdirSync(path.dirname(path.join(dir, frame.file)), { recursive: true });
      copyFileSync(source, path.join(dir, frame.file));
      const entry: LibraryFrame = { ...frame, taskId: opts.taskId, updatedAt: at };
      // A responsive page is on the canvas once per width
      const index = library.findIndex((f) => f.file === frame.file && f.width === frame.width);
      if (index === -1) library.push(entry);
      else library[index] = entry;
    }
    writeFileSync(path.join(dir, 'canvas.json'), JSON.stringify({ frames: layout(library) }, null, 2));
    return frames.length;
  } catch {
    return 0;
  }
}

/** At most this many frames (a file at one width) in the designer's base/canvas.json */
export const BASE_FRAMES_MAX = 20;
/** App-shell frames always come along, at most this many files */
const SHELL_FILES_MAX = 3;
const SHELL = /^(app-?shell|shell|app-layout|layout|nav|navigation|side-?nav|sidebar|top-?bar|header|home)(-|$)/;
/** Words in frame names that say nothing about which screen it is */
const GENERIC = new Set(['the', 'and', 'for', 'with', 'page', 'screen', 'view', 'state', 'empty', 'error', 'loading', 'success', 'desktop', 'phone', 'mobile', 'tablet', 'long', 'list', 'new', 'default', 'modal', 'dialog', 'more', 'en', 'uk']);

const words = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/**
 * How strongly the spec names a frame: every meaningful word of the name must be in the spec (a
 * plural counts); a name of more such words is more specific, then the more often its rarest word
 * is used the better. 0: not named.
 */
function nameScore(name: string, specCounts: Map<string, number>): number {
  const meaningful = words(name).filter((w) => w.length >= 3 && !GENERIC.has(w));
  if (!meaningful.length) return 0;
  const count = (w: string) => (specCounts.get(w) ?? 0) + (specCounts.get(`${w}s`) ?? 0) + (w.endsWith('s') ? specCounts.get(w.slice(0, -1)) ?? 0 : 0);
  const rarest = Math.min(...meaningful.map(count));
  return rarest ? meaningful.length * 1000 + Math.min(rarest, 999) : 0;
}

/** A screen and its states (`plan-board`, `plan-board-empty` …): at most this many files of one */
const FAMILY_FILES_MAX = 3;

/** Sections whose files and names are examples to copy, not what the task changes */
const REFERENCE_SECTION = /files to reference|patterns? to follow|reference files/i;
/** Sections that list the files the task's code will touch */
const TOUCH_SECTION = /files to (modify|create|change|add)|new files|changed files|files changed/i;
/** Files that are a page or a component (a screen can come from them) */
const UI_FILE = /\.(tsx|jsx|vue|svelte|astro|html)$/i;
/** Path parts that say nothing about which screen it is */
const GENERIC_PATH = new Set(['src', 'app', 'apps', 'web', 'client', 'frontend', 'pages', 'page', 'components', 'component', 'routes', 'route', 'views', 'view', 'screens', 'screen', 'features', 'feature', 'lib', 'ui', 'shared', 'common', 'index', 'main', 'test', 'tests', 'spec', 'packages']);
const COMPONENT_SUFFIX = /(Page|View|Screen|Route|Component|Container)$/;

/** The spec's sections by their `##` headings (text before the first: the title, kept) */
function sections(text: string): Array<{ heading: string; body: string }> {
  const out: Array<{ heading: string; body: string }> = [];
  let current = { heading: '', body: '' };
  for (const line of text.split('\n')) {
    const match = /^##\s+(.*)$/.exec(line);
    if (match) {
      out.push(current);
      current = { heading: match[1], body: '' };
    } else current.body += `${line}\n`;
  }
  out.push(current);
  return out;
}

/** `PlanBoardPage` → `plan-board`, `audit_log` → `audit-log` */
const kebab = (name: string) => name.replace(COMPONENT_SUFFIX, '').replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[_\s]+/g, '-').toLowerCase();

const singular = (w: string) => (w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
/**
 * A name with each word as written or singular (`/plans/:id/board` → plan-board). Never the
 * plural: `PlanPage` is one plan, not the `plans` list.
 */
function variants(name: string): string[] {
  let out = [''];
  for (const w of name.split('-').filter(Boolean)) out = out.flatMap((head) => [...new Set([w, singular(w)])].map((v) => (head ? `${head}-${v}` : v)));
  return out;
}

/** Screen names from a UI route: its parts, and each two neighbours together (`/plans/:id/board` → plans, board, plans-board) */
function routeNames(route: string): string[] {
  const parts = route.split(/[/?#]/).filter((p) => p && !/^[:[{*]/.test(p) && !/^\d+$/.test(p)).map((p) => p.toLowerCase());
  if (!parts.length || parts[0] === 'api') return [];
  const out = parts.filter((p) => !GENERIC_PATH.has(p));
  for (let i = 0; i + 1 < parts.length; i++) out.push(`${parts[i]}-${parts[i + 1]}`);
  return out;
}

/** Screen names from a file the task touches: the page or component (with its folder), the folder only for an index file */
function fileNames(file: string): string[] {
  const parts = file.split('/').filter(Boolean);
  const base = kebab((parts.pop() ?? '').replace(/\.[^.]+$/, '').replace(/\.test$/, ''));
  const dir = parts.length ? parts[parts.length - 1].toLowerCase() : '';
  const useful = (name: string) => !!name && !GENERIC_PATH.has(name);
  if (!useful(base)) return useful(dir) ? [dir] : [];
  return useful(dir) ? [base, `${dir}-${base}`] : [base];
}

/**
 * What the spec names exactly, outside its reference sections: the screens of its UI routes and
 * its page and component names (`named`), and the pages of the UI files it will touch (`touched`).
 * Its prose (`prose`) is what is left for word matching: no code, no paths, no reference sections.
 */
export function specSignals(specMd: string): { named: string[]; touched: string[]; prose: string } {
  const named: string[] = [];
  const touched: string[] = [];
  const prose: string[] = [];
  for (const { heading, body } of sections(specMd)) {
    if (REFERENCE_SECTION.test(heading)) continue;
    const text = body.replace(/```[\s\S]*?```/g, ' ');
    for (const match of text.matchAll(/(?:^|[\s`'"(<|])(\/[A-Za-z][\w\-/:.[\]{}*]*)/g)) {
      // a route, not a file path (a file has an extension)
      if (!/\.[a-z]{1,5}$/i.test(match[1])) named.push(...routeNames(match[1]));
    }
    for (const match of text.matchAll(/\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g)) {
      const name = kebab(match[0]);
      if (name && !GENERIC_PATH.has(name)) named.push(name);
    }
    if (TOUCH_SECTION.test(heading)) {
      for (const match of text.matchAll(/[\w./-]+\/[\w.-]+\.[A-Za-z]{2,6}/g)) {
        if (UI_FILE.test(match[0])) touched.push(...fileNames(match[0]));
      }
    }
    prose.push(heading, text.replace(/`[^`]*`/g, ' ').replace(/\S*\/\S*/g, ' '));
  }
  return { named: [...new Set(named)], touched: [...new Set(touched)], prose: prose.join('\n') };
}

/**
 * The library frames a task's designer starts from, at most `max` frames (a library that small:
 * all of it), each file with all its widths and each screen with at most two of its states:
 *
 * 1. the screens the spec names exactly: its UI routes (`/plans/:id/board`) and its page and
 *    component names (`PlanBoard`, `AuditLogPage`), by file name;
 * 2. the pages of the UI files it will touch (Files to Modify / Create);
 * 3. the app shell and navigation, at most three files;
 * 4. only when 1 and 2 found nothing: the screens whose names the spec's prose uses, every
 *    meaningful word required, the more specific first.
 *
 * API routes and the files to reference are no signal. Word matching can pick a neighbouring
 * screen (directory sync for a roles page whose API mentions it), so it never comes on top of an
 * exact match: the rest of the library is named in base/index.md. Pure.
 */
export function selectBaseFrames(frames: LibraryFrame[], specMd: string, max = BASE_FRAMES_MAX): LibraryFrame[] {
  // A small library is the whole start
  if (frames.length <= max) return frames;
  const signals = specSignals(specMd);
  const specCounts = new Map<string, number>();
  for (const w of words(signals.prose)) specCounts.set(w, (specCounts.get(w) ?? 0) + 1);
  const byFile = new Map<string, LibraryFrame[]>();
  for (const f of frames) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f]);
  const ranked = [...byFile.entries()].map(([file, list]) => {
    const name = path.basename(file, '.html');
    const title = list[0].title.split('·')[0];
    return { file, list, name, parts: name.split('-').length, shell: SHELL.test(name), score: Math.max(nameScore(name, specCounts), nameScore(title, specCounts)) };
  });
  type Ranked = (typeof ranked)[number];
  // A file's family: the shortest name in the library its name starts with (in the same folder)
  const familyOf = (r: Ranked) =>
    ranked
      .filter((o) => path.dirname(o.file) === path.dirname(r.file) && (o.name === r.name || r.name.startsWith(`${o.name}-`)))
      .sort((a, b) => a.parts - b.parts)[0];
  const families = new Map<string, Ranked[]>();
  for (const r of ranked) {
    const key = familyOf(r).name;
    families.set(key, [...(families.get(key) ?? []), r]);
  }
  /** A family's frames: the screen in every folder, then at most two states, the shorter names first */
  const familyFiles = (root: string): Ranked[] => {
    const list = families.get(root) ?? [];
    const out: Ranked[] = [];
    for (const dir of [...new Set(list.map((r) => path.dirname(r.file)))].sort()) {
      out.push(...list.filter((r) => path.dirname(r.file) === dir).sort((a, b) => a.parts - b.parts || a.file.localeCompare(b.file)).slice(0, FAMILY_FILES_MAX));
    }
    return out;
  };
  const roots = [...families.keys()];
  /** The families a name stands for: the screen of that name, else the one screen whose name starts with it */
  const familiesNamed = (name: string): string[] => {
    const exact = variants(name).filter((v) => families.has(v));
    if (exact.length) return exact;
    const prefixed = roots.filter((root) => root.startsWith(`${name}-`));
    return prefixed.length === 1 ? prefixed : [];
  };
  const exactTier = (names: string[]) => [...new Set(names.flatMap(familiesNamed))];
  const named = exactTier(signals.named);
  const touched = exactTier(signals.touched).filter((root) => !named.includes(root));
  const shells = ranked.filter((r) => r.shell).sort((a, b) => a.parts - b.parts || a.file.localeCompare(b.file)).slice(0, SHELL_FILES_MAX);
  const best = (list: Ranked[]) => Math.max(...list.map((r) => r.score));
  const worded =
    named.length || touched.length
      ? []
      : [...families.entries()]
          .filter(([root, list]) => !SHELL.test(root) && best(list) > 0)
          .sort((a, b) => best(b[1]) - best(a[1]) || a[0].localeCompare(b[0]))
          .flatMap(([root]) => familyFiles(root).filter((r) => r.score > 0));
  const out: LibraryFrame[] = [];
  const taken = new Set<string>();
  for (const r of [...named.flatMap(familyFiles), ...touched.flatMap(familyFiles), ...shells, ...worded]) {
    if (taken.has(r.file) || out.length + r.list.length > max) continue;
    taken.add(r.file);
    out.push(...r.list);
  }
  return out;
}

const oneLine = (text: string) => text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);

/**
 * Copy the library into a task's design/base/ for its designer to start from: every file, with
 * the frames the task needs in canvas.json and the rest named in index.md. Never throws.
 */
export function copyLibraryToBase(projectRoot: string, specDir: string, specMd = ''): { copied: number; listed: number } {
  try {
    const { frames } = readLibrary(projectRoot);
    if (!frames.length) return { copied: 0, listed: 0 };
    const base = path.join(specDir, 'design', 'base');
    const files = [...new Set(frames.map((f) => f.file))];
    for (const file of files) {
      mkdirSync(path.dirname(path.join(base, file)), { recursive: true });
      copyFileSync(path.join(libraryDir(projectRoot), file), path.join(base, file));
    }
    const chosen = selectBaseFrames(frames, specMd);
    const chosenFiles = new Set(chosen.map((f) => f.file));
    writeFileSync(path.join(base, 'canvas.json'), JSON.stringify({ frames: chosen }, null, 2));
    const rest = files.filter((file) => !chosenFiles.has(file)).sort();
    const index = [
      "# The rest of the project's design library",
      '',
      "Frames earlier tasks drew that this task's spec doesn't name. Each file is here under design/base/; open one only when the task changes that screen or you need its pattern.",
      '',
      ...rest.map((file) => `- ${file} — ${oneLine(frames.find((f) => f.file === file)?.title ?? '')}`),
      '',
    ].join('\n');
    writeFileSync(path.join(base, 'index.md'), index);
    return { copied: files.length, listed: chosen.length };
  } catch {
    return { copied: 0, listed: 0 };
  }
}
