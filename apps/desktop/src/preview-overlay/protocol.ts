/**
 * Messages between the Preview's in-page overlay (in the page's own world), the view's
 * preload and the main process. Everything the page sends is data from code agents wrote:
 * it is checked and capped here before it goes anywhere. Pure: no DOM, no Electron.
 */

export const FROM_OVERLAY = 'vt-preview-overlay';
export const FROM_HOST = 'vt-preview-host';

export interface PickRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SourceFrame {
  file: string;
  line?: number;
  column?: number;
  name?: string;
}

/** What the owner pointed at: an element, or a dragged region and the elements it mostly covers */
export interface Pick {
  kind: 'element' | 'region';
  /** In the page's CSS pixels, relative to the viewport */
  rect: PickRect;
  selector: string;
  text: string;
  html: string;
  component?: string;
  frames: SourceFrame[];
  elements?: Array<{ selector: string; text: string }>;
}

/** Host → overlay */
export type HostCommand =
  | { type: 'mode'; on: boolean }
  | { type: 'pins'; pins: Array<{ n: number; selector: string }> }
  | { type: 'focus'; n: number };

/** Overlay → host */
export type OverlayEvent = { type: 'picked'; pick: Pick } | { type: 'detached'; ns: number[] } | { type: 'escape' };

const TEXT_MAX = 200;
const HTML_MAX = 1500;
const SELECTOR_MAX = 500;
const FRAMES_MAX = 3;
const ELEMENTS_MAX = 5;

const str = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '');
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

function cleanRect(value: unknown): PickRect | null {
  const r = (value ?? {}) as Record<string, unknown>;
  const [x, y, width, height] = [num(r.x), num(r.y), num(r.width), num(r.height)];
  if (x === undefined || y === undefined || width === undefined || height === undefined || width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function cleanFrame(value: unknown): SourceFrame | null {
  const f = (value ?? {}) as Record<string, unknown>;
  const file = str(f.file, 500);
  if (!file) return null;
  const frame: SourceFrame = { file };
  if (num(f.line) !== undefined) frame.line = num(f.line);
  if (num(f.column) !== undefined) frame.column = num(f.column);
  if (str(f.name, 120)) frame.name = str(f.name, 120);
  return frame;
}

/** A pick from the page, checked and capped, or null when it is not one. */
export function cleanPick(value: unknown): Pick | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as Record<string, unknown>;
  if (p.kind !== 'element' && p.kind !== 'region') return null;
  const rect = cleanRect(p.rect);
  if (!rect) return null;
  const pick: Pick = {
    kind: p.kind,
    rect,
    selector: str(p.selector, SELECTOR_MAX),
    text: str(p.text, TEXT_MAX),
    html: str(p.html, HTML_MAX),
    frames: (Array.isArray(p.frames) ? p.frames : []).map(cleanFrame).filter((f): f is SourceFrame => !!f).slice(0, FRAMES_MAX),
  };
  if (str(p.component, 120)) pick.component = str(p.component, 120);
  if (Array.isArray(p.elements)) {
    pick.elements = p.elements.slice(0, ELEMENTS_MAX).map((e) => {
      const el = (e ?? {}) as Record<string, unknown>;
      return { selector: str(el.selector, SELECTOR_MAX), text: str(el.text, TEXT_MAX) };
    });
  }
  return pick;
}

/**
 * A source path from the dev server, relative to the previewed worktree; null for a
 * file outside the project or inside dependencies. Pure.
 */
export function relativeSourceFile(file: string, worktree: string): string | null {
  let path = file.trim().replace(/[?#].*$/, '');
  if (!path) return null;
  path = path.replace(/^file:\/\//, '').replace(/^webpack-internal:\/\/\/(?:\([^)]*\)\/)?/, '').replace(/^\.\//, '');
  const root = worktree.replace(/\/+$/, '');
  if (path.startsWith(`${root}/`)) path = path.slice(root.length + 1);
  else if (path.startsWith('/')) {
    // Vite serves project files from the root as /src/…; anything else absolute is outside
    if (!/^\/(src|app|apps|packages|components|pages|lib)\//.test(path)) return null;
    path = path.slice(1);
  }
  if (!path || path.split('/').includes('..') || /(^|\/)node_modules\//.test(path)) return null;
  return path;
}
