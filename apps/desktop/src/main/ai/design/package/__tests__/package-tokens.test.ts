import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readDesignPackage } from '../read-package';
import { packageTokens } from '../package-tokens';

const fixtures = path.join(__dirname, 'fixtures');
const dtcg = path.join(fixtures, 'tokens-dtcg');
const css = path.join(fixtures, 'tokens-css');
const none = path.join(fixtures, 'tokens-none');
const mhp = path.join(fixtures, 'mhp-like');

const val = (t: { colors: Array<{ name: string; value: string }> }, name: string) =>
  t.colors.find((c) => c.name === name)?.value.toUpperCase();

describe('packageTokens', () => {
  it('light only drops the dark palette', () => {
    const t = packageTokens(dtcg, readDesignPackage(dtcg), 'light')!;
    expect(t.colors.some((c) => c.name.includes('dark'))).toBe(false);
    expect(t.colors.find((c) => c.name.endsWith('brand'))?.value.toUpperCase()).toBe('#023B59');
    expect(t.colors).toHaveLength(1);
  });

  it('light and dark keeps both, the dark ones marked', () => {
    const t = packageTokens(dtcg, readDesignPackage(dtcg), 'light-dark')!;
    const dark = t.colors.filter((c) => c.name.startsWith('dark/'));
    expect(dark).toHaveLength(1);
    expect(dark[0].value.toUpperCase()).toBe('#4CC3E8');
    expect(t.colors.filter((c) => !c.name.startsWith('dark/'))).toHaveLength(1);
  });

  it('reports shadows and keeps a full radius', () => {
    const t = packageTokens(dtcg, readDesignPackage(dtcg), 'light')!;
    expect(t.shadows).toBe(true);
    expect(t.radius).toContain(9999);
  });

  it('reads dark CSS blocks the same way', () => {
    const pkg = readDesignPackage(css);
    const light = packageTokens(css, pkg, 'light')!;
    expect(light.colors.map((c) => c.name)).toEqual(['bg']);
    expect(val(light, 'bg')).toBe('#FFFFFF');
    expect(light.shadows).toBe(false);
    expect(light.radius).toEqual([4]);
    const both = packageTokens(css, pkg, 'light-dark')!;
    expect(val(both, 'bg')).toBe('#FFFFFF');
    expect(val(both, 'dark/bg')).toBe('#000000');
    expect(val(both, 'dark/fg')).toBe('#EEEEEE');
  });

  it('falls through a json file without colours to the css', () => {
    const t = packageTokens(mhp, readDesignPackage(mhp), 'light')!;
    expect(t.colors.length).toBeGreaterThan(0);
  });

  it('a package without token files has no tokens', () => {
    expect(packageTokens(none, readDesignPackage(none), 'light')).toBeUndefined();
  });
});
