import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DesignReference } from '../../../../shared/types';
import { designPromptSection, loadDesignSystem } from '../design-system';
import {
  normalizeColor,
  notesFromTokens,
  paletteFromPixels,
  parseTokenFile,
  readReferences,
  referenceKindOf,
  referencesPromptSection,
  summarizeReferences,
  themeOf,
  writeReferences,
} from '../references';

/** RGBA pixels: `share` of the image in each colour, top to bottom */
function pixels(parts: Array<[number, number, number, number]>, total = 10_000): Uint8Array {
  const out = new Uint8Array(total * 4);
  let i = 0;
  for (const [r, g, b, share] of parts) {
    const n = Math.round(total * share);
    for (let k = 0; k < n && i < total; k++, i++) out.set([r, g, b, 255], i * 4);
  }
  return out;
}

const ref = (over: Partial<DesignReference>): DesignReference => ({
  id: over.id ?? 'r',
  kind: 'image',
  name: over.name ?? 'ref.png',
  source: 'ref.png',
  role: 'inspiration',
  addedAt: '2026-11-04T10:00:00Z',
  status: 'ready',
  notes: { summary: 'A screen.', palette: [], fonts: [], traits: [], takeaways: [] },
  ...over,
});

describe('measured palette', () => {
  it('finds the main colours with their share, largest first, and the theme', () => {
    const palette = paletteFromPixels(pixels([[16, 17, 20, 0.7], [247, 248, 248, 0.25], [94, 106, 210, 0.05]]), 100, 100);
    expect(palette.map((c) => c.value)).toEqual(['#101114', '#F7F8F8', '#5E6AD2']);
    expect(palette[0].share).toBeCloseTo(0.7, 1);
    expect(themeOf(palette)).toBe('dark');
  });

  it('reads BGRA (Electron bitmaps) and merges near-identical shades', () => {
    // BGRA order: blue first
    const bgra = pixels([[20, 64, 214, 0.5], [233, 234, 232, 0.25], [232, 235, 230, 0.25]]);
    const palette = paletteFromPixels(bgra, 100, 100, { bgra: true });
    expect(palette[0].value).toBe('#D64014');
    expect(palette).toHaveLength(2);
    expect(themeOf([{ value: '#E8EAE3' }])).toBe('light');
  });
});

describe('token files', () => {
  it('reads W3C / Tokens Studio JSON', () => {
    const json = JSON.stringify({
      color: { ink: { $value: '#1c1d19', $type: 'color' }, signal: { value: '#D6401A', type: 'color' } },
      font: { body: { $value: ['Archivo', 'sans-serif'], $type: 'fontFamily' } },
      radius: { none: { $value: '0px', $type: 'dimension' }, md: { $value: '0.5rem', $type: 'dimension' } },
    });
    const tokens = parseTokenFile('tokens.json', json);
    expect(tokens?.colors).toEqual([{ name: 'color.ink', value: '#1C1D19' }, { name: 'color.signal', value: '#D6401A' }]);
    expect(tokens?.fonts).toEqual([{ role: 'body', family: 'Archivo' }]);
    expect(tokens?.radius).toEqual([0, 8]);
  });

  it('reads CSS custom properties and a Tailwind config', () => {
    const css = ':root { --ink: #1C1D19; --ground: rgb(232, 234, 227); --font-sans: "Inter Tight", sans-serif; --radius: 4px; }';
    expect(parseTokenFile('globals.css', css)).toMatchObject({
      colors: [{ name: 'ink', value: '#1C1D19' }, { name: 'ground', value: '#E8EAE3' }],
      fonts: [{ role: 'sans', family: 'Inter Tight' }],
      radius: [4],
    });
    const tw = "module.exports = { theme: { extend: { colors: { brand: '#ff5500' }, fontFamily: { display: ['Archivo', 'sans-serif'] }, borderRadius: { card: '12px' } } } }";
    expect(parseTokenFile('tailwind.config.js', tw)).toMatchObject({ colors: [{ name: 'brand', value: '#FF5500' }], fonts: [{ role: 'display', family: 'Archivo' }], radius: [12] });
    expect(parseTokenFile('empty.css', 'body { margin: 0 }')).toBeUndefined();
  });

  it('turns tokens into notes without a model', () => {
    const notes = notesFromTokens({ colors: [{ name: 'ink', value: '#1C1D19' }], fonts: [{ role: 'body', family: 'Archivo' }], radius: [0] });
    expect(notes.palette).toEqual([{ value: '#1C1D19', role: 'ink' }]);
    expect(notes.fonts).toEqual(['Archivo']);
    expect(notes.tokens?.radius).toEqual([0]);
  });

  it('knows file kinds and normalises colours', () => {
    expect(referenceKindOf('Mood.JPG')).toBe('image');
    expect(referenceKindOf('brand.pdf')).toBe('pdf');
    expect(referenceKindOf('tailwind.config.ts')).toBe('tokens');
    expect(referenceKindOf('notes.docx')).toBeUndefined();
    expect(normalizeColor('#abc')).toBe('#AABBCC');
    expect(normalizeColor('rgba(1, 2, 3, 0.5)')).toBe('#010203');
    expect(normalizeColor('red')).toBeUndefined();
  });
});

describe('summary and prompts', () => {
  it('finds shared colours and fonts, and light/dark and font conflicts', () => {
    const s = summarizeReferences([
      ref({ id: 'a', role: 'as-is', notes: { summary: '', palette: [{ value: '#1C1D19' }], fonts: ['Archivo'], theme: 'light', traits: [], takeaways: [] } }),
      ref({ id: 'b', role: 'as-is', notes: { summary: '', palette: [{ value: '#1D1E1A' }], fonts: ['Inter'], theme: 'dark', traits: [], takeaways: [] } }),
      ref({ id: 'c', notes: { summary: '', palette: [{ value: '#FF0000' }], fonts: ['Archivo'], theme: 'light', traits: [], takeaways: [] } }),
      ref({ id: 'd', status: 'pending', notes: undefined }),
    ]);
    expect(s).toMatchObject({ total: 4, ready: 3, light: 2, dark: 1, sharedColors: ['#1C1D19'], sharedFonts: ['Archivo'] });
    expect(s.conflicts).toEqual([{ kind: 'theme', light: 2, dark: 1 }, { kind: 'fonts', fonts: ['Archivo', 'Inter'] }]);
  });

  it('gives the design agent the notes, as-is first, and the images to open; pipeline agents get notes only', () => {
    const project = mkdtempSync(path.join(tmpdir(), 'vtl-refs-'));
    mkdirSync(path.join(project, '.vibe-teamlead/design/references'), { recursive: true });
    writeFileSync(path.join(project, '.vibe-teamlead/design/references/a.preview.png'), 'png');
    const refs = [
      ref({ id: 'i', name: 'moodboard.png', notes: { summary: 'Calm lab look.', palette: [{ value: '#E8EAE3', share: 0.6 }], fonts: [], traits: ['Hairlines'], takeaways: ['Mono numbers'] } }),
      ref({ id: 'a', name: 'Brand book.pdf', kind: 'pdf', role: 'as-is', preview: '.vibe-teamlead/design/references/a.preview.png', notes: { summary: 'Brand rules.', palette: [{ value: '#D6401A', role: 'signal' }], fonts: ['Archivo'], traits: [], takeaways: ['Signal only for attention'] } }),
      ref({ id: 'p', name: 'later.png', status: 'digesting', notes: undefined }),
    ];
    const design = referencesPromptSection(refs, { audience: 'design', projectPath: project });
    expect(design.indexOf('Brand book.pdf')).toBeLessThan(design.indexOf('moodboard.png'));
    expect(design).toContain('AS-IS: follow it');
    expect(design).toContain('#D6401A signal');
    expect(design).toContain(path.join(project, '.vibe-teamlead/design/references/a.preview.png'));
    expect(design).not.toContain('later.png');
    const builder = referencesPromptSection(refs, { audience: 'builder' });
    expect(builder).toContain('Brand rules.');
    expect(builder).not.toContain('Open these with Read');
    expect(referencesPromptSection([], { audience: 'qa' })).toBe('');
  });

  it("puts the project's references into the pipeline agents' design section", () => {
    const project = mkdtempSync(path.join(tmpdir(), 'vtl-refs-'));
    writeReferences(project, [ref({ id: 'a', name: 'Brand book.pdf', role: 'as-is', notes: { summary: 'Brand rules.', palette: [], fonts: [], traits: [], takeaways: [] } })]);
    expect(readReferences(project)).toHaveLength(1);
    const info = loadDesignSystem(project, undefined);
    expect(info.references?.map((r) => r.name)).toEqual(['Brand book.pdf']);
    expect(designPromptSection(info, { role: 'builder', storybookEnabled: false })).toContain('## Design references');
  });
});
