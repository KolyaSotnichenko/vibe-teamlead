/**
 * Colour themes: every theme is the same palette roles with other values, and
 * meets the contrast the design system asks for (design/DESIGN-SYSTEM.md).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { COLOR_THEMES } from '../../../shared/constants/themes';

const css = readFileSync(join(__dirname, '..', 'globals.css'), 'utf-8');

/** The --vt-* colours a rule sets */
function palette(selector: string): Record<string, string> {
  const start = css.indexOf(`\n${selector} {`);
  if (start === -1) throw new Error(`no rule for ${selector}`);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/--vt-([\w-]+):\s*(#[0-9A-Fa-f]{6});/g)].map((match) => [match[1], match[2].toUpperCase()]));
}

const selectorOf = (id: string) => (id === 'default' ? ':root' : `:root[data-theme='${id}']`);

function luminance(hex: string): number {
  const channel = (at: number) => {
    const value = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** Text on the surface it sits on, and the least contrast it needs (WCAG AA: 4.5 for text, 3 for graphics) */
const PAIRS: [text: string, surface: string, least: number][] = [
  // Light
  ['ink', 'ground', 7],
  ['ink', 'ground-alt', 7],
  ['ink', 'panel', 7],
  ['ink', 'chip-low', 7],
  ['text-secondary', 'ground', 4.5],
  ['text-secondary', 'ground-alt', 4.5],
  ['text-secondary', 'chip-low', 4.5],
  ['text-muted', 'ground', 4.5],
  ['text-muted', 'ground-alt', 4.5],
  ['text-muted', 'panel', 4.5],
  ['text-muted', 'chip-low', 4.5],
  ['signal-text', 'ground', 4.5],
  ['signal-text', 'ground-alt', 4.5],
  ['signal-text', 'panel', 4.5],
  ['paper', 'signal-text', 4.5],
  ['signal', 'ground', 3],
  // Dark and ink surfaces
  ['paper', 'ink', 7],
  ['paper', 'ink-hover', 7],
  ['paper', 'ink-line-soft', 7],
  ['text-muted-dark-soft', 'ink', 4.5],
  ['text-muted-dark-soft', 'ink-hover', 4.5],
  ['text-muted-dark-soft', 'ink-line-soft', 4.5],
  ['text-muted-dark', 'ink', 4.5],
  ['signal-on-dark', 'ink', 4.5],
  ['signal-on-dark', 'ink-line-soft', 4.5],
  ['ink', 'signal-on-dark', 4.5],
];

describe('colour themes', () => {
  const base = palette(':root');

  it('offers the default and at least two more', () => {
    expect(COLOR_THEMES[0].id).toBe('default');
    expect(COLOR_THEMES.length).toBeGreaterThanOrEqual(3);
    expect(new Set(COLOR_THEMES.map((theme) => theme.id)).size).toBe(COLOR_THEMES.length);
  });

  it.each(COLOR_THEMES.map((theme) => theme.id))('%s sets every colour of the palette', (id) => {
    expect(Object.keys(palette(selectorOf(id))).sort()).toEqual(Object.keys(base).sort());
  });

  it.each(COLOR_THEMES.map((theme) => theme.id))('%s keeps the contrast the design system asks for', (id) => {
    const colours = palette(selectorOf(id));
    const tooLow = PAIRS.filter(([text, surface, least]) => contrast(colours[text], colours[surface]) < least).map(
      ([text, surface, least]) => `${text} on ${surface}: ${contrast(colours[text], colours[surface]).toFixed(2)} < ${least}`,
    );
    expect(tooLow).toEqual([]);
  });

  it.each(COLOR_THEMES.map((theme) => theme.id))('%s is shown in the selector with its own colours', (id) => {
    const colours = palette(selectorOf(id));
    const preview = COLOR_THEMES.find((theme) => theme.id === id)?.previewColors;
    expect(preview).toMatchObject({
      bg: colours.ground,
      fg: colours.ink,
      accent: colours.signal,
      darkBg: colours.ink,
      darkFg: colours.paper,
      darkAccent: colours['signal-on-dark'],
    });
  });

  it('keeps the signal warm in every theme: it means "needs attention", never decoration', () => {
    for (const { id } of COLOR_THEMES) {
      const signal = palette(selectorOf(id)).signal;
      const [red, green, blue] = [1, 3, 5].map((at) => Number.parseInt(signal.slice(at, at + 2), 16));
      expect(red).toBeGreaterThan(green * 2);
      expect(red).toBeGreaterThan(blue * 2);
    }
  });

  it('nothing outside the palettes names a colour by its value: a theme would not reach it', () => {
    const outside = css
      .split('\n')
      .filter((line) => /#[0-9A-Fa-f]{6}\b/.test(line) && !/^\s*--vt-[\w-]+:\s*#[0-9A-Fa-f]{6};/.test(line));
    expect(outside).toEqual([]);
  });
});
