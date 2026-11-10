/**
 * The project's design library: the latest version of every wireframe and screen the tasks drew,
 * in the main project (not a worktree) at .vibe-teamlead/design/library/:
 *
 *   library/canvas.json            frames, each with the task it came from and when
 *   library/wireframes/*.html, library/screens/*.html
 *
 * A task's design goes in when its design step is done (approved, or gone on by itself); a frame
 * with the same file name replaces the older version. The next task's designer starts from a
 * copy of it (design/base/ in its spec folder). Context → Design system → Screens shows it.
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

/** Copy the library into a task's design/base/ for its designer to start from; returns how many frames. */
export function copyLibraryToBase(projectRoot: string, specDir: string): number {
  try {
    const { frames } = readLibrary(projectRoot);
    if (!frames.length) return 0;
    const base = path.join(specDir, 'design', 'base');
    for (const frame of frames) {
      mkdirSync(path.dirname(path.join(base, frame.file)), { recursive: true });
      copyFileSync(path.join(libraryDir(projectRoot), frame.file), path.join(base, frame.file));
    }
    writeFileSync(path.join(base, 'canvas.json'), JSON.stringify({ frames }, null, 2));
    return frames.length;
  } catch {
    return 0;
  }
}
