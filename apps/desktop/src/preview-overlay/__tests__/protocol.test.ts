import { describe, expect, it } from 'vitest';

import { cleanPick, relativeSourceFile } from '../protocol';

describe('cleanPick: what the page sends is data from code agents wrote', () => {
  const pick = {
    kind: 'element',
    rect: { x: 10, y: 20, width: 300, height: 40 },
    selector: 'main > h1',
    text: 'Roadmaply',
    html: '<h1 class="text-4xl">Roadmaply</h1>',
    component: 'Home',
    frames: [{ file: 'apps/web/src/app/page.tsx', line: 7, name: 'Home' }],
  };

  it('keeps a well-formed pick', () => {
    expect(cleanPick(pick)).toEqual(pick);
  });

  it('caps the sizes the spec sets, and drops what is not data', () => {
    const big = cleanPick({
      ...pick,
      text: 'x'.repeat(5000),
      html: 'y'.repeat(9000),
      frames: Array.from({ length: 9 }, (_, i) => ({ file: `f${i}.tsx`, line: i, extra: 'nope' })),
      elements: Array.from({ length: 9 }, (_, i) => ({ selector: `#e${i}`, text: 'z'.repeat(900) })),
      evil: () => 1,
    })!;
    expect(big.text).toHaveLength(200);
    expect(big.html).toHaveLength(1500);
    expect(big.frames).toHaveLength(3);
    expect(big.frames[0]).toEqual({ file: 'f0.tsx', line: 0 });
    expect(big.elements).toHaveLength(5);
    expect(big.elements![0].text).toHaveLength(200);
    expect(big).not.toHaveProperty('evil');
  });

  it('refuses what is not a pick', () => {
    expect(cleanPick(null)).toBeNull();
    expect(cleanPick({ ...pick, kind: 'script' })).toBeNull();
    expect(cleanPick({ ...pick, rect: { x: 'a' } })).toBeNull();
    expect(cleanPick({ ...pick, rect: { x: 0, y: 0, width: -5, height: 10 } })).toBeNull();
  });
});

describe('relativeSourceFile', () => {
  const wt = '/Users/me/.vibe-teamlead/worktrees/preview/p1';
  it('makes dev-server paths relative to the worktree', () => {
    expect(relativeSourceFile(`${wt}/apps/web/src/app/page.tsx`, wt)).toBe('apps/web/src/app/page.tsx');
    expect(relativeSourceFile(`file://${wt}/apps/web/src/Login.tsx`, wt)).toBe('apps/web/src/Login.tsx');
    expect(relativeSourceFile('webpack-internal:///(app-pages-browser)/./src/components/Nav.tsx', wt)).toBe('src/components/Nav.tsx');
    expect(relativeSourceFile('/src/App.vue?t=123', wt)).toBe('src/App.vue');
    expect(relativeSourceFile('apps/web/src/x.tsx', wt)).toBe('apps/web/src/x.tsx');
  });

  it('drops paths outside the project and bundler internals', () => {
    expect(relativeSourceFile('/Users/me/other/secret.ts', wt)).toBeNull();
    expect(relativeSourceFile(`${wt}/node_modules/next/dist/client.js`, wt)).toBeNull();
    expect(relativeSourceFile('../../etc/passwd', wt)).toBeNull();
    expect(relativeSourceFile('', wt)).toBeNull();
  });
});
