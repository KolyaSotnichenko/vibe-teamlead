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
 * needs (the screens its spec names, and the app shell), base/index.md the rest, which stay there
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

/**
 * The library frames a task's designer starts from: the app shell, then the screens the spec's
 * screens, routes and words name (by file name or title), the most specific first, each with at
 * most two of its states, at most BASE_FRAMES_MAX frames (a library that small: all of it). A
 * file comes with all its widths. Pure.
 */
export function selectBaseFrames(frames: LibraryFrame[], specMd: string, max = BASE_FRAMES_MAX): LibraryFrame[] {
  // A small library is the whole start
  if (frames.length <= max) return frames;
  const specCounts = new Map<string, number>();
  for (const w of words(specMd)) specCounts.set(w, (specCounts.get(w) ?? 0) + 1);
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
      .sort((a, b) => a.parts - b.parts)[0].file;
  const families = new Map<string, Ranked[]>();
  for (const r of ranked.filter((x) => !x.shell && x.score > 0)) {
    const key = familyOf(r);
    families.set(key, [...(families.get(key) ?? []), r]);
  }
  const best = (list: Ranked[]) => Math.max(...list.map((r) => r.score));
  const matches = [...families.values()]
    .sort((a, b) => best(b) - best(a) || a[0].file.localeCompare(b[0].file))
    .flatMap((list) => list.sort((a, b) => a.parts - b.parts || b.score - a.score || a.file.localeCompare(b.file)).slice(0, FAMILY_FILES_MAX));
  const shells = ranked.filter((r) => r.shell).sort((a, b) => a.parts - b.parts || a.file.localeCompare(b.file)).slice(0, SHELL_FILES_MAX);
  const out: LibraryFrame[] = [];
  for (const r of [...shells, ...matches]) {
    if (out.length + r.list.length > max) continue;
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
