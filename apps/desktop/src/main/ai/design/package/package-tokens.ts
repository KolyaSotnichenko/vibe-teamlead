/**
 * Exact design tokens from a design-system package, by theme. Pure file
 * reading and text parsing: nothing from the package is executed.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { DesignThemes, DesignTokens } from '../../../../shared/types/design-system';
import { parseTokenFile } from '../references';
import type { DesignPackage } from './read-package';

type Parsed = Partial<DesignTokens>;
type Colour = { name: string; value: string };

const DARK_PREFIX = 'dark/';
const DARK_SELECTOR = /\[data-theme\s*=\s*["']?dark["']?\]|\.dark(?![\w-])/i;
const DARK_MEDIA = /prefers-color-scheme\s*:\s*dark/i;

interface CssSegment {
  dark: boolean;
  body: string;
}

/** Splits CSS into declaration blocks, each marked dark or not (nested at-rules are followed). */
function cssSegments(text: string, inDark = false, out: CssSegment[] = []): CssSegment[] {
  const css = text.replace(/\/\*[\s\S]*?\*\//g, '');
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    const prelude = css.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
      j++;
    }
    const body = css.slice(open + 1, depth === 0 ? j - 1 : j);
    if (prelude.startsWith('@')) {
      cssSegments(body, inDark || DARK_MEDIA.test(prelude), out);
    } else {
      out.push({ dark: inDark || DARK_SELECTOR.test(prelude), body });
    }
    i = j;
  }
  return out;
}

function hasShadow(text: string, ext: string): boolean {
  if (ext === '.css') return /--[\w-]*shadow[\w-]*\s*:/i.test(text);
  return /"[^"]*shadow[^"]*"\s*:/i.test(text) || /"\$?type"\s*:\s*"shadow"/i.test(text);
}

function assemble(light: Colour[], dark: Colour[], rest: Parsed[], themes: DesignThemes, shadows: boolean): DesignTokens | undefined {
  const colors = [...light, ...(themes === 'light-dark' ? dark.map((c) => ({ ...c, name: DARK_PREFIX + c.name })) : [])];
  if (!colors.length) return undefined;
  const fonts: DesignTokens['fonts'] = [];
  const radius = new Set<number>();
  const spacing = new Set<number>();
  for (const p of rest) {
    for (const f of p.fonts ?? []) if (!fonts.some((g) => g.family === f.family && g.role === f.role)) fonts.push(f);
    for (const r of p.radius ?? []) radius.add(r);
    for (const s of p.spacing ?? []) spacing.add(s);
  }
  const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);
  return {
    colors,
    fonts,
    radius: sorted(radius),
    shadows,
    ...(spacing.size ? { spacing: sorted(spacing) } : {}),
  };
}

function fromFile(file: string, text: string, themes: DesignThemes): DesignTokens | undefined {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.css') {
    const light: Colour[] = [];
    const dark: Colour[] = [];
    const rest: Parsed[] = [];
    for (const seg of cssSegments(text)) {
      const parsed = parseTokenFile(file, `${seg.body}}`);
      if (!parsed) continue;
      rest.push(parsed);
      (seg.dark ? dark : light).push(...(parsed.colors ?? []));
    }
    return assemble(light, dark, rest, themes, hasShadow(text, ext));
  }
  const parsed = parseTokenFile(file, text);
  if (!parsed?.colors?.length) return undefined;
  const light: Colour[] = [];
  const dark: Colour[] = [];
  for (const c of parsed.colors) {
    const segments = c.name.toLowerCase().split('.');
    if (segments.includes('dark')) {
      const name = c.name.split('.').filter((s) => s.toLowerCase() !== 'dark').join('.');
      dark.push({ ...c, name });
    } else light.push(c);
  }
  const shadows = parsed.shadows === true || hasShadow(text, ext);
  return assemble(light, dark, [parsed], themes, shadows);
}

/** Tokens from the first token file (dtcg, json, css) that yields colours; undefined when none does. */
export function packageTokens(dir: string, pkg: DesignPackage, themes: DesignThemes): DesignTokens | undefined {
  for (const rel of [pkg.tokenFiles.dtcg, pkg.tokenFiles.json, pkg.tokenFiles.css]) {
    if (!rel) continue;
    let text: string;
    try {
      text = readFileSync(path.join(dir, rel), 'utf8');
    } catch {
      continue;
    }
    const tokens = fromFile(rel, text, themes);
    if (tokens) return tokens;
  }
  return undefined;
}
