/**
 * Design references (main process): add files and sites, digest each once,
 * keep the index current and tell the renderer when something changed.
 *
 * Digesting, by kind:
 * - token file: read exactly in code, no model;
 * - image: palette measured from the pixels, then a short look by the design agent;
 * - PDF: the design agent reads it (Claude Code shows PDF pages to the model);
 * - site: opened in a hidden, sandboxed window: screenshot + what its CSS
 *   declares, palette measured from the screenshot, then the agent's look.
 * One digest runs at a time per app, so adding fifty references is fine.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { BrowserWindow, nativeImage, session } from 'electron';
import { z } from 'zod';

import type {
  DesignReference,
  DesignReferenceColor,
  DesignReferenceList,
  DesignReferenceNotes,
  DesignReferenceRole,
} from '../../shared/types';
import { getFeatureSettings } from '../ipc-handlers/feature-settings-helper';
import { runClaudeTask } from '../ai/claude-code/task';
import type { ThinkingLevel } from '../ai/config/types';
import { tryLoadPrompt } from '../ai/prompts/prompt-loader';
import { isMacOS } from '../platform';
import {
  REFERENCES_DIR,
  absoluteIn,
  existsIn,
  newReferenceId,
  normalizeColor,
  notesFromTokens,
  paletteFromPixels,
  parseTokenFile,
  readReferences,
  referenceKindOf,
  referencesDir,
  summarizeReferences,
  themeOf,
  updateReference,
  writeReferences,
} from '../ai/design/references';

const MAX_FILE_BYTES = 30 * 1024 * 1024;
/** Longest side of the PNG the agent looks at (larger images only cost tokens) */
const PREVIEW_PX = 1568;
const THUMB_PX = 160;
const SITE_TIMEOUT_MS = 30_000;

type Changed = (projectPath: string) => void;
let notifyChanged: Changed = () => {};
export function onReferencesChanged(callback: Changed): void {
  notifyChanged = callback;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

const thumbs = new Map<string, string>();

function thumbnailOf(projectPath: string, ref: DesignReference): string | undefined {
  if (!ref.preview || !existsIn(projectPath, ref.preview)) return undefined;
  const key = `${projectPath}|${ref.id}`;
  const cached = thumbs.get(key);
  if (cached) return cached;
  try {
    const image = nativeImage.createFromPath(absoluteIn(projectPath, ref.preview) as string);
    if (image.isEmpty()) return undefined;
    const { width, height } = image.getSize();
    const small = width >= height ? image.resize({ width: THUMB_PX }) : image.resize({ height: THUMB_PX });
    const url = small.toDataURL();
    thumbs.set(key, url);
    return url;
  } catch {
    return undefined;
  }
}

export function listReferences(projectPath: string): DesignReferenceList {
  const references = readReferences(projectPath);
  return {
    references: references.map((ref) => ({ ...ref, thumbnail: thumbnailOf(projectPath, ref) })),
    summary: summarizeReferences(references),
  };
}

// ---------------------------------------------------------------------------
// Add, change, remove
// ---------------------------------------------------------------------------

/** A PNG the agent can look at: the image itself, downscaled, or a PDF's first page (macOS Quick Look). */
/** macOS's own converter: reads WebP (and HEIC, TIFF) that nativeImage can't decode */
async function sipsToPng(source: string, target: string): Promise<boolean> {
  if (!isMacOS()) return false;
  try {
    await promisify(execFile)('sips', ['-s', 'format', 'png', source, '--out', target], { timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

/** A PNG preview of the reference (its colours are measured from it). Exported for tests. */
export async function makePreview(source: string, target: string, kind: DesignReference['kind'], convert = sipsToPng): Promise<boolean> {
  try {
    let image = kind === 'pdf'
      ? await nativeImage.createThumbnailFromPath(source, { width: PREVIEW_PX, height: PREVIEW_PX })
      : nativeImage.createFromPath(source);
    // WebP and the like: convert to PNG first, then size it like any other
    if (image.isEmpty() && kind === 'image' && (await convert(source, target))) image = nativeImage.createFromPath(target);
    if (image.isEmpty()) return false;
    const { width, height } = image.getSize();
    if (Math.max(width, height) > PREVIEW_PX) {
      image = width >= height ? image.resize({ width: PREVIEW_PX, quality: 'good' }) : image.resize({ height: PREVIEW_PX, quality: 'good' });
    }
    writeFileSync(target, image.toPNG());
    return true;
  } catch {
    return false;
  }
}

export async function addReferenceFiles(projectPath: string, files: string[], role: DesignReferenceRole = 'inspiration'): Promise<{ list: DesignReferenceList; skipped: string[]; added: string[] }> {
  const dir = referencesDir(projectPath);
  const skipped: string[] = [];
  const added: DesignReference[] = [];
  for (const file of files) {
    const kind = referenceKindOf(file);
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      skipped.push(path.basename(file));
      continue;
    }
    if (!kind || size > MAX_FILE_BYTES) {
      skipped.push(path.basename(file));
      continue;
    }
    const name = path.basename(file);
    const id = newReferenceId(name);
    const ext = path.extname(file).toLowerCase();
    const stored = `${REFERENCES_DIR}/${id}${ext}`;
    mkdirSync(dir, { recursive: true });
    copyFileSync(file, path.join(projectPath, stored));
    let preview: string | undefined;
    if (kind === 'image' || kind === 'pdf') {
      const previewRel = `${REFERENCES_DIR}/${id}.preview.png`;
      if (await makePreview(path.join(projectPath, stored), path.join(projectPath, previewRel), kind)) preview = previewRel;
    }
    added.push({
      id,
      kind,
      name,
      source: name,
      // Token files and PDFs (brand books) are usually rules; images are inspiration. Changeable per reference.
      role: kind === 'tokens' || kind === 'pdf' ? 'as-is' : role,
      addedAt: new Date().toISOString(),
      file: stored,
      ...(preview ? { preview } : {}),
      status: 'pending',
    });
  }
  if (added.length) writeReferences(projectPath, [...readReferences(projectPath), ...added]);
  for (const ref of added) enqueue(projectPath, ref.id);
  return { list: listReferences(projectPath), skipped, added: added.map((r) => r.id) };
}

/** http(s) URLs only; a bare domain gets https://. Pure — tested directly. */
export function normalizeUrl(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function addReferenceUrls(projectPath: string, urls: string[], role: DesignReferenceRole = 'inspiration'): { list: DesignReferenceList; skipped: string[] } {
  const skipped: string[] = [];
  const existing = new Set(readReferences(projectPath).map((r) => r.source));
  const added: DesignReference[] = [];
  for (const raw of urls) {
    const url = normalizeUrl(raw);
    if (!url) {
      if (raw.trim()) skipped.push(raw.trim());
      continue;
    }
    if (existing.has(url)) continue;
    existing.add(url);
    added.push({
      id: newReferenceId(new URL(url).hostname),
      kind: 'site',
      name: new URL(url).hostname,
      source: url,
      role,
      addedAt: new Date().toISOString(),
      status: 'pending',
    });
  }
  if (added.length) writeReferences(projectPath, [...readReferences(projectPath), ...added]);
  for (const ref of added) enqueue(projectPath, ref.id);
  return { list: listReferences(projectPath), skipped };
}

export function setReferenceRole(projectPath: string, id: string, role: DesignReferenceRole): DesignReferenceList {
  updateReference(projectPath, id, (ref) => ({ ...ref, role }));
  return listReferences(projectPath);
}

export function removeReference(projectPath: string, id: string): DesignReferenceList {
  const ref = readReferences(projectPath).find((r) => r.id === id);
  updateReference(projectPath, id, () => null);
  for (const rel of [ref?.file, ref?.preview]) {
    // Only files inside the references folder
    if (rel?.startsWith(`${REFERENCES_DIR}/`)) rmSync(path.join(projectPath, rel), { force: true });
  }
  thumbs.delete(`${projectPath}|${id}`);
  return listReferences(projectPath);
}

export function retryReference(projectPath: string, id: string): DesignReferenceList {
  updateReference(projectPath, id, (ref) => ({ ...ref, status: 'pending', error: undefined }));
  enqueue(projectPath, id);
  return listReferences(projectPath);
}

/** Digests left pending by a quit (or a crash) start again when the list is opened. */
export function resumePending(projectPath: string): void {
  for (const ref of readReferences(projectPath)) {
    if (ref.status === 'pending' || ref.status === 'digesting') enqueue(projectPath, ref.id);
  }
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

const queue: Array<{ projectPath: string; id: string }> = [];
const queued = new Set<string>();
let running = false;
/** The reference being digested now: resuming the list mustn't queue it again */
let current: string | null = null;

function enqueue(projectPath: string, id: string): void {
  const key = `${projectPath}|${id}`;
  if (queued.has(key) || current === key) return;
  queued.add(key);
  queue.push({ projectPath, id });
  void drain();
}

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const job = queue.shift() as { projectPath: string; id: string };
      queued.delete(`${job.projectPath}|${job.id}`);
      const ref = readReferences(job.projectPath).find((r) => r.id === job.id);
      // Only what still waits: a ready or failed one is digested again only by Retry (it sets pending)
      if (!ref || ref.status === 'ready' || ref.status === 'error') continue;
      current = `${job.projectPath}|${job.id}`;
      updateReference(job.projectPath, ref.id, (r) => ({ ...r, status: 'digesting', error: undefined }));
      notifyChanged(job.projectPath);
      try {
        const result = await digest(job.projectPath, ref);
        updateReference(job.projectPath, ref.id, (r) => ({ ...r, ...result, status: 'ready', error: undefined }));
      } catch (error) {
        updateReference(job.projectPath, ref.id, (r) => ({ ...r, status: 'error', error: error instanceof Error ? error.message : String(error) }));
      }
      current = null;
      thumbs.delete(`${job.projectPath}|${ref.id}`);
      notifyChanged(job.projectPath);
    }
  } finally {
    running = false;
    current = null;
  }
}

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

const DigestSchema = z.object({
  summary: z.string().min(1),
  paletteRoles: z.array(z.object({ value: z.string(), role: z.string() })).max(16).default([]),
  fonts: z.array(z.string().min(1)).max(6).default([]),
  traits: z.array(z.string().min(1)).max(10).default([]),
  takeaways: z.array(z.string().min(1)).max(8).default([]),
});

function measuredPalette(pngPath: string): DesignReferenceColor[] {
  const image = nativeImage.createFromPath(pngPath);
  if (image.isEmpty()) return [];
  const { width, height } = image.getSize();
  return paletteFromPixels(image.toBitmap(), width, height, { bgra: true });
}

/** Ask the design agent to look at one reference; `measured` are the pixel colours to name. */
async function agentLook(
  projectPath: string,
  what: { kind: DesignReference['kind']; name: string; openPath: string; measured: DesignReferenceColor[]; extra?: string },
): Promise<z.infer<typeof DigestSchema>> {
  const systemPrompt = tryLoadPrompt('design_system');
  if (!systemPrompt) throw new Error('The design system prompt is missing from this build.');
  const feature = getFeatureSettings('designSystem');
  const result = await runClaudeTask({
    systemPrompt,
    prompt: [
      'Job: DIGEST.',
      `Reference: ${what.name} (${what.kind}). Open it with Read: ${what.openPath}`,
      what.measured.length
        ? `Measured colours (largest first, share of the area): ${what.measured.map((c) => `${c.value} ${Math.round((c.share ?? 0) * 100)}%`).join(', ')}`
        : 'No colours were measured; list the ones it specifies, if any.',
      what.extra ?? '',
    ].filter(Boolean).join('\n'),
    model: feature.model,
    thinkingLevel: feature.thinkingLevel as ThinkingLevel,
    tools: ['Read'],
    cwd: projectPath,
    agentType: 'design_system',
    outputSchema: DigestSchema,
    maxTurns: 8,
  });
  if (!result.output) throw new Error('The agent returned no notes for this reference.');
  return result.output as z.infer<typeof DigestSchema>;
}

/** Measured colours with the roles the agent gave them (and the colours it named itself). Pure — tested directly. */
export function mergePalette(measured: DesignReferenceColor[], roles: Array<{ value: string; role: string }>): DesignReferenceColor[] {
  const named = roles
    .map((r) => ({ value: normalizeColor(r.value), role: r.role }))
    .filter((r): r is { value: string; role: string } => !!r.value);
  if (!measured.length) return named.slice(0, 12);
  return measured.map((c) => ({ ...c, ...(named.find((r) => r.value === c.value)?.role ? { role: named.find((r) => r.value === c.value)?.role } : {}) }));
}

async function digest(projectPath: string, ref: DesignReference): Promise<Partial<DesignReference>> {
  const file = absoluteIn(projectPath, ref.file);
  if (ref.kind === 'tokens') {
    if (!file || !existsSync(file)) throw new Error('The file is missing.');
    const tokens = parseTokenFile(file, readFileSync(file, 'utf-8'));
    if (!tokens) throw new Error('No colours, fonts or radii found in this file.');
    return { notes: notesFromTokens(tokens) };
  }

  if (ref.kind === 'image') {
    const preview = absoluteIn(projectPath, ref.preview) ?? file;
    if (!preview || !existsSync(preview)) throw new Error('This image could not be opened (supported: PNG, JPEG, WebP, GIF).');
    const measured = measuredPalette(preview);
    return { notes: await lookOrMeasureOnly(projectPath, ref, preview, measured) };
  }

  if (ref.kind === 'pdf') {
    if (!file || !existsSync(file)) throw new Error('The file is missing.');
    const look = await agentLook(projectPath, { kind: 'pdf', name: ref.name, openPath: file, measured: [] });
    const palette = mergePalette([], look.paletteRoles);
    return { notes: { summary: look.summary, palette, fonts: look.fonts, theme: themeOf(palette), traits: look.traits, takeaways: look.takeaways } };
  }

  // Site
  const capture = await captureSite(ref.source);
  const previewRel = `${REFERENCES_DIR}/${ref.id}.preview.png`;
  writeFileSync(path.join(projectPath, previewRel), capture.png);
  const measured = measuredPalette(path.join(projectPath, previewRel));
  const cssTokens = parseTokenFile('site.css', capture.cssVariables);
  const extra = [
    `Page title: ${capture.title || '(none)'}`,
    capture.fonts.length ? `Fonts the CSS uses: ${capture.fonts.join(', ')}` : '',
    capture.radii.length ? `Border radii on buttons/inputs/cards: ${capture.radii.join(', ')}` : '',
    `Box shadows on those elements: ${capture.shadows ? 'yes' : 'none'}`,
    cssTokens?.colors?.length ? `CSS custom properties (colours): ${cssTokens.colors.slice(0, 30).map((c) => `${c.name} ${c.value}`).join(', ')}` : '',
  ].filter(Boolean).join('\n');
  const notes = await lookOrMeasureOnly(projectPath, ref, path.join(projectPath, previewRel), measured, extra);
  return {
    name: capture.title ? `${capture.title.slice(0, 60)} — ${new URL(ref.source).hostname}` : ref.name,
    preview: previewRel,
    notes: {
      ...notes,
      fonts: notes.fonts.length ? notes.fonts : capture.fonts.slice(0, 4),
      ...(cssTokens ? { tokens: { ...cssTokens, ...(capture.radii.length ? { radius: capture.radii } : {}), shadows: capture.shadows } } : {}),
    },
  };
}

/** The agent's notes, or (when it can't run, e.g. no credentials) the measured colours alone. */
async function lookOrMeasureOnly(
  projectPath: string,
  ref: DesignReference,
  pngPath: string,
  measured: DesignReferenceColor[],
  extra?: string,
): Promise<DesignReferenceNotes> {
  try {
    const look = await agentLook(projectPath, { kind: ref.kind, name: ref.name, openPath: pngPath, measured, extra });
    return {
      summary: look.summary,
      palette: mergePalette(measured, look.paletteRoles),
      fonts: look.fonts,
      theme: themeOf(measured),
      traits: look.traits,
      takeaways: look.takeaways,
    };
  } catch (error) {
    if (!measured.length) throw error;
    return {
      summary: `Measured colours only: the design agent could not look at it (${error instanceof Error ? error.message : String(error)}). Retry later for full notes.`,
      palette: measured,
      fonts: [],
      theme: themeOf(measured),
      traits: [],
      takeaways: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Sites: a hidden, sandboxed window (its own in-memory session, no permissions)
// ---------------------------------------------------------------------------

const EXTRACT_JS = `(() => {
  const out = { vars: '', fonts: [], radii: [], shadows: false };
  try {
    const styles = getComputedStyle(document.documentElement);
    const lines = [];
    for (let i = 0; i < styles.length; i++) {
      const p = styles[i];
      if (p.startsWith('--')) lines.push(p + ': ' + styles.getPropertyValue(p).trim() + ';');
    }
    out.vars = lines.slice(0, 600).join('\\n');
  } catch (e) {}
  const pick = (sel) => Array.from(document.querySelectorAll(sel)).slice(0, 8);
  const fonts = new Set();
  for (const el of [document.body, ...pick('h1,h2,h3'), ...pick('p'), ...pick('button,a')]) {
    if (!el) continue;
    const f = getComputedStyle(el).fontFamily.split(',')[0].trim().replace(/^['"]|['"]$/g, '');
    if (f) fonts.add(f);
  }
  out.fonts = Array.from(fonts).slice(0, 6);
  const radii = new Set();
  for (const el of pick('button,input,select,textarea,[class*=card],[class*=Card]')) {
    const s = getComputedStyle(el);
    const r = parseFloat(s.borderTopLeftRadius);
    if (!isNaN(r)) radii.add(Math.round(r));
    if (s.boxShadow && s.boxShadow !== 'none') out.shadows = true;
  }
  out.radii = Array.from(radii).sort((a, b) => a - b).slice(0, 8);
  return out;
})()`;

let sessionReady = false;

async function captureSite(url: string): Promise<{ png: Buffer; title: string; cssVariables: string; fonts: string[]; radii: number[]; shadows: boolean }> {
  const partition = 'design-references'; // no "persist:" prefix: in memory only
  const ses = session.fromPartition(partition);
  if (!sessionReady) {
    sessionReady = true;
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.on('will-download', (event) => event.preventDefault());
  }
  const win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition, backgroundThrottling: false },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, target) => {
    if (!/^https?:/i.test(target)) event.preventDefault();
  });
  win.webContents.setAudioMuted(true);
  try {
    await Promise.race([
      win.loadURL(url),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`The page did not load within ${SITE_TIMEOUT_MS / 1000}s.`)), SITE_TIMEOUT_MS)),
    ]);
    // Fonts, lazy images and entrance animations settle
    await new Promise((r) => setTimeout(r, 1500));
    const info = (await win.webContents.executeJavaScript(EXTRACT_JS, true)) as { vars: string; fonts: string[]; radii: number[]; shadows: boolean };
    const image = await win.webContents.capturePage();
    if (image.isEmpty()) throw new Error('The page could not be captured.');
    return { png: image.toPNG(), title: win.webContents.getTitle(), cssVariables: info.vars ?? '', fonts: info.fonts ?? [], radii: info.radii ?? [], shadows: !!info.shadows };
  } catch (error) {
    throw new Error(`Could not open ${url}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    win.destroy();
  }
}
