/**
 * Static design check for the QA loop (no Electron: runs in the worker).
 *
 * Looks only at lines the task added to UI files, so the project's existing
 * code is never blamed, and reports what breaks the design system: colours
 * outside the palette, Tailwind's default palette, radii and shadows the
 * system doesn't have, gradients, and the project's own banned patterns.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { DesignFinding, DesignTokens } from '../../../shared/types';

const UI_FILE = /\.(tsx|jsx|vue|svelte|astro|html|css|scss|sass|less|mdx)$/i;
const SKIP_PATH = /(^|\/)(node_modules|dist|build|out|coverage|\.next|\.vibe-teamlead|\.storybook-static|storybook-static)\//;
const SKIP_FILE = /(design-tokens\.json|design-system\.md|\.test\.|\.spec\.|__tests__\/)/i;
const MAX_FINDINGS = 60;

export interface AddedLines {
  file: string;
  lines: Array<{ n: number; text: string }>;
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

type Rgb = [number, number, number];

export function hexToRgb(hex: string): Rgb | null {
  const h = hex.replace('#', '');
  if (![3, 4, 6, 8].includes(h.length) || /[^0-9a-f]/i.test(h)) return null;
  const full = h.length <= 4 ? h.slice(0, 3).split('').map((c) => c + c).join('') : h.slice(0, 6);
  return [Number.parseInt(full.slice(0, 2), 16), Number.parseInt(full.slice(2, 4), 16), Number.parseInt(full.slice(4, 6), 16)];
}

function fnToRgb(fn: string, args: string): Rgb | null {
  const nums = args.split(/[\s,/]+/).filter(Boolean).map((v) => Number.parseFloat(v));
  if (nums.length < 3 || nums.slice(0, 3).some((v) => Number.isNaN(v))) return null;
  if (fn.startsWith('rgb')) return [nums[0], nums[1], nums[2]].map((v) => Math.round(v)) as Rgb;
  // hsl → rgb
  const [h, s, l] = [nums[0] / 360, nums[1] / 100, nums[2] / 100];
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

const near = (a: Rgb, b: Rgb, tolerance = 8) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= tolerance;

const TAILWIND_HUES = 'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone';
const TAILWIND_PALETTE = new RegExp(
  `(?<![\\w-])(?:[a-z]+:)*(?:bg|text|border(?:-[trblxy])?|from|via|to|ring|fill|stroke|outline|divide|decoration|accent|caret|placeholder|shadow)-(?:${TAILWIND_HUES})-(?:50|[1-9]00|950)(?:\\/\\d+)?(?![\\w-])`,
  'g',
);
const HEX_RE = /(?<![\w&/-])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])/gi;
const FN_RE = /\b(rgba?|hsla?)\(([^)]*)\)/gi;
const GRADIENT_RE = /\b(?:bg-gradient-to-[a-z]+|bg-linear-to-[a-z]+|bg-radial|(?:repeating-)?(?:linear|radial|conic)-gradient\()/g;
const TW_SHADOW_RE = /(?<![\w-])(?:[a-z]+:)*shadow(?:-(?!none\b)(?:2xs|xs|sm|md|lg|xl|2xl|inner|\[[^\]]+\]))?(?![\w-])/g;
const CSS_SHADOW_RE = /\bbox-shadow\s*:\s*(?!none\b)[^;]+/gi;
const TW_ROUNDED_RE = /(?<![\w-])(?:[a-z]+:)*rounded(?:-[trblse]{1,2})?(?:-(?!none\b)(?:xs|sm|md|lg|xl|2xl|3xl|4xl|full|\[[^\]]+\]))?(?![\w-])/g;
const CSS_RADIUS_RE = /\bborder-radius\s*:\s*([^;]+)/gi;

/** Lines that are links or ids, not colours ("#main", "#add") */
const ANCHOR_CONTEXT = /(href|to|id|anchor|hash|url)\s*[=:]\s*["'`][^"'`]*$/i;

/**
 * Findings on the lines a task added. Pure — tested directly.
 * `tokens` decide what is allowed; without colours there is no palette check.
 */
export function lintAddedLines(files: AddedLines[], tokens: DesignTokens): DesignFinding[] {
  const palette = tokens.colors.map((c) => hexToRgb(c.value)).filter((c): c is Rgb => !!c);
  const sharpOnly = tokens.radius.length > 0 && tokens.radius.every((r) => r === 0);
  const banned = (tokens.bannedPatterns ?? []).flatMap((b) => {
    try {
      return [{ re: new RegExp(b.pattern, 'g'), message: b.message }];
    } catch {
      return [];
    }
  });
  const findings: DesignFinding[] = [];
  const seen = new Set<string>();
  const add = (f: DesignFinding) => {
    const key = `${f.file}|${f.rule}|${f.match}`;
    if (seen.has(key) || findings.length >= MAX_FINDINGS) return;
    seen.add(key);
    findings.push(f);
  };
  const inPalette = (rgb: Rgb | null) => !rgb || palette.some((p) => near(p, rgb));

  for (const { file, lines } of files) {
    const isCss = /\.(css|scss|sass|less)$/i.test(file);
    for (const { n, text } of lines) {
      if (!text.trim() || /^\s*(\/\/|\/\*|\*|<!--)/.test(text)) continue;
      if (palette.length) {
        for (const m of text.matchAll(HEX_RE)) {
          if (ANCHOR_CONTEXT.test(text.slice(0, m.index))) continue;
          if (!inPalette(hexToRgb(m[0]))) add({ rule: 'off-palette-color', file, line: n, match: m[0], message: `${m[0]} is not in the design system palette` });
        }
        for (const m of text.matchAll(FN_RE)) {
          if (/var\(/.test(m[2])) continue;
          if (!inPalette(fnToRgb(m[1].toLowerCase(), m[2]))) add({ rule: 'off-palette-color', file, line: n, match: m[0], message: `${m[0]} is not in the design system palette` });
        }
        for (const m of text.matchAll(TAILWIND_PALETTE)) {
          add({ rule: 'off-palette-color', file, line: n, match: m[0], message: `${m[0]} uses Tailwind's default palette, not the design system's colours` });
        }
      }
      if (!tokens.gradients) {
        for (const m of text.matchAll(GRADIENT_RE)) add({ rule: 'gradient', file, line: n, match: m[0], message: 'Gradients are not part of the design system' });
      }
      if (!tokens.shadows) {
        if (!isCss) for (const m of text.matchAll(TW_SHADOW_RE)) if (/className|class=|cn\(|clsx|tw`|["'`]/.test(text)) add({ rule: 'shadow', file, line: n, match: m[0], message: 'The design system has no shadows: use a border for depth' });
        for (const m of text.matchAll(CSS_SHADOW_RE)) add({ rule: 'shadow', file, line: n, match: m[0].trim(), message: 'The design system has no shadows: use a border for depth' });
      }
      if (sharpOnly && !isCss) {
        for (const m of text.matchAll(TW_ROUNDED_RE)) if (/className|class=|cn\(|clsx|["'`]/.test(text)) add({ rule: 'radius', file, line: n, match: m[0], message: 'The design system uses sharp corners (radius 0)' });
      }
      if (tokens.radius.length) {
        for (const m of text.matchAll(CSS_RADIUS_RE)) {
          const values = m[1].match(/[\d.]+px/g)?.map((v) => Number.parseFloat(v)) ?? [];
          if (values.some((v) => !tokens.radius.includes(v))) add({ rule: 'radius', file, line: n, match: m[0].trim(), message: `Allowed radii: ${tokens.radius.join(', ')}px` });
        }
      }
      for (const b of banned) {
        b.re.lastIndex = 0;
        for (const m of text.matchAll(b.re)) add({ rule: 'banned', file, line: n, match: m[0], message: b.message });
      }
    }
  }
  return findings;
}

/** Added lines from a unified diff with zero context (`git diff -U0`). Pure — tested directly. */
export function parseAddedLines(diff: string): AddedLines[] {
  const out = new Map<string, AddedLines>();
  let file: string | null = null;
  let line = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      const target = raw.slice(4).trim();
      file = target === '/dev/null' ? null : target.replace(/^b\//, '');
      continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (!file) continue;
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      const entry = out.get(file) ?? { file, lines: [] };
      entry.lines.push({ n: line, text: raw.slice(1) });
      out.set(file, entry);
      line++;
    } else if (!raw.startsWith('-')) {
      line++;
    }
  }
  return [...out.values()];
}

export const isUiFile = (file: string) => UI_FILE.test(file) && !SKIP_PATH.test(`/${file}`) && !SKIP_FILE.test(file);

function run(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 32 * 1024 * 1024, timeout: 60_000 }, (error, stdout) => resolve(error ? '' : String(stdout)));
  });
}

/** The lines the task added to UI files since `baseRef` (committed, uncommitted and new files). */
export async function addedUiLines(cwd: string, baseRef?: string): Promise<AddedLines[]> {
  const diff = await run(['diff', '-U0', '--no-color', '--diff-filter=ACMR', baseRef ?? 'HEAD', '--'], cwd);
  const files = parseAddedLines(diff).filter((f) => isUiFile(f.file));
  const untracked = (await run(['ls-files', '--others', '--exclude-standard'], cwd)).split('\n').map((f) => f.trim()).filter(Boolean);
  for (const file of untracked.filter(isUiFile)) {
    try {
      const text = await readFile(path.join(cwd, file), 'utf-8');
      if (text.length > 512 * 1024) continue;
      files.push({ file, lines: text.split('\n').map((t, i) => ({ n: i + 1, text: t })) });
    } catch {
      // unreadable — skip
    }
  }
  return files;
}
