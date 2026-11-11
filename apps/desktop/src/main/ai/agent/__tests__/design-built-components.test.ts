import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DesignSystemInfo } from '../../../../shared/types';
import { withBuiltComponents } from '../../design/package/package-meta';

let worktree: string;
beforeEach(() => {
  worktree = mkdtempSync(path.join(tmpdir(), 'built-'));
});
afterEach(() => rmSync(worktree, { recursive: true, force: true }));

const shared = (): DesignSystemInfo => ({
  exists: true,
  source: 'app',
  qaMode: 'block',
  storybook: { detected: false, enabled: false },
  package: {
    name: 'MHP', namespace: 'mhp', importedAt: 'x', dir: '.vibe-teamlead/design/package/mhp', componentsDir: 'src/components/mhp',
    components: [{ name: 'Button' }, { name: 'Card' }], logos: [], fonts: [], themes: 'light',
  },
});

describe('withBuiltComponents (the worker\'s per-task built list)', () => {
  it('computes built from the task\'s own folder and returns a copy', () => {
    mkdirSync(path.join(worktree, 'src/components/mhp/Card'), { recursive: true });
    const info = shared();
    const forTask = withBuiltComponents(info, worktree);
    expect(forTask.package?.built).toEqual(['Card']);
    expect(forTask).not.toBe(info);
    expect(forTask.package).not.toBe(info.package);
  });

  it('never changes the shared info', () => {
    mkdirSync(path.join(worktree, 'src/components/mhp/Button'), { recursive: true });
    const info = shared();
    const before = JSON.stringify(info);
    withBuiltComponents(info, worktree);
    expect(JSON.stringify(info)).toBe(before);
    expect(info.package?.built).toBeUndefined();
  });

  it('returns the info as is without a package', () => {
    const info: DesignSystemInfo = { ...shared(), package: undefined };
    expect(withBuiltComponents(info, worktree)).toBe(info);
  });
});
