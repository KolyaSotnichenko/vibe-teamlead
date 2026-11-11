import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DesignPackageInfo, DesignTokens } from '../../../../../shared/types';
import { readSystemMeta } from '../../system-meta';
import {
  cancelDesignPackage,
  importDesignPackage,
  inspectDesignPackage,
  setDesignThemes,
} from '../import-package';
import { PACKAGE_DIR, readPackageMeta } from '../package-meta';

const fixtures = path.join(__dirname, 'fixtures');
const mhp = path.join(fixtures, 'mhp-like');
const flat = path.join(fixtures, 'flat');
const STAGING = '.vibe-teamlead/design/package-staging';

const FALLBACK: DesignTokens = { colors: [{ name: 'ink', value: '#111111' }], fonts: [], radius: [0], shadows: false };

let project: string;
beforeEach(() => {
  project = mkdtempSync(path.join(tmpdir(), 'pkg-import-'));
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

function fakeDeps() {
  const write = vi.fn(async (o: { tokens?: DesignTokens }) => ({ markdown: '# From the package', tokens: o.tokens ?? FALLBACK }));
  const addReferences = vi.fn(async (_files: string[]) => undefined);
  return { write: write as never, addReferences, calls: write };
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const name of readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${name.name}` : name.name;
      if (name.isDirectory()) walk(path.join(d, name.name), r);
      else out.push(r);
    }
  };
  walk(dir, '');
  return out;
}

const tokensFile = () => JSON.parse(readFileSync(path.join(project, '.vibe-teamlead/design-tokens.json'), 'utf-8')) as DesignTokens;

describe('inspectDesignPackage', () => {
  it('unpacks into staging and summarises the package', async () => {
    const s = await inspectDesignPackage(project, undefined, mhp);
    expect(existsSync(path.join(project, STAGING, 'mhp-global', 'README.md'))).toBe(true);
    expect(s.name).toBe('MHP Global — дизайн-система');
    expect(s.components).toContain('Button');
    expect(s.colors.dark).toBeGreaterThan(0);
    expect(s.colors.light).toBeGreaterThan(0);
    expect(s.hasTokens).toBe(true);
    expect(s.logos).toBe(1);
    expect(s.fonts).toBe(1);
    expect(s.licenceLine).toMatch(/ліценз/);
    expect(s.replaces).toBeUndefined();
    expect(Array.isArray(s.skipped)).toBe(true);
  });

  it('names the system it would replace', async () => {
    mkdirSync(path.join(project, '.vibe-teamlead'), { recursive: true });
    writeFileSync(path.join(project, '.vibe-teamlead/design-system.md'), '# Old\n');
    const s = await inspectDesignPackage(project, undefined, mhp);
    expect(s.replaces).toBe('.vibe-teamlead/design-system.md');
  });

  it('starts from a clean staging folder', async () => {
    mkdirSync(path.join(project, STAGING), { recursive: true });
    writeFileSync(path.join(project, STAGING, 'leftover.md'), 'x');
    await inspectDesignPackage(project, undefined, flat);
    expect(existsSync(path.join(project, STAGING, 'leftover.md'))).toBe(false);
  });
});

describe('importDesignPackage', () => {
  it('fails clearly without a staged package', async () => {
    const deps = fakeDeps();
    await expect(importDesignPackage(project, undefined, { themes: 'light' }, deps)).rejects.toThrow(/choose the package again/i);
    expect(deps.calls).not.toHaveBeenCalled();
  });

  it('writes the system, light tokens, the package meta and references; removes staging', async () => {
    await inspectDesignPackage(project, undefined, mhp);
    const deps = fakeDeps();
    await importDesignPackage(project, undefined, { themes: 'light' }, deps);

    expect(readFileSync(path.join(project, '.vibe-teamlead/design-system.md'), 'utf-8')).toBe('# From the package\n');
    const tokens = tokensFile();
    expect(tokens.colors.length).toBeGreaterThan(0);
    expect(tokens.colors.some((c) => c.name.startsWith('dark/'))).toBe(false);
    expect(existsSync(path.join(project, STAGING))).toBe(false);
    expect(existsSync(path.join(project, PACKAGE_DIR, 'mhp-global', 'README.md'))).toBe(true);

    const meta = readPackageMeta(project) as DesignPackageInfo;
    expect(meta).toBeDefined();
    expect(meta.dir).toBe(`${PACKAGE_DIR}/mhp-global`);
    expect(meta.components.map((c) => c.name)).toContain('Button');
    expect(meta.components.find((c) => c.name === 'Button')?.readme).toBe(`${PACKAGE_DIR}/mhp-global/components/Button/README.md`);
    expect(meta.componentCss).toBe(`${PACKAGE_DIR}/mhp-global/components/bundle.css`);
    expect(meta.tokensCss).toBe(`${PACKAGE_DIR}/mhp-global/tokens.css`);
    expect(meta.logos).toEqual([`${PACKAGE_DIR}/mhp-global/logos/a.svg`]);
    expect(meta.fonts).toEqual([`${PACKAGE_DIR}/mhp-global/fonts/A.otf`]);
    expect(meta.componentsDir).toBe('src/components/mhp');
    expect(meta.themes).toBe('light');
    expect(meta.licenceLine).toMatch(/ліценз/);

    expect(readSystemMeta(project)).toMatchObject({ how: 'package', packageName: 'MHP Global — дизайн-система' });

    const passed = deps.calls.mock.calls[0][0] as unknown as { pkgDir: string; projectPath: string; tokens?: DesignTokens };
    expect(passed.pkgDir).toBe(path.join(project, PACKAGE_DIR));
    expect(passed.projectPath).toBe(project);
    expect(passed.tokens).toBeDefined();
    expect(deps.addReferences).toHaveBeenCalledWith([path.join(project, PACKAGE_DIR, 'mhp-global', 'brand', 'cover.png')]);
  });

  it('a second import leaves nothing of the first in package/', async () => {
    await inspectDesignPackage(project, undefined, mhp);
    await importDesignPackage(project, undefined, { themes: 'light' }, fakeDeps());
    await inspectDesignPackage(project, undefined, flat);
    await importDesignPackage(project, undefined, { themes: 'light' }, fakeDeps());
    expect(filesUnder(path.join(project, PACKAGE_DIR)).sort()).toEqual(['README.md', 'tokens.css']);
    expect(readPackageMeta(project)?.dir).toBe(PACKAGE_DIR);
  });

  it('a package without tokens passes no tokens to the agent and saves what it returns', async () => {
    await inspectDesignPackage(project, undefined, flat);
    const deps = fakeDeps();
    await importDesignPackage(project, undefined, { themes: 'light' }, deps);
    const passed = deps.calls.mock.calls[0][0] as unknown as { tokens?: DesignTokens };
    expect(passed.tokens).toBeUndefined();
    expect(tokensFile().colors).toEqual(FALLBACK.colors);
    expect(deps.addReferences).not.toHaveBeenCalled();
  });
});

describe('setDesignThemes', () => {
  it('adds the dark colours without an agent', async () => {
    await inspectDesignPackage(project, undefined, mhp);
    const deps = fakeDeps();
    await importDesignPackage(project, undefined, { themes: 'light' }, deps);
    deps.calls.mockClear();

    setDesignThemes(project, undefined, 'light-dark');
    expect(tokensFile().colors.some((c) => c.name.startsWith('dark/'))).toBe(true);
    expect(readPackageMeta(project)?.themes).toBe('light-dark');
    expect(deps.calls).not.toHaveBeenCalled();

    setDesignThemes(project, undefined, 'light');
    expect(tokensFile().colors.some((c) => c.name.startsWith('dark/'))).toBe(false);
  });

  it('fails without an imported package', () => {
    expect(() => setDesignThemes(project, undefined, 'light-dark')).toThrow(/no design package/i);
  });
});

describe('cancelDesignPackage', () => {
  it('removes staging', async () => {
    await inspectDesignPackage(project, undefined, flat);
    cancelDesignPackage(project);
    expect(existsSync(path.join(project, STAGING))).toBe(false);
  });
});
