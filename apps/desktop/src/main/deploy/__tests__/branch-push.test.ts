import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  lastBranchPush,
  onSubtasksProgress,
  previewPushAllowed,
  pushTaskBranch,
  requestPreviewPush,
  setBranchPushDeps,
  setBranchPushStore,
  worktreePushNewBranches,
  type BranchPushDeps,
} from '../branch-push';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitHubWriteError } from '../github-write';

const repo = { owner: 'me', repo: 'app', createdByApp: true, public: false };
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
  it('not-set-up when no repository is recorded', () => {
    expect(previewPushAllowed(project({}, undefined), task())).toEqual({ allowed: false, reason: 'not-set-up' });
    expect(previewPushAllowed(project({}, { enabled: false }), task())).toEqual({ allowed: false, reason: 'not-set-up' });
    expect(previewPushAllowed(project({}, { enabled: true }), task())).toEqual({ allowed: false, reason: 'not-set-up' });
  });
  it('a recorded private repository is enough (no Vercel step)', () => {
    expect(previewPushAllowed(project({}, { repo }), task())).toEqual({ allowed: true });
    expect(previewPushAllowed(project({}, { enabled: false, repo }), task())).toEqual({ allowed: true });
  });
  it('public-repo when the repo is public', () => {
    expect(previewPushAllowed(project({}, { enabled: true, repo: { ...repo, public: true } }), task())).toEqual({
      allowed: false,
      reason: 'public-repo',
    });
  });
  it('unknown visibility fails closed', () => {
    const { public: _p, ...unknown } = repo;
    expect(previewPushAllowed(project({}, { enabled: true, repo: unknown }), task())).toEqual({
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
    let n = 0;
    deps.head = vi.fn(async () => `b${++n}`) as never; // a commit lands meanwhile
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

  it('a refused push keeps the last successful sha; a later success clears the error', async () => {
    const push = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new GitHubWriteError('conflict', 'rejected'))
      .mockResolvedValueOnce(undefined);
    const { deps } = makeDeps(push);
    let n = 0;
    deps.head = vi.fn(async () => `k${++n}`) as never;
    const ok = await pushTaskBranch(project(), task('k'), deps);
    const bad = await pushTaskBranch(project(), task('k'), deps);
    expect(bad.sha).toBe(ok.sha);
    expect(bad.error).toEqual({ kind: 'conflict' });
    expect((await pushTaskBranch(project(), task('k'), deps)).error).toBeUndefined();
  });

  it('a queued follow-up is re-checked with fresh settings', async () => {
    const gate = deferred();
    const push = vi.fn(async () => { if (push.mock.calls.length === 1) await gate.promise; });
    const { deps } = makeDeps(push);
    const first = pushTaskBranch(project(), task('h'), deps);
    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    const second = pushTaskBranch(project({}, { enabled: true, repo: { ...repo, public: true } }), task('h'), deps);
    gate.resolve();
    await Promise.all([first, second]);
    expect(push).toHaveBeenCalledTimes(1);
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
    let n = 0;
    deps.head = vi.fn(async () => `e${++n}`) as never; // each finished subtask is a new commit
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

  it('a task not allowed at its first completion pushes once allowed, at the same count', async () => {
    const { deps } = makeDeps(push);
    let p = project({}, undefined);
    setBranchPushDeps(deps, () => ({ project: p, task: task('i') }));
    onSubtasksProgress('i', 1);
    await new Promise((r) => setTimeout(r, 5));
    expect(push).not.toHaveBeenCalled();
    p = project();
    onSubtasksProgress('i', 1);
    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1));
  });

  it('a count that drops (plan rewritten) and regrows pushes again', async () => {
    onSubtasksProgress('e', 2);
    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    onSubtasksProgress('e', 0);
    onSubtasksProgress('e', 1);
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

describe('requestPreviewPush (session end, QA fixes, review)', () => {
  it('subtask completed, then commit, then session end: the newest sha is pushed', async () => {
    let head = 'sha-1';
    const push = vi.fn(async () => {});
    const { deps } = makeDeps(push);
    deps.head = vi.fn(async () => head) as never;
    setBranchPushDeps(deps, () => ({ project: project(), task: task('r1') }));
    // The coder marks the subtask completed before it commits
    onSubtasksProgress('r1', 1);
    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(lastBranchPush('r1')?.sha).toBe('sha-1'));
    head = 'sha-2'; // the commit
    requestPreviewPush('r1'); // the coder session ended
    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(lastBranchPush('r1')?.sha).toBe('sha-2'));
  });

  it('a QA fix commit gets pushed', async () => {
    let head = 'sha-a';
    const push = vi.fn(async () => {});
    const { deps } = makeDeps(push);
    deps.head = vi.fn(async () => head) as never;
    setBranchPushDeps(deps, () => ({ project: project(), task: task('r2') }));
    requestPreviewPush('r2');
    await vi.waitFor(() => expect(lastBranchPush('r2')?.sha).toBe('sha-a'));
    head = 'sha-fix';
    requestPreviewPush('r2'); // the QA fixer session ended
    await vi.waitFor(() => expect(lastBranchPush('r2')?.sha).toBe('sha-fix'));
    expect(push).toHaveBeenCalledTimes(2);
  });

  it('skips the push when the branch head is the last pushed sha', async () => {
    const push = vi.fn(async () => {});
    const { deps } = makeDeps(push);
    setBranchPushDeps(deps, () => ({ project: project(), task: task('r3') }));
    await pushTaskBranch(project(), task('r3'), deps);
    expect(push).toHaveBeenCalledTimes(1);
    const again = await pushTaskBranch(project(), task('r3'), deps);
    expect(push).toHaveBeenCalledTimes(1);
    expect(again.sha).toBe('sha-of-vibe-teamlead/spec-r3');
  });

  it('does nothing when not allowed, and never throws', async () => {
    const push = vi.fn(async () => {});
    const { deps } = makeDeps(push);
    setBranchPushDeps(deps, () => ({ project: project({}, undefined), task: task('r4') }));
    expect(() => requestPreviewPush('r4')).not.toThrow();
    setBranchPushDeps(deps, () => { throw new Error('x'); });
    expect(() => requestPreviewPush('r4')).not.toThrow();
    await new Promise((r) => setTimeout(r, 5));
    expect(push).not.toHaveBeenCalled();
  });
});

describe('a successful push whose head read failed', () => {
  it('reads the head again after the push', async () => {
    const push = vi.fn(async () => {});
    const { deps } = makeDeps(push);
    deps.head = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce('sha-late') as never;
    expect((await pushTaskBranch(project(), task('hr'), deps)).sha).toBe('sha-late');
  });
});

describe('persisted push records', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'branch-pushes-'));
  });

  it('a push survives a restart (records are read back from the file)', async () => {
    const file = path.join(dir, 'deploy', 'branch-pushes.json');
    setBranchPushStore(file);
    const { deps } = makeDeps(vi.fn(async () => {}));
    await pushTaskBranch(project(), task('ps'), deps);
    expect(JSON.parse(readFileSync(file, 'utf-8')).ps).toEqual({ sha: 'sha-of-vibe-teamlead/spec-ps', at: '2026-01-01T00:00:00.000Z' });
    // "Restart": the in-memory records are dropped and loaded lazily from the file
    setBranchPushStore(file);
    expect(lastBranchPush('ps')).toEqual({ sha: 'sha-of-vibe-teamlead/spec-ps', at: '2026-01-01T00:00:00.000Z' });
  });

  it('keeps the error kind; a missing or broken file reads as empty', async () => {
    const file = path.join(dir, 'branch-pushes.json');
    setBranchPushStore(file);
    expect(lastBranchPush('nope')).toBeUndefined();
    const { deps } = makeDeps(vi.fn(async () => { throw new GitHubWriteError('permissions', 'x'); }));
    await pushTaskBranch(project(), task('pe'), deps);
    setBranchPushStore(file);
    expect(lastBranchPush('pe')?.error).toEqual({ kind: 'permissions' });
    writeFileSync(file, '{oops');
    setBranchPushStore(file);
    expect(lastBranchPush('pe')).toBeUndefined();
  });
});

describe('visibility re-check before a preview push', () => {
  it('a repo that became public is recorded as public and not pushed', async () => {
    const push = vi.fn(async () => {});
    const { deps, emit } = makeDeps(push);
    const visibility = vi.fn(async () => 'public' as const);
    const markPublic = vi.fn();
    deps.visibility = visibility;
    deps.markPublic = markPublic;
    const p = { ...(project() as object), id: 'pv1' } as never;
    const rec = await pushTaskBranch(p, task('v1'), deps);
    expect(push).not.toHaveBeenCalled();
    expect(visibility).toHaveBeenCalledWith('me', 'app');
    expect(markPublic).toHaveBeenCalledWith('pv1', { ...repo, public: true });
    expect(rec.sha).toBeUndefined();
    expect(emit).toHaveBeenCalledWith('pv1', 'v1');
  });

  it('checks at most once per hour per project', async () => {
    let t = Date.parse('2026-01-01T00:00:00.000Z');
    const push = vi.fn(async () => {});
    let head = 0;
    const { deps } = makeDeps(push);
    deps.head = vi.fn(async () => `h${++head}`) as never;
    deps.now = () => new Date(t);
    const visibility = vi.fn(async () => 'private' as const);
    deps.visibility = visibility;
    deps.markPublic = vi.fn();
    const p = { ...(project() as object), id: 'pv2' } as never;
    await pushTaskBranch(p, task('v2'), deps);
    t += 59 * 60_000;
    await pushTaskBranch(p, task('v2'), deps);
    expect(visibility).toHaveBeenCalledTimes(1);
    t += 2 * 60_000;
    await pushTaskBranch(p, task('v2'), deps);
    expect(visibility).toHaveBeenCalledTimes(2);
    expect(push).toHaveBeenCalledTimes(3);
  });

  it('a failed check fails closed: no push, nothing marked public, asked again next time', async () => {
    const push = vi.fn(async () => {});
    let head = 0;
    const { deps } = makeDeps(push);
    deps.head = vi.fn(async () => `h${++head}`) as never;
    const visibility = vi.fn(async (): Promise<'private' | 'public'> => { throw new Error('offline'); });
    deps.visibility = visibility;
    deps.markPublic = vi.fn();
    const p = { ...(project() as object), id: 'pv3' } as never;
    await pushTaskBranch(p, task('v3'), deps);
    await pushTaskBranch(p, task('v3'), deps);
    expect(push).not.toHaveBeenCalled();
    expect(deps.markPublic).not.toHaveBeenCalled();
    expect(visibility).toHaveBeenCalledTimes(2);
  });
});

describe('worktreePushNewBranches (the task branch push when its worktree is made)', () => {
  const settings = (deploy: unknown, pushNewBranches?: boolean) => ({ deploy, ...(pushNewBranches === undefined ? {} : { pushNewBranches }) }) as never;
  it('a public repository (or one of unknown visibility) gets no task branch pushed', () => {
    expect(worktreePushNewBranches(settings({ enabled: true, repo: { ...repo, public: true } }), undefined)).toBe(false);
    const { public: _p, ...unknown } = repo;
    expect(worktreePushNewBranches(settings({ enabled: true, repo: unknown }), undefined)).toBe(false);
    expect(worktreePushNewBranches(settings({ enabled: true, repo: { ...repo, public: true } }), true)).toBe(false);
    // set up means the repository step is done
    expect(worktreePushNewBranches(settings({ repo: { ...repo, public: true } }), undefined)).toBe(false);
    expect(worktreePushNewBranches(settings({ enabled: false, repo: { ...repo, public: true } }), undefined)).toBe(false);
  });
  it('otherwise the task option, then the project setting (default on)', () => {
    expect(worktreePushNewBranches(settings({ enabled: true, repo }), undefined)).toBe(true);
    expect(worktreePushNewBranches(settings(undefined), undefined)).toBe(true);
    expect(worktreePushNewBranches(settings({ repo }), undefined)).toBe(true);
    expect(worktreePushNewBranches(settings({ enabled: true }), undefined)).toBe(true);
    expect(worktreePushNewBranches(settings(undefined, false), undefined)).toBe(false);
    expect(worktreePushNewBranches(settings(undefined, false), true)).toBe(true);
    expect(worktreePushNewBranches(undefined, undefined)).toBe(true);
  });
});
