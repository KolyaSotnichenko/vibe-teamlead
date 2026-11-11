/**
 * Design references on disk (no Electron: used by main and worker).
 *
 * `<project>/.vibe-teamlead/design/references/` holds the files (images,
 * PDFs, token files, page screenshots) and `index.json`, the list with each
 * reference's role and the notes written when it was digested. Agents work
 * from the notes and open only a few of the images, so any number of
 * references fits.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type {
  DesignReference,
  DesignReferenceColor,
  DesignReferenceKind,
  DesignReferenceNotes,
  DesignReferenceSummary,
  DesignTokens,
} from '../../../shared/types';

export const REFERENCES_DIR = '.vibe-teamlead/design/references';
const INDEX_FILE = 'index.json';
/** Inspiration images an agent opens itself; the rest it knows from their notes */
export const INSPIRATION_IMAGES_OPENED = 6;

export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
export const TOKEN_EXTENSIONS = new Set(['.json', '.css', '.scss', '.js', '.cjs', '.mjs', '.ts']);

export function referencesDir(projectPath: string): string {
  return path.join(projectPath, REFERENCES_DIR);
}

/** What kind of reference a file is, by extension (undefined: not supported). Pure. */
export function referenceKindOf(file: string): DesignReferenceKind | undefined {
  const ext = path.extname(file).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (TOKEN_EXTENSIONS.has(ext)) return 'tokens';
  return undefined;
}

export function readReferences(projectPath: string): DesignReference[] {
  try {
    const raw = JSON.parse(readFileSync(path.join(referencesDir(projectPath), INDEX_FILE), 'utf-8')) as { references?: unknown };
    return Array.isArray(raw.references) ? (raw.references as DesignReference[]) : [];
  } catch {
    return [];
  }
}

export function writeReferences(projectPath: string, references: DesignReference[]): void {
  const dir = referencesDir(projectPath);
  mkdirSync(dir, { recursive: true });
  // Write then rename: a digest finishing mid-write never leaves a broken index
  const tmp = path.join(dir, `${INDEX_FILE}.tmp`);
  writeFileSync(tmp, JSON.stringify({ references }, null, 2), 'utf-8');
  renameSync(tmp, path.join(dir, INDEX_FILE));
}

/** Change one reference in the index; returns the new list. */
export function updateReference(
  projectPath: string,
  id: string,
  change: (ref: DesignReference) => DesignReference | null,
): DesignReference[] {
  const next: DesignReference[] = [];
  for (const ref of readReferences(projectPath)) {
    if (ref.id !== id) {
      next.push(ref);
      continue;
    }
    const changed = change(ref);
    if (changed) next.push(changed);
  }
  writeReferences(projectPath, next);
  return next;
}

export function newReferenceId(name: string, now = Date.now()): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'ref';
  return `${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}-${slug}`;
}

export function absoluteIn(projectPath: string, relative: string | undefined): string | undefined {
  return relative ? path.join(projectPath, relative) : undefined;
}

export function existsIn(projectPath: string, relative: string | undefined): boolean {
  return !!relative && existsSync(path.join(projectPath, relative));
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
export const toHex = (r: number, g: number, b: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}`.toUpperCase();

/** #RGB, #RRGGBB, #RRGGBBAA, rgb()/rgba() → #RRGGBB, or undefined. Pure. */
export function normalizeColor(value: string): string | undefined {
  const v = value.trim();
  let m = v.match(/^#([0-9a-f]{3})$/i);
  if (m) return `#${m[1].split('').map((c) => c + c).join('')}`.toUpperCase();
  m = v.match(/^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i);
  if (m) return `#${m[1]}`.toUpperCase();
  m = v.match(/^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)/i);
  if (m) return toHex(Number(m[1]), Number(m[2]), Number(m[3]));
  return undefined;
}

const rgbOf = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

export function colorDistance(a: string, b: string): number {
  const [r1, g1, b1] = rgbOf(a);
  const [r2, g2, b2] = rgbOf(b);
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
}

/** Relative luminance 0–1. */
export function luminance(hex: string): number {
  const [r, g, b] = rgbOf(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * The main colours of an image, measured from its pixels (not guessed):
 * coarse buckets, merged when close, largest first. `pixels` is RGBA, or BGRA
 * with `bgra` (Electron's toBitmap). Pure — tested directly.
 */
export function paletteFromPixels(
  pixels: Uint8Array | Buffer,
  width: number,
  height: number,
  options: { bgra?: boolean; max?: number } = {},
): DesignReferenceColor[] {
  const max = options.max ?? 8;
  const total = width * height;
  if (!total) return [];
  const step = Math.max(1, Math.floor(total / 40_000)); // ~40k samples whatever the size
  const buckets = new Map<number, { r: number; g: number; b: number; n: number }>();
  let counted = 0;
  for (let i = 0; i < total; i += step) {
    const o = i * 4;
    if (pixels[o + 3] < 128) continue; // transparent
    const r = options.bgra ? pixels[o + 2] : pixels[o];
    const g = pixels[o + 1];
    const b = options.bgra ? pixels[o] : pixels[o + 2];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bucket = buckets.get(key) ?? { r: 0, g: 0, b: 0, n: 0 };
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    bucket.n += 1;
    buckets.set(key, bucket);
    counted++;
  }
  if (!counted) return [];
  const colors = [...buckets.values()]
    .map((x) => ({ value: toHex(x.r / x.n, x.g / x.n, x.b / x.n), n: x.n }))
    .sort((a, b) => b.n - a.n);
  const merged: Array<{ value: string; n: number }> = [];
  for (const c of colors) {
    const near = merged.find((m) => colorDistance(m.value, c.value) < 28);
    if (near) near.n += c.n;
    else merged.push({ ...c });
  }
  return merged
    .sort((a, b) => b.n - a.n)
    .filter((c) => c.n / counted >= 0.004)
    .slice(0, max)
    .map((c) => ({ value: c.value, share: Math.round((c.n / counted) * 1000) / 1000 }));
}

/** Light or dark, from the largest measured colour. Pure. */
export function themeOf(palette: DesignReferenceColor[]): 'light' | 'dark' | undefined {
  const main = palette[0];
  if (!main) return undefined;
  return luminance(main.value) < 0.25 ? 'dark' : 'light';
}

// ---------------------------------------------------------------------------
// Token files: W3C design tokens / Tokens Studio JSON, our design-tokens.json,
// CSS custom properties, Tailwind config
// ---------------------------------------------------------------------------

type Collected = { colors: Array<{ name: string; value: string }>; fonts: Array<{ role: string; family: string }>; radius: number[]; spacing: number[] };

const px = (v: unknown): number | undefined => {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return undefined;
  const m = v.trim().match(/^(\d+(?:\.\d+)?)(px|rem)?$/);
  if (!m) return undefined;
  return m[2] === 'rem' ? Number(m[1]) * 16 : Number(m[1]);
};
const firstFamily = (v: unknown): string | undefined => {
  const raw = Array.isArray(v) ? v[0] : v;
  if (typeof raw !== 'string') return undefined;
  return raw.split(',')[0].trim().replace(/^['"]|['"]$/g, '') || undefined;
};
const uniqNumbers = (values: number[]) => [...new Set(values.map((v) => Math.round(v * 100) / 100))].sort((a, b) => a - b);

function walkJson(node: unknown, trail: string[], out: Collected): void {
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  const value = obj.$value ?? obj.value;
  const type = String(obj.$type ?? obj.type ?? '').toLowerCase();
  const name = trail.join('.');
  const key = name.toLowerCase();
  if (value !== undefined && (typeof value !== 'object' || Array.isArray(value))) {
    const color = typeof value === 'string' ? normalizeColor(value) : undefined;
    if (color && (type === 'color' || !type)) out.colors.push({ name, value: color });
    else if (type === 'fontfamily' || type === 'fontfamilies' || key.includes('font-family') || key.includes('fontfamily')) {
      const family = firstFamily(value);
      if (family) out.fonts.push({ role: trail[trail.length - 1] ?? 'font', family });
    } else if (key.includes('radius') || type === 'borderradius') {
      const n = px(value);
      if (n !== undefined) out.radius.push(n);
    } else if (key.includes('spacing') || key.includes('space') || type === 'spacing') {
      const n = px(value);
      if (n !== undefined) out.spacing.push(n);
    }
    return;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('$')) continue;
    walkJson(v, [...trail, k], out);
  }
}

function fromCss(text: string, out: Collected): void {
  for (const m of text.matchAll(/--([\w-]+)\s*:\s*([^;}]+)[;}]/g)) {
    const name = m[1];
    const value = m[2].trim();
    const color = normalizeColor(value);
    if (color) out.colors.push({ name, value: color });
    else if (/font/i.test(name) && /[a-z]/i.test(value)) {
      const family = firstFamily(value);
      if (family && !family.startsWith('var(')) out.fonts.push({ role: name.replace(/^font-?/, '') || 'font', family });
    } else if (/radius/i.test(name)) {
      const n = px(value);
      if (n !== undefined) out.radius.push(n);
    } else if (/spac/i.test(name)) {
      const n = px(value);
      if (n !== undefined) out.spacing.push(n);
    }
  }
}

function fromTailwindConfig(text: string, out: Collected): void {
  for (const m of text.matchAll(/['"]?([\w-]+)['"]?\s*:\s*['"](#[0-9a-f]{3,8}|rgba?\([^)]*\))['"]/gi)) {
    const color = normalizeColor(m[2]);
    if (color) out.colors.push({ name: m[1], value: color });
  }
  const fontBlock = text.match(/fontFamily\s*:\s*\{([\s\S]*?)\}/);
  if (fontBlock) {
    for (const m of fontBlock[1].matchAll(/['"]?([\w-]+)['"]?\s*:\s*\[\s*['"]([^'"]+)['"]/g)) out.fonts.push({ role: m[1], family: m[2] });
  }
  const radiusBlock = text.match(/borderRadius\s*:\s*\{([\s\S]*?)\}/);
  if (radiusBlock) {
    for (const m of radiusBlock[1].matchAll(/:\s*['"]([\d.]+(?:px|rem)?)['"]/g)) {
      const n = px(m[1]);
      if (n !== undefined) out.radius.push(n);
    }
  }
}

/** Tokens read exactly from a token file (undefined when it has none). Pure — tested directly. */
export function parseTokenFile(fileName: string, text: string, opts: { maxColors?: number } = {}): Partial<DesignTokens> | undefined {
  const out: Collected = { colors: [], fonts: [], radius: [], spacing: [] };
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.json') {
    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      // Our own design-tokens.json
      if (Array.isArray(json.colors) && Array.isArray(json.fonts)) {
        return {
          colors: (json.colors as Array<{ name: string; value: string; role?: string }>).filter((c) => normalizeColor(c.value)),
          fonts: json.fonts as DesignTokens['fonts'],
          ...(Array.isArray(json.radius) ? { radius: json.radius as number[] } : {}),
          ...(typeof json.shadows === 'boolean' ? { shadows: json.shadows } : {}),
        };
      }
      walkJson(json, [], out);
    } catch {
      return undefined;
    }
  } else if (ext === '.css' || ext === '.scss') {
    fromCss(text, out);
  } else {
    fromTailwindConfig(text, out);
    fromCss(text, out);
  }
  const seen = new Set<string>();
  const colors = out.colors.filter((c) => (seen.has(`${c.name}|${c.value}`) ? false : (seen.add(`${c.name}|${c.value}`), true))).slice(0, opts.maxColors ?? 80);
  const fonts = out.fonts.filter((f, i, all) => all.findIndex((g) => g.family === f.family && g.role === f.role) === i);
  if (!colors.length && !fonts.length && !out.radius.length) return undefined;
  return {
    colors,
    fonts,
    ...(out.radius.length ? { radius: uniqNumbers(out.radius) } : {}),
    ...(out.spacing.length ? { spacing: uniqNumbers(out.spacing) } : {}),
  };
}

/** Notes for a token file: everything comes from the file itself, no model needed. Pure. */
export function notesFromTokens(tokens: Partial<DesignTokens>): DesignReferenceNotes {
  const colors = tokens.colors ?? [];
  const fonts = [...new Set((tokens.fonts ?? []).map((f) => f.family))];
  const traits: string[] = [];
  if (tokens.radius?.length) traits.push(`Radii: ${tokens.radius.join(', ')} px`);
  if (tokens.spacing?.length) traits.push(`Spacing: ${tokens.spacing.slice(0, 10).join(', ')} px`);
  if (tokens.shadows !== undefined) traits.push(tokens.shadows ? 'Uses shadows' : 'No shadows');
  return {
    summary: `Token file with ${colors.length} colours${fonts.length ? `, fonts ${fonts.join(', ')}` : ''}${tokens.radius?.length ? `, ${tokens.radius.length} radii` : ''}.`,
    palette: colors.slice(0, 24).map((c) => ({ value: normalizeColor(c.value) ?? c.value, role: c.name })),
    fonts,
    traits,
    takeaways: ['Use these values exactly: they are the source of truth for colours, fonts and radii.'],
    tokens,
  };
}

// ---------------------------------------------------------------------------
// Where the references agree, and the agents' prompt section
// ---------------------------------------------------------------------------

/** Shared colours and fonts, and where references disagree. Pure — tested directly. */
export function summarizeReferences(references: DesignReference[]): DesignReferenceSummary {
  const ready = references.filter((r) => r.status === 'ready' && r.notes);
  const light = ready.filter((r) => r.notes?.theme === 'light').length;
  const dark = ready.filter((r) => r.notes?.theme === 'dark').length;

  // A colour is shared when 2+ references have one within a small distance
  const clusters: Array<{ value: string; refs: Set<string> }> = [];
  for (const ref of ready) {
    for (const c of ref.notes?.palette.slice(0, 8) ?? []) {
      const hex = normalizeColor(c.value);
      if (!hex) continue;
      const near = clusters.find((k) => colorDistance(k.value, hex) < 24);
      if (near) near.refs.add(ref.id);
      else clusters.push({ value: hex, refs: new Set([ref.id]) });
    }
  }
  const sharedColors = clusters.filter((k) => k.refs.size >= 2).sort((a, b) => b.refs.size - a.refs.size).slice(0, 8).map((k) => k.value);

  const fontCount = new Map<string, Set<string>>();
  for (const ref of ready) {
    for (const f of ref.notes?.fonts ?? []) {
      const key = f.trim();
      if (!key) continue;
      fontCount.set(key, (fontCount.get(key) ?? new Set()).add(ref.id));
    }
  }
  const sharedFonts = [...fontCount.entries()].filter(([, ids]) => ids.size >= 2).map(([f]) => f).slice(0, 6);

  const conflicts: DesignReferenceSummary['conflicts'] = [];
  if (light > 0 && dark > 0) conflicts.push({ kind: 'theme', light, dark });
  const asIsFonts = [...new Set(ready.filter((r) => r.role === 'as-is').map((r) => r.notes?.fonts[0]).filter((f): f is string => !!f))];
  if (asIsFonts.length > 1) conflicts.push({ kind: 'fonts', fonts: asIsFonts });

  return { total: references.length, ready: ready.length, light, dark, sharedColors, sharedFonts, conflicts };
}

function notesBlock(ref: DesignReference): string[] {
  const n = ref.notes;
  if (!n) return [];
  const lines = [`### ${ref.name} (${ref.kind}, ${ref.role === 'as-is' ? 'AS-IS: follow it' : 'inspiration: a direction, not a copy'})`];
  lines.push(n.summary);
  if (n.palette.length) {
    lines.push(`Palette: ${n.palette.slice(0, 10).map((c) => `${c.value}${c.role ? ` ${c.role}` : ''}${c.share ? ` ${Math.round(c.share * 100)}%` : ''}`).join(', ')}`);
  }
  if (n.fonts.length) lines.push(`Fonts: ${n.fonts.join(', ')}`);
  if (n.theme) lines.push(`Theme: ${n.theme}`);
  for (const t of n.traits.slice(0, 6)) lines.push(`- ${t}`);
  for (const t of n.takeaways.slice(0, 6)) lines.push(`- Take: ${t}`);
  if (n.tokens && ref.role === 'as-is') lines.push(`Exact tokens: ${JSON.stringify(n.tokens).slice(0, 2000)}`);
  return lines;
}

export interface ReferencesPromptOptions {
  /** design: the design-system agent (may open images); builder / qa: pipeline agents (notes only) */
  audience: 'design' | 'builder' | 'qa';
  projectPath?: string;
}

/** The references part of a prompt (empty without ready references). Pure — tested directly. */
export function referencesPromptSection(references: DesignReference[] | undefined, options: ReferencesPromptOptions): string {
  const ready = (references ?? []).filter((r) => r.status === 'ready' && r.notes);
  if (!ready.length) return '';
  const asIs = ready.filter((r) => r.role === 'as-is');
  const inspiration = ready.filter((r) => r.role === 'inspiration');
  const parts: string[] = ['## Design references', ''];
  if (options.audience === 'design') {
    parts.push(
      'The user collected these references. "AS-IS" ones are rules: take their colours, fonts and rules exactly. "Inspiration" ones set a direction: find what they share and build something of your own in that spirit, never a copy of one of them. Where references disagree with each other or with the code, say so in a "## References" section of the design system (what you took from which, and the conflicts you resolved and how).',
    );
  } else {
    parts.push(
      'The design system was built from these references. "AS-IS" ones are binding (a brand book, exact tokens); use "inspiration" ones only to understand the intended look.',
    );
  }
  const summary = summarizeReferences(ready);
  if (summary.sharedColors.length || summary.sharedFonts.length) {
    parts.push('');
    parts.push(`Shared across references: ${[...summary.sharedColors, ...summary.sharedFonts].join(', ')}.`);
  }
  for (const c of summary.conflicts) {
    parts.push(c.kind === 'theme' ? `Conflict: ${c.light} references are light, ${c.dark} are dark.` : `Conflict: as-is references set different fonts: ${c.fonts.join(', ')}.`);
  }
  for (const ref of [...asIs, ...inspiration]) {
    parts.push('');
    parts.push(...notesBlock(ref));
  }
  if (options.audience === 'design' && options.projectPath) {
    const images = [...asIs, ...inspiration.slice(0, INSPIRATION_IMAGES_OPENED)]
      .map((r) => r.preview)
      .filter((p): p is string => !!p && existsIn(options.projectPath as string, p))
      .map((p) => path.join(options.projectPath as string, p));
    if (images.length) {
      parts.push('');
      parts.push('Open these with Read to see them (the others you know from their notes):');
      for (const img of images) parts.push(`- ${img}`);
    }
  }
  return parts.join('\n');
}
