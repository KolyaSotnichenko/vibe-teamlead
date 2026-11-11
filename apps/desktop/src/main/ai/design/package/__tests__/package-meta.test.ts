import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DesignPackageInfo } from '../../../../../shared/types';
import { readSystemMeta, recordSystemMeta } from '../../system-meta';
import { PACKAGE_DIR, builtComponents, componentsDirFor, readPackageMeta, writePackageMeta } from '../package-meta';

let project: string;
beforeEach(() => {
  project = mkdtempSync(path.join(tmpdir(), 'pkg-meta-'));
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

describe('componentsDirFor', () => {
  it('uses the first existing components folder, then the namespace', () => {
    mkdirSync(path.join(project, 'src/components'), { recursive: true });
    expect(componentsDirFor(project, 'MHP')).toBe('src/components/mhp');
  });
  it('prefers apps/web/src/components', () => {
    mkdirSync(path.join(project, 'src/components'), { recursive: true });
    mkdirSync(path.join(project, 'apps/web/src/components'), { recursive: true });
    expect(componentsDirFor(project, 'mhp')).toBe('apps/web/src/components/mhp');
  });
  it('falls back to src/components', () => {
    expect(componentsDirFor(project, 'ds')).toBe('src/components/ds');
  });
});

describe('builtComponents', () => {
  it('lists names whose folder exists', () => {
    mkdirSync(path.join(project, 'src/components/mhp/Button'), { recursive: true });
    expect(builtComponents(project, 'src/components/mhp', ['Button', 'Card'])).toEqual(['Button']);
  });
});

describe('package meta', () => {
  it('round-trips', () => {
    const info: DesignPackageInfo = {
      name: 'MHP', namespace: 'mhp', importedAt: '2026-01-01T00:00:00.000Z',
      dir: `${PACKAGE_DIR}/mhp-global`, componentsDir: 'src/components/mhp',
      components: [{ name: 'Button', readme: `${PACKAGE_DIR}/mhp-global/components/Button/README.md` }],
      logos: [], fonts: [], themes: 'light-dark',
    };
    expect(readPackageMeta(project)).toBeUndefined();
    writePackageMeta(project, info);
    expect(readPackageMeta(project)).toEqual(info);
  });
});

describe('system meta', () => {
  it('accepts how: package with packageName', () => {
    recordSystemMeta(project, { how: 'package', packageName: 'MHP' });
    expect(readSystemMeta(project)).toMatchObject({ how: 'package', packageName: 'MHP' });
  });
});
