import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readDesignPackage } from '../read-package';

const fixtures = path.join(__dirname, 'fixtures');

describe('readDesignPackage', () => {
  it('reads a package wrapped in one top folder', () => {
    const pkg = readDesignPackage(path.join(fixtures, 'mhp-like'));
    expect(pkg.root).toBe('mhp-global');
    expect(pkg.name).toBe('MHP Global — дизайн-система');
    expect(pkg.namespace).toBe('MHP');
    expect(pkg.readme).toBe('mhp-global/README.md');
    expect(pkg.tokenFiles).toEqual({
      dtcg: 'mhp-global/tokens.dtcg.json',
      json: 'mhp-global/tokens.json',
      css: 'mhp-global/tokens.css',
    });
    expect(pkg.components.map((c) => c.name).sort()).toEqual(['Button', 'Card']);
    expect(pkg.components.find((c) => c.name === 'Button')?.readme).toBe(
      'mhp-global/components/Button/README.md',
    );
    expect(pkg.components.find((c) => c.name === 'Card')?.readme).toBeUndefined();
    expect(pkg.componentFiles).toEqual({
      css: 'mhp-global/components/bundle.css',
      types: 'mhp-global/components/index.d.ts',
      script: 'mhp-global/components/bundle.js',
    });
    expect(pkg.logos).toEqual(['mhp-global/logos/a.svg']);
    expect(pkg.fonts).toEqual(['mhp-global/fonts/A.otf']);
    expect(pkg.extraReferences).toEqual(['mhp-global/brand/cover.png']);
    expect(pkg.licenceLine).toContain('комерційні');
  });

  it('reads a flat package with no bundle', () => {
    const pkg = readDesignPackage(path.join(fixtures, 'flat'));
    expect(pkg.root).toBe('');
    expect(pkg.name).toBe('Flat kit');
    expect(pkg.namespace).toBe('ds');
    expect(pkg.components).toEqual([]);
    expect(pkg.tokenFiles).toEqual({ css: 'tokens.css' });
    expect(pkg.logos).toEqual([]);
  });
});
