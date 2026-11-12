import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  lastBranchPush,
  onSubtasksProgress,
  previewPushAllowed,
  pushTaskBranch,
  setBranchPushDeps,
  type BranchPushDeps,
} from '../branch-push';
import { GitHubWriteError } from '../github-write';

const repo = { owner: 'me', repo: 'app', createdByApp: true };
const project = (over: Record<string, unknown> = {}, ...d: unknown[]) =>
  ({ id: 'p1', path: '/proj', settings: { deploy: d.length ? d[0] : { enabled: true, repo }, ...over } }) as never;
const task = (id = 't1', metadata?: Record<string, unknown>) => ({ id, specId: `spec-${id}`, metadata }) as never;

function makeDeps(push: BranchPushDeps['push']) {
  const emit = vi.fn();
  const deps: BranchPushDeps = {
    push,
    head: vi.fn(async (_p: string, b: string) => `sha-of-${b}`) as never,
    emit,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  };
  return { deps, emit };
}
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};

describe('previewPushAllowed', () => {
  it('not-set-up when deploy is off or has no repo', () => {
    expect(previewPushAllowed(project({}, undefined), task())).toEqual({ allowed: false, reason: 'not-set-up' });
    expect(previewPushAllowed(project({}, { enabled: false, repo }), task())).toEqual({ allowed: false, reason: 'not-set-up' });
    expect(previewPushAllowed(project({}, { enabled: true }), task())).toEqual({ allowed: false, reason: 'not-set-up' });
  });
  it('public-repo when the repo is public', () => {
    expect(previewPushAllowed(project({}, { enabled: true, repo: { ...repo, public: true } }), task())).toEqual({
      allowed: false,
      reason: 'public-repo',
    });
  });
  it('push-off when the project or the task turns pushing off', () => {
    expect(previewPushAllowed(project({ pushNewBranches: false }), task())).toEqual({ allowed: false, reason: 'push-off' });
    expect(previewPushAllowed(project(), task('t1', { pushNewBranches: false }))).toEqual({ allowed: false, reason: 'push-off' });
  });
  it('allowed otherwise', () => {
    expect(previewPushAllowed(project(), task())).toEqual({ allowed: true });
  });
});

describe('pushTaskBranch', () => {
  it('pushes branch:branch to the repo and records the sha, then emits', async () => {
    const push = vi.fn(async () => {});
    const { deps, emit } = makeDeps(push);
    const rec = await pushTaskBranch(project(), task('a'), deps);
    expect(push).toHaveBeenCalledWith('/proj', 'https://github.com/me/app.git', 'vibe-teamlead/spec-a:vibe-teamlead/spec-a');
    expect(rec).toEqual({ sha: 'sha-of-vibe-teamlead/spec-a', at: '2026-01-01T00:00:00.000Z' });
    expect(lastBranchPush('a')).toEqual(rec);
    expect(emit).toHaveBeenCalledWith('p1', 'a');
  });

  it('two pushes requested during a running push run exactly one more', async () => {
    const gate = deferred();
    const push = vi.fn(async () => { if (push.mock.calls.length === 1) await gate.promise; });
    const { deps } = makeDeps(push);
    const first = pushTaskBranch(project(), task('b'), deps);
    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    const second = pushTaskBranch(project(), task('b'), deps);
    const third = pushTaskBranch(project(), task('b'), deps);
    gate.resolve();
    await Promise.all([first, second, third]);
    expect(push).toHaveBeenCalledTimes(2);
  });

  it('a refused push records the error kind and emits; the next call pushes again', async () => {
    const push = vi
      .fn()
      .mockRejectedValueOnce(new GitHubWriteError('conflict', 'rejected'))
      .mockResolvedValueOnce(undefined);
    const { deps, emit } = makeDeps(push);
    const rec = await pushTaskBranch(project(), task('c'), deps);
    expect(rec.error).toEqual({ kind: 'conflict' });
    expect(lastBranchPush('c')?.error?.kind).toBe('conflict');
    expect(emit).toHaveBeenCalledTimes(1);
    const rec2 = await pushTaskBranch(project(), task('c'), deps);
    expect(rec2.error).toBeUndefined();
    expect(push).toHaveBeenCalledTimes(2);
  });

  it('an unknown failure records unavailable', async () => {
    const { deps } = makeDeps(vi.fn(async () => { throw new Error('boom'); }));
    expect((await pushTaskBranch(project(), task('d'), deps)).error).toEqual({ kind: 'unavailable' });
  });
});

describe('onSubtasksProgress', () => {
  const push = vi.fn(async () => {});
  beforeEach(() => {
    push.mockClear();
    const { deps } = makeDeps(push);
    setBranchPushDeps(deps, () => ({ project: project(), task: task('e') }));
  });

  it('pushes on the first completed subtask and only when the count grows', async () => {
    onSubtasksProgress('e', 0);
    await new Promise((r) => setTimeout(r, 5));
    expect(push).not.toHaveBeenCalled();
    onSubtasksProgress('e', 1);
    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    onSubtasksProgress('e', 1);
    await new Promise((r) => setTimeout(r, 5));
    expect(push).toHaveBeenCalledTimes(1);
    onSubtasksProgress('e', 2);
    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(2));
  });

  it('does not push when not allowed, and never throws', async () => {
    const { deps } = makeDeps(push);
    setBranchPushDeps(deps, () => ({ project: project({}, undefined), task: task('f') }));
    expect(() => onSubtasksProgress('f', 3)).not.toThrow();
    setBranchPushDeps(deps, () => { throw new Error('x'); });
    expect(() => onSubtasksProgress('g', 3)).not.toThrow();
    await new Promise((r) => setTimeout(r, 5));
    expect(push).not.toHaveBeenCalled();
  });
});
