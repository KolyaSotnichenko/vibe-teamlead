import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The restore of the previous package can fail like any rename: control rename here
const failRename = vi.hoisted(() => ({ when: null as null | ((from: string, to: string) => boolean) }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    rename: async (from: string, to: string) => {
      if (failRename.when?.(String(from), String(to))) throw new Error('rename failed');
      return real.rename(from, to);
    },
  };
});

import type { DesignTokens } from '../../../../../shared/types';
import { importDesignPackage, inspectDesignPackage } from '../import-package';
import { PACKAGE_DIR, PACKAGE_META_FILE, readPackageMeta } from '../package-meta';

const fixtures = path.join(__dirname, 'fixtures');
const PREVIOUS = '.vibe-teamlead/design/package-previous';

let project: string;
beforeEach(() => {
  project = mkdtempSync(path.join(tmpdir(), 'pkg-restore-'));
  failRename.when = null;
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

const deps = (fail = false) => ({
  write: vi.fn(async (o: { tokens?: DesignTokens }) => {
    if (fail) throw new Error('write failed');
    return { markdown: '# From the package', tokens: o.tokens ?? { colors: [{ name: 'ink', value: '#111111' }], fonts: [], radius: [0], shadows: false } };
  }) as never,
  addReferences: vi.fn(async () => []),
});

describe('importDesignPackage when the restore fails too', () => {
  it('keeps the previous package backup, and the next import brings it back first', async () => {
    await inspectDesignPackage(project, undefined, path.join(fixtures, 'mhp-like'));
    await importDesignPackage(project, undefined, { themes: 'light' }, deps());
    const metaBefore = readFileSync(path.join(project, PACKAGE_META_FILE), 'utf-8');

    await inspectDesignPackage(project, undefined, path.join(fixtures, 'flat'));
    // Moving the backup back into package/ fails
    failRename.when = (from) => from.endsWith('package-previous');
    await expect(importDesignPackage(project, undefined, { themes: 'light' }, deps(true))).rejects.toThrow('write failed');
    expect(existsSync(path.join(project, PREVIOUS, 'mhp-global', 'README.md'))).toBe(true);
    expect(existsSync(path.join(project, '.vibe-teamlead/design/package-meta.previous.json'))).toBe(true);

    // The next attempt puts the backup back before anything else, so a second failure loses nothing
    failRename.when = null;
    await expect(importDesignPackage(project, undefined, { themes: 'light' }, deps(true))).rejects.toThrow('write failed');
    expect(existsSync(path.join(project, PACKAGE_DIR, 'mhp-global', 'README.md'))).toBe(true);
    expect(readFileSync(path.join(project, PACKAGE_META_FILE), 'utf-8')).toBe(metaBefore);
    expect(existsSync(path.join(project, PREVIOUS))).toBe(false);
    expect(readPackageMeta(project)?.dir).toBe(`${PACKAGE_DIR}/mhp-global`);
  });
});
