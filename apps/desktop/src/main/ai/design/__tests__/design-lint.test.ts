import { describe, expect, it } from 'vitest';
import type { DesignTokens } from '../../../../shared/types';
import { hexToRgb, isUiFile, lintAddedLines, parseAddedLines } from '../design-lint';

const tokens: DesignTokens = {
  colors: [
    { name: 'ink', value: '#1C1D19' },
    { name: 'ground', value: '#E8EAE3' },
    { name: 'signal', value: '#D6401A' },
  ],
  fonts: [{ role: 'body', family: 'Archivo' }],
  radius: [0],
  shadows: false,
  bannedPatterns: [{ pattern: 'animate-bounce', message: 'No bouncing' }],
};

const lint = (file: string, ...texts: string[]) => lintAddedLines([{ file, lines: texts.map((text, i) => ({ n: i + 1, text })) }], tokens);
const rules = (findings: ReturnType<typeof lint>) => findings.map((f) => `${f.rule}:${f.match}`);

describe('lintAddedLines', () => {
  it('accepts palette colours (any case, short or with alpha) and flags others', () => {
    expect(lint('a.tsx', "const c = '#1c1d19'; const d = '#D6401A80';")).toEqual([]);
    expect(rules(lint('a.tsx', "style={{ color: '#7c3aed' }}"))).toEqual(['off-palette-color:#7c3aed']);
    expect(rules(lint('a.css', 'color: rgb(124, 58, 237);'))).toEqual(['off-palette-color:rgb(124, 58, 237)']);
    expect(lint('a.css', 'color: rgb(28 29 25);', 'color: var(--ink);')).toEqual([]);
  });

  it("flags Tailwind's default palette, gradients, shadows and rounded corners", () => {
    const found = rules(lint('a.tsx', '<div className="bg-purple-600 text-white rounded-xl shadow-lg bg-gradient-to-r from-indigo-500 hover:bg-blue-500/80">'));
    expect(found).toEqual(expect.arrayContaining([
      'off-palette-color:bg-purple-600',
      'off-palette-color:from-indigo-500',
      'off-palette-color:hover:bg-blue-500/80',
      'radius:rounded-xl',
      'shadow:shadow-lg',
      'gradient:bg-gradient-to-r',
    ]));
  });

  it('allows what the system allows: rounded-none, shadow-none, tokens via variables', () => {
    expect(lint('a.tsx', '<div className="rounded-none shadow-none bg-[var(--ink)] text-foreground">')).toEqual([]);
  });

  it('does not take links or ids for colours, skips comments, and applies banned patterns', () => {
    expect(lint('a.tsx', '<a href="#add">Add</a>', '// color #7c3aed')).toEqual([]);
    expect(rules(lint('a.tsx', '<span className="animate-bounce">'))).toEqual(['banned:animate-bounce']);
  });

  it('respects a system that has shadows, radii and gradients', () => {
    const soft = { ...tokens, radius: [4, 8], shadows: true, gradients: true };
    const f = lintAddedLines([{ file: 'a.css', lines: [{ n: 1, text: 'border-radius: 8px; box-shadow: 0 1px 2px #1C1D19; background: linear-gradient(#1C1D19, #E8EAE3);' }, { n: 2, text: 'border-radius: 12px;' }] }], soft);
    expect(rules(f)).toEqual(['radius:border-radius: 12px']);
  });
});

describe('parseAddedLines', () => {
  it('reads added lines with their new line numbers from a -U0 diff', () => {
    const diff = [
      'diff --git a/src/A.tsx b/src/A.tsx',
      '--- a/src/A.tsx',
      '+++ b/src/A.tsx',
      '@@ -3,0 +4,2 @@ export',
      '+  <div className="bg-red-500" />',
      '+  <p>hi</p>',
      '@@ -10 +12 @@',
      '-old',
      '+new',
      'diff --git a/gone.tsx b/gone.tsx',
      '--- a/gone.tsx',
      '+++ /dev/null',
    ].join('\n');
    expect(parseAddedLines(diff)).toEqual([
      { file: 'src/A.tsx', lines: [{ n: 4, text: '  <div className="bg-red-500" />' }, { n: 5, text: '  <p>hi</p>' }, { n: 12, text: 'new' }] },
    ]);
  });

  it('knows UI files', () => {
    expect(isUiFile('apps/web/src/page.tsx')).toBe(true);
    expect(isUiFile('src/styles.css')).toBe(true);
    expect(isUiFile('src/server.ts')).toBe(false);
    expect(isUiFile('node_modules/x/a.tsx')).toBe(false);
    expect(isUiFile('src/a.test.tsx')).toBe(false);
    expect(hexToRgb('#abc')).toEqual([170, 187, 204]);
  });
});

describe('allowed exceptions', () => {
  it('skips findings the design system allows, but never excuses a banned pattern', () => {
    const withExceptions: DesignTokens = {
      ...tokens,
      allowedPatterns: [
        { pattern: 'repeating-linear-gradient\\(', message: 'grid background' },
        { pattern: 'animate-bounce', message: 'tries to excuse a banned one' },
      ],
    };
    const found = lintAddedLines(
      [{ file: 'Grid.tsx', lines: [{ n: 1, text: "style={{ background: 'repeating-linear-gradient(90deg, #1C1D19 0 1px, transparent 1px 8px)' }}" }, { n: 2, text: '<div className="bg-gradient-to-r animate-bounce" />' }] }],
      withExceptions,
    ).map((f) => `${f.rule}:${f.match}`);
    expect(found).not.toContain('gradient:repeating-linear-gradient(');
    // a different gradient on another line is still reported; the banned pattern too
    expect(found).toEqual(expect.arrayContaining(['gradient:bg-gradient-to-r', 'banned:animate-bounce']));
  });
});


describe('tokens summary for prompts', () => {
  it('lists the patterns the design system allows on purpose', async () => {
    const { tokensSummary } = await import('../design-system');
    const s = tokensSummary({ ...tokens, allowedPatterns: [{ pattern: 'repeating-linear-gradient\\(', message: 'Hatched backgrounds' }] });
    expect(s).toContain('Allowed on purpose (the design check skips it): `repeating-linear-gradient\\(` (Hatched backgrounds)');
  });
});
