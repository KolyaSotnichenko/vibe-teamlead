import { describe, it, expect, vi } from 'vitest';
import type { Project } from '../../../shared/types';
import { previewPushAllowed, worktreePushNewBranches } from '../branch-push';
import { lastPushResult, pushMainAfterMerge, type PushAfterMergeDeps, type DeployPushResult } from '../push-after-merge';

const project = (deploy?: unknown, mainBranch: string | null = 'main') =>
  ({ id: 'p1', path: '/proj', settings: { mainBranch, deploy } }) as never;
const enabled = { enabled: true, repo: { owner: 'me', repo: 'app', createdByApp: true } };

function deps(push: PushAfterMergeDeps['push']) {
  const emitted: DeployPushResult[] = [];
  return { d: { push, emit: (r: DeployPushResult) => void emitted.push(r), now: () => '2026-01-01T00:00:00.000Z' } as PushAfterMergeDeps, emitted };
}

describe('pushMainAfterMerge', () => {
  it('does nothing when CI is not set up (no repository recorded)', async () => {
    const push = vi.fn(async () => {});
    const { d, emitted } = deps(push);
    expect(await pushMainAfterMerge(project(undefined), d, 'main')).toEqual({ pushed: false });
    expect(await pushMainAfterMerge(project({ enabled: false }), d, 'main')).toEqual({ pushed: false });
    expect(await pushMainAfterMerge(project({ enabled: true }), d, 'main')).toEqual({ pushed: false });
    expect(push).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
  });

  it('pushes main when only the repository step is recorded (no Vercel step, enabled not yet set)', async () => {
    const push = vi.fn(async () => {});
    const { d } = deps(push);
    expect(await pushMainAfterMerge({ id: 'p-repo', path: '/proj', settings: { mainBranch: 'main', deploy: { repo: enabled.repo } } } as never, d, 'main')).toEqual({ pushed: true });
    expect(push).toHaveBeenCalledWith('/proj', 'https://github.com/me/app.git', 'main');
  });

  it('owner decision 2026-11-12: main IS pushed to the project\'s own public repository; task branches never are', async () => {
    const push = vi.fn(async () => {});
    const { d } = deps(push);
    const publicRepo = { enabled: true, repo: { owner: 'me', repo: 'app', createdByApp: true, public: true } };
    expect(await pushMainAfterMerge(project(publicRepo), d, 'main')).toEqual({ pushed: true });
    expect(push).toHaveBeenCalledWith('/proj', 'https://github.com/me/app.git', 'main');
    const p = project(publicRepo) as Project;
    expect(previewPushAllowed(p, { metadata: {} } as never)).toEqual({ allowed: false, reason: 'public-repo' });
    expect(worktreePushNewBranches(p.settings, true)).toBe(false);
  });

  it('pushes the main branch once and emits ok', async () => {
    const push = vi.fn(async () => {});
    const { d, emitted } = deps(push);
    expect(await pushMainAfterMerge(project(enabled, 'trunk'), d, 'trunk')).toEqual({ pushed: true });
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith('/proj', 'https://github.com/me/app.git', 'trunk');
    expect(emitted).toEqual([{ projectId: 'p1', ok: true, at: '2026-01-01T00:00:00.000Z' }]);
  });

  it('reports the commit it pushed when headSha is given', async () => {
    const push = vi.fn(async () => {});
    const { d } = deps(push);
    d.headSha = async (_p, branch) => `sha-of-${branch}`;
    expect(await pushMainAfterMerge(project(enabled, 'trunk'), d, 'trunk')).toEqual({ pushed: true, sha: 'sha-of-trunk' });
  });

  it('a merge into a non-main branch does not push', async () => {
    const push = vi.fn(async () => {});
    const { d, emitted } = deps(push);
    expect(await pushMainAfterMerge(project(enabled, 'main'), d, 'develop')).toEqual({ pushed: false });
    d.branches = async () => ['main', 'develop'];
    expect(await pushMainAfterMerge(project(enabled, null), d, 'develop')).toEqual({ pushed: false });
    expect(push).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
  });

  it('without a configured main, uses the repo default (master here)', async () => {
    const push = vi.fn(async () => {});
    const { d } = deps(push);
    d.branches = async () => ['master', 'develop'];
    await pushMainAfterMerge(project(enabled, null), d, 'master');
    expect(push).toHaveBeenCalledWith('/proj', 'https://github.com/me/app.git', 'master');
  });

  it('coalesces three merges during a slow push into exactly two pushes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const push = vi.fn(async () => { if (push.mock.calls.length === 1) await gate; });
    const { d, emitted } = deps(push);
    const a = pushMainAfterMerge(project(enabled), d, 'main');
    await Promise.resolve();
    const b = pushMainAfterMerge(project(enabled), d, 'main');
    const c = pushMainAfterMerge(project(enabled), d, 'main');
    expect(push).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([a, b, c]);
    expect(push).toHaveBeenCalledTimes(2);
    expect(emitted).toHaveLength(2);
  });

  it('emits the error and does not throw on rejection', async () => {
    const err = Object.assign(new Error('nope'), { kind: 'auth' });
    const { d, emitted } = deps(vi.fn(async () => { throw err; }));
    const r = await pushMainAfterMerge(project(enabled), d, 'main');
    expect(r).toEqual({ pushed: false, error: 'nope' });
    expect(emitted).toEqual([{ projectId: 'p1', ok: false, error: { kind: 'auth', message: 'nope' }, at: '2026-01-01T00:00:00.000Z' }]);
  });

  it('a throwing emitter does not break the push', async () => {
    const d = { push: vi.fn(async () => {}), emit: () => { throw new Error('x'); } } as PushAfterMergeDeps;
    expect(await pushMainAfterMerge(project(enabled), d, 'main')).toEqual({ pushed: true });
  });

  it('keeps the last result per project for the Deploy view to show after a reload', async () => {
    const err = Object.assign(new Error('nope'), { kind: 'permissions' });
    const { d } = deps(vi.fn(async () => { throw err; }));
    await pushMainAfterMerge({ id: 'p-last', path: '/proj', settings: { mainBranch: 'main', deploy: enabled } } as never, d, 'main');
    expect(lastPushResult('p-last')).toEqual({ projectId: 'p-last', ok: false, error: { kind: 'permissions', message: 'nope' }, at: '2026-01-01T00:00:00.000Z' });
    expect(lastPushResult('other')).toBeUndefined();
  });
});
