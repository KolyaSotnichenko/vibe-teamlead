/**
 * What a QA approval of a task with a design must show: each frame of the design next to the
 * running app. QA reviewers were told to compare the built pages with the design, wrote
 * design_compare.json with no screens in it and approved; in one project 26 of 28 UI tasks
 * merged that way, and the app looked nothing like its design. So the app checks the file
 * itself: every frame has an entry, each entry is a screenshot taken after the last commit or a
 * reason it could not be shown, and nothing blocking is left. A frame not shown keeps the task
 * from merging by itself (qa-approval.ts). No Electron imports.
 */

import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import { designDir, designFile, readDesignCanvas, readDesignState, realFileInside, type DesignFrame } from './design-step';

/** A frame QA must show: one file at one width */
export interface EvidenceFrame {
  file: string;
  width: number;
}

/** A frame QA could not show in the running app, and why */
export interface NotShownFrame extends EvidenceFrame {
  reason: string;
}

export interface VisualEvidence {
  /** Why the approval does not count; empty when it does */
  problems: string[];
  /** Frames left out with a reason: the owner looks at them before the task merges */
  notShown: NotShownFrame[];
}

export const COMPARE_FILE = 'design_compare.json';
export const SCREENSHOT_DIR = 'qa-browser';
const IMAGE = /\.(png|jpe?g|webp)$/i;
const MAX_LISTED = 12;

/** The frames of the design QA checks: the screens, or the wireframes when there are none. Pure. */
export function requiredFrames(frames: DesignFrame[]): EvidenceFrame[] {
  const screens = frames.filter((f) => f.kind === 'screen');
  const reference = screens.length ? screens : frames.filter((f) => f.kind === 'wireframe');
  const seen = new Set<string>();
  const out: EvidenceFrame[] = [];
  for (const { file, width } of reference) {
    const key = `${file}@${width}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ file, width });
  }
  return out;
}

const label = (f: EvidenceFrame) => `${f.file} at ${f.width} px`;

const text = (value: unknown, max = 500) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** Whether the file starts like a PNG, JPEG or WebP picture. */
function looksLikeImage(full: string): boolean {
  const head = Buffer.alloc(12);
  let fd: number | undefined;
  try {
    fd = openSync(full, 'r');
    if (readSync(fd, head, 0, 12, 0) < 12) return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const png = head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const jpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  const webp = head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP';
  return png || jpeg || webp;
}

/** Whether qa-browser/ is a folder of the spec directory itself, not a link to one elsewhere. */
function realScreenshotDir(specDir: string): boolean {
  try {
    const root = path.join(specDir, SCREENSHOT_DIR);
    return lstatSync(root).isDirectory() && realpathSync(root) === path.join(realpathSync(specDir), SCREENSHOT_DIR);
  } catch {
    return false;
  }
}

const MAX_HASHED = 64 * 1024 * 1024;

/** What the picture is, the same under every name (a hard link, a copy), or the path when it can't be read. */
function pictureIdentity(full: string): string {
  try {
    return createHash('sha256').update(readFileSync(full)).digest('hex');
  } catch {
    return full;
  }
}

/** Why `built` is not a screenshot of this review, or null. */
function screenshotProblem(specDir: string, built: string, since: number): string | null {
  const root = path.resolve(specDir, SCREENSHOT_DIR);
  const full = path.resolve(specDir, built);
  if (!full.startsWith(root + path.sep)) return `${built} is not under ${SCREENSHOT_DIR}/ in the spec directory, where the browser saves screenshots`;
  if (!IMAGE.test(full)) return `${built} is not an image (png, jpg or webp)`;
  let stat;
  try {
    stat = statSync(full);
  } catch {
    return `${built} does not exist`;
  }
  // A link could point at any picture: only a real file the browser saved here counts, in a real folder of the spec
  if (!stat.isFile() || !realScreenshotDir(specDir) || !realFileInside(root, full)) return `${built} is not a file saved under ${SCREENSHOT_DIR}/`;
  if (stat.size > MAX_HASHED) return `${built} is larger than a screenshot can be`;
  if (!looksLikeImage(full)) return `${built} is not an image (png, jpg or webp)`;
  if (stat.mtimeMs < since) return `${built} was taken before the last commit, so it shows older code: take it again`;
  return null;
}

/**
 * Whether design_compare.json shows every frame of the design in the running app. `since` is the
 * time of the last commit (screenshots older than it show older code); `browser` is whether the
 * session had browser tools: with them at least one frame must be a real screenshot. Never throws.
 */
export function checkVisualEvidence(options: { specDir: string; frames: EvidenceFrame[]; since: number; browser: boolean }): VisualEvidence {
  const { specDir, frames, since, browser } = options;
  if (!frames.length) return { problems: [], notShown: [] };

  let entries: Array<Record<string, unknown>> | null = null;
  try {
    const parsed = JSON.parse(readFileSync(path.join(specDir, COMPARE_FILE), 'utf-8')) as { screens?: unknown };
    if (Array.isArray(parsed?.screens)) entries = parsed.screens.map((s) => (s ?? {}) as Record<string, unknown>);
  } catch {
    // missing or not JSON
  }
  if (!entries) {
    return { problems: [`${COMPARE_FILE} is missing or not valid JSON: write one entry per frame of the design (see "The task's design" in your instructions)`], notShown: [] };
  }

  const problems: string[] = [];
  const notShown: NotShownFrame[] = [];
  const missing: EvidenceFrame[] = [];
  let shown = 0;
  const used = new Map<string, EvidenceFrame>();
  for (const f of frames) {
    const entry = entries.find((e) => e.file === f.file && e.width === f.width);
    if (!entry) {
      missing.push(f);
      continue;
    }
    const built = text(entry.built, 300);
    const reason = text(entry.notShown);
    if (built) {
      // Only a file that passed the checks is read, to tell one picture from another
      let problem = screenshotProblem(specDir, built, since);
      if (!problem) {
        const key = pictureIdentity(path.resolve(specDir, built));
        const earlier = used.get(key);
        if (earlier) problem = `${built} is already the screenshot of ${label(earlier)}: each frame needs its own`;
        else used.set(key, f);
      }
      if (problem) problems.push(`${label(f)}: ${problem}`);
      else shown++;
    } else if (reason) {
      notShown.push({ ...f, reason });
    } else {
      missing.push(f);
    }
    for (const d of Array.isArray(entry.differences) ? entry.differences : []) {
      const diff = (d ?? {}) as Record<string, unknown>;
      if (diff.severity === 'blocking') problems.push(`${label(f)}: a blocking difference is left: ${text(diff.text, 200)}. Reject the task with it as an issue instead`);
    }
  }
  if (missing.length) {
    const listed = missing.slice(0, MAX_LISTED).map(label).join('; ');
    const more = missing.length > MAX_LISTED ? ` and ${missing.length - MAX_LISTED} more` : '';
    problems.push(`No screenshot and no reason for ${missing.length} frame(s): ${listed}${more}`);
  }
  if (browser && shown === 0 && !problems.length) {
    problems.push('No screen was opened in the running app. Start it, sign in with its test sign-in, make the data a screen needs, and take the screenshots; if the app cannot start, that is a critical issue: reject the task');
  }
  return { problems, notShown };
}

const DESIGN_REF = /^(base\/)?(wireframes|screens)\/[A-Za-z0-9_][A-Za-z0-9._-]{0,120}\.html$/;

/**
 * A design file as the planner named it in `design_files` ("design/base/screens/board.html", an
 * absolute path, or "screens/card.html"), as a path under design/; null for anything else. Pure.
 */
export function designFileRef(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const at = raw.replace(/\\/g, '/').lastIndexOf('/design/');
  const ref = at >= 0 ? raw.replace(/\\/g, '/').slice(at + '/design/'.length) : raw.replace(/^design\//, '');
  return DESIGN_REF.test(ref) ? ref : null;
}

/** The design files the plan's subtasks build to (their `design_files`), each once. Never throws. */
export function planDesignFiles(specDir: string): string[] {
  try {
    const plan = JSON.parse(readFileSync(path.join(specDir, 'implementation_plan.json'), 'utf-8')) as { phases?: Array<{ subtasks?: Array<{ design_files?: unknown }> }> };
    const refs = (plan.phases ?? []).flatMap((phase) => phase?.subtasks ?? []).flatMap((s) => (Array.isArray(s?.design_files) ? s.design_files : []));
    return [...new Set(refs.map(designFileRef).filter((ref): ref is string => ref !== null))];
  } catch {
    return [];
  }
}

/** The library's frames (design/base/canvas.json): the widths a library screen is drawn at. Never throws. */
function libraryWidths(specDir: string): Map<string, number[]> {
  const widths = new Map<string, number[]>();
  try {
    const canvas = JSON.parse(readFileSync(path.join(designDir(specDir), 'base', 'canvas.json'), 'utf-8')) as { frames?: Array<{ file?: unknown; width?: unknown }> };
    for (const f of canvas.frames ?? []) {
      if (typeof f?.file !== 'string' || typeof f.width !== 'number' || !Number.isFinite(f.width)) continue;
      const key = `base/${f.file}`;
      widths.set(key, [...(widths.get(key) ?? []), Math.round(f.width)]);
    }
  } catch {
    // no library canvas: the desktop width
  }
  return widths;
}

/**
 * The frames an approval of this task must show: the task's own design, and the screens of the
 * library its plan rebuilds (a redesign changes screens earlier tasks drew; in one project its
 * own design had 10 screens and the board, the card and the Gantt chart were never shown). None
 * without a design, or when it was skipped. Never throws.
 */
export function taskEvidenceFrames(specDir: string): EvidenceFrame[] {
  const state = readDesignState(specDir);
  if (!state || state.stage === 'skipped') return [];
  const frames = requiredFrames(readDesignCanvas(specDir).frames);
  const library = libraryWidths(specDir);
  const seen = new Set(frames.map((f) => `${f.file}@${f.width}`));
  for (const ref of planDesignFiles(specDir)) {
    const full = designFile(specDir, ref);
    if (!full || !realFileInside(designDir(specDir), full)) continue;
    const widths = ref.startsWith('base/') ? (library.get(ref) ?? [1280]) : frames.some((f) => f.file === ref) ? [] : [1280];
    for (const width of widths) {
      if (seen.has(`${ref}@${width}`)) continue;
      seen.add(`${ref}@${width}`);
      frames.push({ file: ref, width });
    }
  }
  return frames;
}

/** The problems as one message for the reviewer. Pure. */
export function evidenceRefusal(problems: string[]): string {
  return [
    'Error: approval not recorded. A task with a design is approved only with each frame of the design shown in the running app (design_compare.json):',
    ...problems.slice(0, MAX_LISTED).map((p) => `- ${p}`),
    ...(problems.length > MAX_LISTED ? [`- …and ${problems.length - MAX_LISTED} more`] : []),
    'Fix design_compare.json and the screenshots, then record the verdict again.',
  ].join('\n');
}
