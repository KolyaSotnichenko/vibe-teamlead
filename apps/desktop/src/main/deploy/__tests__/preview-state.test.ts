import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Project, Task } from '../../../shared/types';
import type { DeployDeployment, DeployJob, DeployRun } from '../../../shared/types/deploy';

vi.mock('../branch-push', () => ({
  previewPushAllowed: vi.fn(),
  lastBranchPush: vi.fn(),
}));

import { previewPushAllowed, lastBranchPush } from '../branch-push';
import { invalidatePreview, previewState, type PreviewDeps } from '../preview-state';

const project = { id: 'p1', path: '/p' } as unknown as Project;
const task = (over: Partial<Task> = {}) =>
  ({ id: 't1', specId: '001-x', status: 'in_progress', ...over }) as unknown as Task;

const dep = (over: Partial<DeployDeployment>): DeployDeployment => ({
  environment: 'Preview', state: 'success', url: 'https://p.vercel.app', createdAt: '2026-11-10T10:00:00Z', sha: 's1', ...over,
});

function deps(over: Partial<{ deployments: DeployDeployment[]; runs: DeployRun[]; jobs: DeployJob[]; fail: boolean }> = {}) {
  const deploymentsForRef = vi.fn(async () => {
    if (over.fail) throw new Error('boom');
    return over.deployments ?? [];
  });
  const runs = vi.fn(async () => over.runs ?? []);
  const jobs = vi.fn(async () => over.jobs ?? []);
  const d: PreviewDeps = {
    actions: { deploymentsForRef, runs, jobs },
    resolveRepo: async () => ({ owner: 'acme', repo: 'app' }),
    now: () => 1000,
  };
  return { d, deploymentsForRef, runs, jobs };
}

beforeEach(() => {
  invalidatePreview('t1');
  vi.mocked(previewPushAllowed).mockReturnValue({ allowed: true });
  vi.mocked(lastBranchPush).mockReturnValue({ sha: 'h1', at: 'x' });
});

describe('previewState', () => {
  it('not-set-up and unavailable come from the push check, without GitHub', async () => {
    const { d, deploymentsForRef } = deps();
    vi.mocked(previewPushAllowed).mockReturnValue({ allowed: false, reason: 'not-set-up' });
    expect(await previewState(project, task(), d)).toEqual({ state: 'not-set-up' });
    vi.mocked(previewPushAllowed).mockReturnValue({ allowed: false, reason: 'public-repo' });
    expect(await previewState(project, task(), d)).toEqual({ state: 'unavailable', reason: 'public-repo' });
    vi.mocked(previewPushAllowed).mockReturnValue({ allowed: false, reason: 'push-off' });
    expect(await previewState(project, task(), d)).toEqual({ state: 'unavailable', reason: 'push-off' });
    expect(deploymentsForRef).not.toHaveBeenCalled();
  });

  it('not-pushed without a push, outside the preview statuses, or after a failed push; no GitHub call', async () => {
    const { d, deploymentsForRef } = deps();
    vi.mocked(lastBranchPush).mockReturnValue(undefined);
    expect(await previewState(project, task(), d)).toEqual({ state: 'not-pushed' });
    vi.mocked(lastBranchPush).mockReturnValue({ at: 'x', error: { kind: 'auth' } });
    expect(await previewState(project, task(), d)).toEqual({ state: 'not-pushed', pushError: 'auth' });
    vi.mocked(lastBranchPush).mockReturnValue({ sha: 'h1', at: 'x' });
    expect(await previewState(project, task({ status: 'backlog' }), d)).toEqual({ state: 'not-pushed' });
    expect(await previewState(project, task({ status: 'done' }), d)).toEqual({ state: 'not-pushed' });
    expect(deploymentsForRef).not.toHaveBeenCalled();
  });

  it('ready with the newest deployment, ignoring production', async () => {
    const { d, deploymentsForRef } = deps({
      deployments: [
        dep({ environment: 'Production', url: 'https://prod', createdAt: '2026-11-10T12:00:00Z' }),
        dep({ createdAt: '2026-11-10T11:00:00Z' }),
        dep({ url: 'https://old', createdAt: '2026-11-10T09:00:00Z' }),
      ],
    });
    expect(await previewState(project, task(), d)).toEqual({ state: 'ready', url: 'https://p.vercel.app', builtAt: '2026-11-10T11:00:00Z' });
    expect(deploymentsForRef).toHaveBeenCalledWith('acme', 'app', 'vibe-teamlead/001-x');
  });

  it('building keeps the newest older success as previousUrl', async () => {
    const { d } = deps({
      deployments: [
        dep({ state: 'in_progress', url: undefined, createdAt: '2026-11-10T11:00:00Z' }),
        dep({ state: 'failure', url: undefined, createdAt: '2026-11-10T10:30:00Z' }),
        dep({ url: 'https://ready-1', createdAt: '2026-11-10T10:00:00Z' }),
        dep({ url: 'https://ready-0', createdAt: '2026-11-10T09:00:00Z' }),
      ],
    });
    expect(await previewState(project, task(), d)).toEqual({ state: 'building', previousUrl: 'https://ready-1' });
  });

  it('queued and pending are building; no deployments yet is building', async () => {
    for (const state of ['queued', 'pending'] as const) {
      invalidatePreview('t1');
      expect(await previewState(project, task(), deps({ deployments: [dep({ state, url: undefined })] }).d)).toEqual({ state: 'building' });
    }
    invalidatePreview('t1');
    expect(await previewState(project, task(), deps().d)).toEqual({ state: 'building' });
  });

  it('a success without a URL is not ready', async () => {
    const { d } = deps({ deployments: [dep({ url: undefined })] });
    expect((await previewState(project, task(), d)).state).not.toBe('ready');
  });

  it('failed links the run of the failed sha and its first failed job', async () => {
    const run = (id: number, sha: string): DeployRun => ({ id, sha } as DeployRun);
    const { d, runs, jobs } = deps({
      deployments: [dep({ state: 'failure', url: undefined, sha: 's9' })],
      runs: [run(30, 'other'), run(20, 's9'), run(10, 's9')],
      jobs: [
        { id: 1, name: 'a', conclusion: 'success' } as DeployJob,
        { id: 2, name: 'b', conclusion: 'failure' } as DeployJob,
        { id: 3, name: 'c', conclusion: 'failure' } as DeployJob,
      ],
    });
    expect(await previewState(project, task(), d)).toEqual({ state: 'failed', runId: 20, jobId: 2 });
    expect(runs).toHaveBeenCalledWith('acme', 'app', 20, 'vibe-teamlead/001-x');
    expect(jobs).toHaveBeenCalledWith('acme', 'app', 20);
  });

  it('failed falls back to the newest run on the branch, and to no link', async () => {
    const { d } = deps({
      deployments: [dep({ state: 'error', url: undefined, sha: 'zz' })],
      runs: [{ id: 5, sha: 'q' } as DeployRun],
      jobs: [{ id: 7, name: 'b', conclusion: 'failure' } as DeployJob],
    });
    expect(await previewState(project, task(), d)).toEqual({ state: 'failed', runId: 5, jobId: 7 });
    invalidatePreview('t1');
    expect(await previewState(project, task(), deps({ deployments: [dep({ state: 'failure', url: undefined })] }).d)).toEqual({ state: 'failed' });
  });

  it('GitHub errors give building and are not cached', async () => {
    const bad = deps({ fail: true });
    expect(await previewState(project, task(), bad.d)).toEqual({ state: 'building' });
    const good = deps({ deployments: [dep({})] });
    expect((await previewState(project, task(), good.d)).state).toBe('ready');
    expect(good.deploymentsForRef).toHaveBeenCalledTimes(1);
  });
});

describe('cache', () => {
  it('two calls within 30 s make one GitHub call; after 30 s a second', async () => {
    let t = 1000;
    const { d, deploymentsForRef } = deps({ deployments: [dep({})] });
    d.now = () => t;
    await previewState(project, task(), d);
    t += 29_000;
    await previewState(project, task(), d);
    expect(deploymentsForRef).toHaveBeenCalledTimes(1);
    t += 2_000;
    await previewState(project, task(), d);
    expect(deploymentsForRef).toHaveBeenCalledTimes(2);
  });

  it('a new pushed sha misses, and invalidatePreview drops the entry', async () => {
    const { d, deploymentsForRef } = deps({ deployments: [dep({})] });
    await previewState(project, task(), d);
    vi.mocked(lastBranchPush).mockReturnValue({ sha: 'h2', at: 'y' });
    await previewState(project, task(), d);
    expect(deploymentsForRef).toHaveBeenCalledTimes(2);
    invalidatePreview('t1');
    await previewState(project, task(), d);
    expect(deploymentsForRef).toHaveBeenCalledTimes(3);
  });
});
