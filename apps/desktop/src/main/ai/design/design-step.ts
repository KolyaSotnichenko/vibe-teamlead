/**
 * Design before code: the designer draws a UI task's screens before the plan, first as wireframes,
 * then in the project's design system. Its files live in the task's spec folder:
 *
 *   design/state.json      where the design is, what the owner approved, their comments
 *   design/canvas.json     the frames on the canvas: file, title, kind, size, position
 *   design/wireframes/*.html, design/screens/*.html
 *
 * The build runs this before architecture and planning (build-orchestrator). Pure decisions here;
 * the file helpers never throw.
 */

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { writeFileReplacingSync } from '../safe-write';

export type DesignMode = 'off' | 'wireframes' | 'full';
export type DesignApproval = 'owner' | 'auto';
export type DesignJob = 'wireframes' | 'design' | 'revise';

export interface DesignComment {
  n: number;
  /** The frame's file, relative to design/ */
  frame: string;
  /** Where on the frame: an element selector and the click point in the frame's CSS px */
  selector?: string;
  x?: number;
  y?: number;
  text: string;
}

export interface DesignState {
  /** wireframes / design: drawn and waiting (or going on); skipped: the designer found no UI to draw */
  stage: 'wireframes' | 'design' | 'skipped';
  /** Designer sessions so far */
  round: number;
  approved?: { wireframes?: string; design?: string };
  /** The owner's comments for the next round (cleared when the designer takes them) */
  comments?: DesignComment[];
  /** Design-check findings left in the screens after the designer's pass */
  checkFindings?: number;
}

export interface DesignFrame {
  file: string;
  title: string;
  kind: 'wireframe' | 'screen';
  width: number;
  height: number;
  x: number;
  y: number;
  /** Phone, desktop… what the frame shows (free text) */
  note?: string;
}

export type DesignAction = { kind: 'draw'; job: DesignJob } | { kind: 'pause'; stage: 'wireframes' | 'design' } | { kind: 'continue' };

/** What the build does next about the design. Pure. */
export function nextDesignAction(state: DesignState | undefined, settings: { mode: DesignMode; approval: DesignApproval }): DesignAction {
  if (settings.mode === 'off' || state?.stage === 'skipped') return { kind: 'continue' };
  if (!state) return { kind: 'draw', job: 'wireframes' };
  if (state.comments?.length) return { kind: 'draw', job: 'revise' };
  const auto = settings.approval === 'auto';
  if (state.stage === 'wireframes') {
    if (!auto && !state.approved?.wireframes) return { kind: 'pause', stage: 'wireframes' };
    return settings.mode === 'full' ? { kind: 'draw', job: 'design' } : { kind: 'continue' };
  }
  if (!auto && !state.approved?.design) return { kind: 'pause', stage: 'design' };
  return { kind: 'continue' };
}

const UI_PATH = /`([^`\s]+\.[a-z0-9]+)`/gi;
const FILES_SECTION = /^##+\s*Files to (Modify|Create|Change)\b[\s\S]*?(?=^##\s|(?![\s\S]))/gim;

/**
 * Whether a task changes UI, from its spec: a UI file in its "Files to Modify/Create" sections,
 * or no files named at all in a project that has a UI. Pure.
 */
export function specTouchesUi(specMd: string, opts: { projectHasUi: boolean; isUiFile: (file: string) => boolean }): boolean {
  if (!opts.projectHasUi) return false;
  const sections = specMd.match(FILES_SECTION) ?? [];
  const files = sections.flatMap((section) => [...section.matchAll(UI_PATH)].map((m) => m[1]));
  if (!files.length) return true;
  return files.some(opts.isUiFile);
}

const designDir = (specDir: string) => path.join(specDir, 'design');

export function readDesignState(specDir: string): DesignState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path.join(designDir(specDir), 'state.json'), 'utf-8')) as DesignState;
    return parsed && typeof parsed === 'object' && typeof parsed.stage === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function writeDesignState(specDir: string, state: DesignState): void {
  mkdirSync(designDir(specDir), { recursive: true });
  writeFileReplacingSync(path.join(designDir(specDir), 'state.json'), JSON.stringify(state, null, 2));
}

/** A path under design/ that stays inside it, or null */
export function designFile(specDir: string, relative: string): string | null {
  if (typeof relative !== 'string' || !relative || relative.includes('\0')) return null;
  const root = path.resolve(designDir(specDir));
  const full = path.resolve(root, relative);
  return full.startsWith(root + path.sep) ? full : null;
}

const num = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

/** The frames on the canvas whose files exist inside design/. Never throws. */
export function readDesignCanvas(specDir: string): { frames: DesignFrame[] } {
  try {
    const parsed = JSON.parse(readFileSync(path.join(designDir(specDir), 'canvas.json'), 'utf-8')) as { frames?: unknown[] };
    const frames: DesignFrame[] = [];
    for (const raw of Array.isArray(parsed?.frames) ? parsed.frames : []) {
      const frame = raw as Record<string, unknown>;
      const file = typeof frame.file === 'string' ? frame.file : '';
      const full = designFile(specDir, file);
      if (!full || !file.endsWith('.html') || !existsSync(full) || !statSync(full).isFile()) continue;
      frames.push({
        file,
        title: typeof frame.title === 'string' ? frame.title.slice(0, 120) : file,
        kind: frame.kind === 'screen' ? 'screen' : 'wireframe',
        width: Math.min(4000, Math.max(200, num(frame.width, 1280))),
        height: Math.min(8000, Math.max(200, num(frame.height, 900))),
        x: num(frame.x, 0),
        y: num(frame.y, 0),
        ...(typeof frame.note === 'string' ? { note: frame.note.slice(0, 200) } : {}),
      });
    }
    return { frames: frames.slice(0, 60) };
  } catch {
    return { frames: [] };
  }
}
