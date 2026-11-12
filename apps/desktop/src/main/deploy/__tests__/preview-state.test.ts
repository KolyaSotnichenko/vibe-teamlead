import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Project, Task } from '../../../shared/types';
import type { DeployJob, DeployRun } from '../../../shared/types/deploy';

vi.mock('../branch-push', () => ({
  previewPushAllowed: vi.fn(),
  lastBranchPush: vi.fn(),
}));

import { previewPushAllowed, lastBranchPush } from '../branch-push';
import { invalidatePreview, previewState, type PreviewDeps } from '../preview-state';

const project = { id: 'p1', path: '/p' } as unknown as Project;
const task = (over: Partial<Task> = {}) =>
  ({ id: 't1', specId: '001-x', status: 'in_progress', ...over }) as unknown as Task;

function deps(over: Partial<{ runs: DeployRun[]; jobs: DeployJob[]; fail: boolean }> = {}) {
  const runs = vi.fn(async () => {
    if (over.fail) throw new Error('boom');
    return over.runs ?? [];
  });
  const jobs = vi.fn(async () => over.jobs ?? []);
  const d: PreviewDeps = {
    actions: { runs, jobs },
    resolveRepo: async () => ({ owner: 'acme', repo: 'app' }),
    now: () => 1000,
  };
  return { d, runs, jobs };
}

beforeEach(() => {
  invalidatePreview('t1');
  vi.mocked(previewPushAllowed).mockReturnValue({ allowed: true });
  vi.mocked(lastBranchPush).mockReturnValue({ sha: 'h1', at: 'x' });
});

describe('previewState (no deployments: Task 5 rebuilds it on CI runs)', () => {
  it('not-set-up and unavailable come from the push check, without GitHub', async () => {
    const { d, runs } = deps();
    vi.mocked(previewPushAllowed).mockReturnValue({ allowed: false, reason: 'not-set-up' });
    expect(await previewState(project, task(), d)).toEqual({ state: 'not-set-up' });
    vi.mocked(previewPushAllowed).mockReturnValue({ allowed: false, reason: 'public-repo' });
    expect(await previewState(project, task(), d)).toEqual({ state: 'unavailable', reason: 'public-repo' });
    expect(runs).not.toHaveBeenCalled();
  });

  it('not-pushed without a push, outside the preview statuses, or after a failed push; no GitHub call', async () => {
    const { d, runs } = deps();
    vi.mocked(lastBranchPush).mockReturnValue(undefined);
    expect(await previewState(project, task(), d)).toEqual({ state: 'not-pushed' });
    vi.mocked(lastBranchPush).mockReturnValue({ at: 'x', error: { kind: 'auth' } });
    expect(await previewState(project, task(), d)).toEqual({ state: 'not-pushed', pushError: 'auth' });
    vi.mocked(lastBranchPush).mockReturnValue({ sha: 'h1', at: 'x' });
    expect(await previewState(project, task({ status: 'backlog' }), d)).toEqual({ state: 'not-pushed' });
    expect(runs).not.toHaveBeenCalled();
  });

  it('a pushed branch with no failed run is building', async () => {
    expect(await previewState(project, task(), deps().d)).toEqual({ state: 'building' });
  });

  it('failed links the run of the pushed sha and its first failed job', async () => {
    const run = (id: number, sha: string): DeployRun => ({ id, sha } as DeployRun);
    const { d, runs, jobs } = deps({
      runs: [run(30, 'other'), run(20, 'h1'), run(10, 'h1')],
      jobs: [
        { id: 1, name: 'a', conclusion: 'success' } as DeployJob,
        { id: 2, name: 'b', conclusion: 'failure' } as DeployJob,
      ],
    });
    expect(await previewState(project, task(), d)).toEqual({ state: 'failed', runId: 20, jobId: 2 });
    expect(runs).toHaveBeenCalledWith('acme', 'app', 20, 'vibe-teamlead/001-x');
    expect(jobs).toHaveBeenCalledWith('acme', 'app', 20);
  });

  it('a run of the sha whose jobs all passed is not failed', async () => {
    const { d } = deps({ runs: [{ id: 5, sha: 'h1' } as DeployRun], jobs: [{ id: 7, name: 'b', conclusion: 'success' } as DeployJob] });
    expect(await previewState(project, task(), d)).toEqual({ state: 'building' });
  });

  it('a refused push keeps the state with pushError', async () => {
    vi.mocked(lastBranchPush).mockReturnValue({ sha: 'h1', at: 'x', error: { kind: 'conflict' } });
    expect(await previewState(project, task(), deps().d)).toEqual({ state: 'building', pushError: 'conflict' });
  });

  it('GitHub errors give building and are not cached', async () => {
    expect(await previewState(project, task(), deps({ fail: true }).d)).toEqual({ state: 'building' });
    const good = deps();
    await previewState(project, task(), good.d);
    expect(good.runs).toHaveBeenCalledTimes(1);
  });
});

describe('cache', () => {
  it('building: two calls within 30 s make one GitHub call; after 30 s a second', async () => {
    let t = 1000;
    const { d, runs } = deps();
    d.now = () => t;
    await previewState(project, task(), d);
    t += 29_000;
    await previewState(project, task(), d);
    expect(runs).toHaveBeenCalledTimes(1);
    t += 2_000;
    await previewState(project, task(), d);
    expect(runs).toHaveBeenCalledTimes(2);
  });

  it('a new pushed sha misses, and invalidatePreview drops the entry', async () => {
    let t = 1000;
    const { d, runs } = deps();
    d.now = () => t;
    await previewState(project, task(), d);
    vi.mocked(lastBranchPush).mockReturnValue({ sha: 'h2', at: 'y' });
    await previewState(project, task(), d);
    expect(runs).toHaveBeenCalledTimes(2);
    invalidatePreview('t1');
    await previewState(project, task(), d);
    expect(runs).toHaveBeenCalledTimes(3);
  });

  it('concurrent asks for one task share one read', async () => {
    const { d, runs } = deps();
    await Promise.all([previewState(project, task(), d), previewState(project, task(), d), previewState(project, task(), d)]);
    expect(runs).toHaveBeenCalledTimes(1);
  });
});
