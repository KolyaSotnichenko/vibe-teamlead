import { describe, expect, it, vi } from 'vitest';

import type { PreviewStatus } from '../../../shared/types/preview';
import { carryLockfile, checkBeforeStart, type CheckBeforeStartDeps } from '../check-before-start';
import { startInputs } from '../start-inputs';

const FILES: Record<string, string> = { 'package.json': '{}', 'apps/api/migrations/0022_a.sql': '' };
const READY: PreviewStatus = { projectId: 'p1', stage: 'ready', url: 'http://localhost:5173', origins: [] };
const INFO = { key: 'k', recipe: { version: 1 as const, kind: 'web' as const }, source: 'proposal' as const, base: 'none' };

function setup(files: Record<string, string>, checked: Record<string, string> | undefined, over: Partial<CheckBeforeStartDeps> = {}) {
  const order: string[] = [];
  const deps: CheckBeforeStartDeps = {
    sync: vi.fn(async () => { order.push('sync'); }),
    files: () => Object.keys(files),
    read: (path) => files[path] ?? null,
    checked,
    describe: vi.fn(async () => INFO),
    check: vi.fn(async () => { order.push('check'); return READY; }),
    remember: vi.fn(),
    ...over,
  };
  return { deps, order };
}

describe('checkBeforeStart', () => {
  it('moves the copy to main, then has the agent check what changed since the last check, and remembers it', async () => {
    const before = startInputs({ files: Object.keys(FILES), read: (p) => FILES[p] ?? null });
    const now: Record<string, string> = { ...FILES, 'apps/api/migrations/0023_b.sql': '' };
    const { deps, order } = setup(now, before);
    expect(await checkBeforeStart(deps)).toBe(READY);
    expect(order).toEqual(['sync', 'check']);
    expect(vi.mocked(deps.check).mock.calls[0][1]).toEqual({ changed: ['apps/api/migrations/0023_b.sql'], first: false });
    expect(vi.mocked(deps.check).mock.calls[0][0].key).toMatch(/^check:[0-9a-f]{16}$/);
    expect(deps.remember).toHaveBeenCalledWith(startInputs({ files: Object.keys(now), read: (p) => now[p] ?? null }));
  });

  it('checks a project never checked before', async () => {
    const { deps } = setup(FILES, undefined);
    await checkBeforeStart(deps);
    expect(vi.mocked(deps.check).mock.calls[0][1]).toMatchObject({ first: true });
  });

  it('starts as before, with no agent, when nothing that decides the start changed', async () => {
    const { deps } = setup(FILES, startInputs({ files: Object.keys(FILES), read: (p) => FILES[p] ?? null }));
    expect(await checkBeforeStart(deps)).toBeNull();
    expect(deps.check).not.toHaveBeenCalled();
  });

  it('remembers nothing when the agent did not run (off, no key, the day\'s bound), so the next start checks', async () => {
    const { deps } = setup(FILES, undefined, { check: vi.fn(async () => null) });
    expect(await checkBeforeStart(deps)).toBeNull();
    expect(deps.remember).not.toHaveBeenCalled();
  });

  it('starts as before when the copy could not be moved to main or described', async () => {
    const failing = setup(FILES, undefined, { sync: vi.fn(async () => { throw new Error('git failed'); }) });
    expect(await checkBeforeStart(failing.deps)).toBeNull();
    const nothing = setup(FILES, undefined, { describe: vi.fn(async () => null) });
    expect(await checkBeforeStart(nothing.deps)).toBeNull();
    expect(failing.deps.check).not.toHaveBeenCalled();
    expect(nothing.deps.check).not.toHaveBeenCalled();
  });
});

describe('carryLockfile', () => {
  it("hands a lockfile change a check's move saw to the next start of that copy, once", async () => {
    const results = [{ path: '/wt', lockfileChanged: true, moved: true }, { path: '/wt', lockfileChanged: false, moved: false }, { path: '/wt', lockfileChanged: false, moved: false }];
    const carry = carryLockfile(vi.fn(async () => results.shift()!));
    await carry.forCheck('/p', 'main', 'git', '/wt');
    expect(await carry.forStart('/p', 'main', 'git', '/wt')).toEqual({ path: '/wt', lockfileChanged: true, moved: false });
    expect(await carry.forStart('/p', 'main', 'git', '/wt')).toMatchObject({ lockfileChanged: false });
  });
});
