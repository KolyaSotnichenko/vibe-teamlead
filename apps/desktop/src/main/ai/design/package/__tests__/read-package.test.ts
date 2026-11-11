import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

  it('does not follow symbolic links out of the package', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'dsp-'));
    try {
      const outside = path.join(tmp, 'outside');
      mkdirSync(outside);
      writeFileSync(path.join(outside, 'secret.png'), 'x');
      const pkgDir = path.join(tmp, 'pkg');
      mkdirSync(path.join(pkgDir, 'logos'), { recursive: true });
      writeFileSync(path.join(pkgDir, 'README.md'), '# Kit\n');
      writeFileSync(path.join(pkgDir, 'logos', 'a.svg'), '<svg/>');
      symlinkSync(outside, path.join(pkgDir, 'linked'));
      symlinkSync(path.join(outside, 'secret.png'), path.join(pkgDir, 'logos', 'b.png'));
      const pkg = readDesignPackage(pkgDir);
      expect(pkg.logos).toEqual(['logos/a.svg']);
      expect(pkg.extraReferences).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
