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

const run = (id: number, sha: string, status: DeployRun['status'] = 'completed', conclusion?: string): DeployRun =>
  ({ id, sha, status, conclusion }) as DeployRun;

describe('previewState (CI status of the pushed sha)', () => {
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

  it('no run of the pushed sha is waiting; one runs() call on the task branch', async () => {
    const { d, runs, jobs } = deps();
    expect(await previewState(project, task(), d)).toEqual({ state: 'waiting' });
    expect(runs).toHaveBeenCalledTimes(1);
    expect(runs).toHaveBeenCalledWith('acme', 'app', 10, 'vibe-teamlead/001-x');
    expect(jobs).not.toHaveBeenCalled();
  });

  it('runs of an older sha do not count: failed or passed old runs leave it waiting', async () => {
    const { d, jobs } = deps({ runs: [run(30, 'old', 'completed', 'failure'), run(20, 'older', 'completed', 'success')] });
    expect(await previewState(project, task(), d)).toEqual({ state: 'waiting' });
    expect(jobs).not.toHaveBeenCalled();
  });

  it('a queued or in-progress run of the sha is running (even beside an older failure)', async () => {
    for (const status of ['queued', 'in_progress'] as const) {
      invalidatePreview('t1');
      const { d } = deps({ runs: [run(2, 'h1', status), run(1, 'old', 'completed', 'failure')] });
      expect(await previewState(project, task(), d)).toEqual({ state: 'running' });
    }
  });

  it('all runs of the sha succeeded: passed (skipped and neutral count as fine)', async () => {
    const { d, jobs } = deps({ runs: [run(3, 'h1', 'completed', 'success'), run(2, 'h1', 'completed', 'skipped'), run(1, 'old', 'completed', 'failure')] });
    expect(await previewState(project, task(), d)).toEqual({ state: 'passed' });
    expect(jobs).not.toHaveBeenCalled();
  });

  it('failed links the newest failed run of the sha and its first failed job; jobs is read once', async () => {
    const { d, runs, jobs } = deps({
      runs: [run(30, 'other', 'completed', 'failure'), run(20, 'h1', 'completed', 'failure'), run(10, 'h1', 'completed', 'failure'), run(9, 'h1', 'completed', 'success')],
      jobs: [
        { id: 1, name: 'a', conclusion: 'success' } as DeployJob,
        { id: 2, name: 'b', conclusion: 'failure' } as DeployJob,
      ],
    });
    expect(await previewState(project, task(), d)).toEqual({ state: 'failed', runId: 20, jobId: 2 });
    expect(runs).toHaveBeenCalledWith('acme', 'app', 10, 'vibe-teamlead/001-x');
    expect(jobs).toHaveBeenCalledTimes(1);
    expect(jobs).toHaveBeenCalledWith('acme', 'app', 20);
  });

  it('a timed-out or cancelled run is a failure; with no failed job the run alone is linked', async () => {
    const { d } = deps({ runs: [run(5, 'h1', 'completed', 'timed_out')], jobs: [{ id: 7, name: 'b', conclusion: 'success' } as DeployJob] });
    expect(await previewState(project, task(), d)).toEqual({ state: 'failed', runId: 5 });
  });

  it('failed survives a jobs error (run only)', async () => {
    const { d, jobs } = deps({ runs: [run(5, 'h1', 'completed', 'failure')] });
    jobs.mockRejectedValueOnce(new Error('boom'));
    expect(await previewState(project, task(), d)).toEqual({ state: 'failed', runId: 5 });
  });

  it('a refused push keeps the state with pushError', async () => {
    vi.mocked(lastBranchPush).mockReturnValue({ sha: 'h1', at: 'x', error: { kind: 'conflict' } });
    expect(await previewState(project, task(), deps().d)).toEqual({ state: 'waiting', pushError: 'conflict' });
  });

  it('GitHub errors give waiting and are not cached', async () => {
    expect(await previewState(project, task(), deps({ fail: true }).d)).toEqual({ state: 'waiting' });
    const good = deps();
    await previewState(project, task(), good.d);
    expect(good.runs).toHaveBeenCalledTimes(1);
  });
});

describe('cache', () => {
  it('running: two calls within 30 s make one GitHub call; after 30 s a second', async () => {
    let t = 1000;
    const { d, runs } = deps({ runs: [run(1, 'h1', 'in_progress')] });
    d.now = () => t;
    await previewState(project, task(), d);
    t += 29_000;
    await previewState(project, task(), d);
    expect(runs).toHaveBeenCalledTimes(1);
    t += 2_000;
    await previewState(project, task(), d);
    expect(runs).toHaveBeenCalledTimes(2);
  });

  it('passed and failed stay cached until the next push, however long', async () => {
    let t = 1000;
    const { d, runs } = deps({ runs: [run(1, 'h1', 'completed', 'success')] });
    d.now = () => t;
    await previewState(project, task(), d);
    t += 3_600_000;
    expect(await previewState(project, task(), d)).toEqual({ state: 'passed' });
    expect(runs).toHaveBeenCalledTimes(1);
  });

  it('waiting is re-read after 30 s', async () => {
    let t = 1000;
    const { d, runs } = deps();
    d.now = () => t;
    await previewState(project, task(), d);
    t += 31_000;
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
