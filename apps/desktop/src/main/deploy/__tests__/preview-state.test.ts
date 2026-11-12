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

function deps(over: Partial<{ deployments: DeployDeployment[]; runs: DeployRun[]; jobs: DeployJob[]; fail: boolean; statuses: DeployDeployment[] }> = {}) {
  const list = over.deployments ?? [];
  // The list without statuses; each status is asked for on its own (by the index as id)
  const refDeployments = vi.fn(async () => {
    if (over.fail) throw new Error('boom');
    return list
      .map((d, id) => ({ id, environment: d.environment, createdAt: d.createdAt, ...(d.sha ? { sha: d.sha } : {}) }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });
  const deploymentStatus = vi.fn(async (_o: string, _r: string, id: number) => {
    const d = list[id];
    return { state: d.state, ...(d.url ? { url: d.url } : {}), ...(d.logUrl ? { logUrl: d.logUrl } : {}) };
  });
  const runs = vi.fn(async () => over.runs ?? []);
  const jobs = vi.fn(async () => over.jobs ?? []);
  const commitStatuses = vi.fn(async () => over.statuses ?? []);
  const d: PreviewDeps = {
    actions: { refDeployments, deploymentStatus, runs, jobs, commitStatuses },
    resolveRepo: async () => ({ owner: 'acme', repo: 'app' }),
    now: () => 1000,
  };
  return { d, refDeployments, deploymentsForRef: refDeployments, deploymentStatus, runs, jobs, commitStatuses };
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
    expect(deploymentsForRef).toHaveBeenCalledWith('acme', 'app', 'vibe-teamlead/001-x', 5);
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
      deployments: [dep({ state: 'failure', url: undefined, sha: 's9', logUrl: 'https://vercel.com/acme/app/log' })],
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

  it('failed without a failed run of that sha links the Vercel build log, never an unrelated run', async () => {
    const { d } = deps({
      deployments: [dep({ state: 'error', url: undefined, sha: 'zz', logUrl: 'https://vercel.com/acme/app/build' })],
      runs: [{ id: 5, sha: 'q' } as DeployRun],
      jobs: [{ id: 7, name: 'b', conclusion: 'failure' } as DeployJob],
    });
    expect(await previewState(project, task(), d)).toEqual({ state: 'failed', logUrl: 'https://vercel.com/acme/app/build' });
  });

  it('a run of the sha whose jobs all passed is not linked either', async () => {
    const { d } = deps({
      deployments: [dep({ state: 'failure', url: undefined, sha: 's9', logUrl: 'https://vercel.com/log' })],
      runs: [{ id: 5, sha: 's9' } as DeployRun],
      jobs: [{ id: 7, name: 'b', conclusion: 'success' } as DeployJob],
    });
    expect(await previewState(project, task(), d)).toEqual({ state: 'failed', logUrl: 'https://vercel.com/log' });
  });

  it('a log URL that is not https is dropped', async () => {
    const { d } = deps({ deployments: [dep({ state: 'failure', url: undefined, logUrl: 'http://vercel.com/log' })] });
    expect(await previewState(project, task(), d)).toEqual({ state: 'failed' });
  });

  it('inactive with an https url is ready (GitHub retires older Preview deployments)', async () => {
    const { d } = deps({ deployments: [dep({ state: 'inactive', url: 'https://old-but-fine.vercel.app' })] });
    expect(await previewState(project, task(), d)).toEqual({ state: 'ready', url: 'https://old-but-fine.vercel.app', builtAt: '2026-11-10T10:00:00Z' });
  });

  it('an inactive older deployment is the previous URL while building', async () => {
    const { d } = deps({
      deployments: [
        dep({ state: 'in_progress', url: undefined, createdAt: '2026-11-10T11:00:00Z' }),
        dep({ state: 'inactive', url: 'https://prev.vercel.app', createdAt: '2026-11-10T10:00:00Z' }),
      ],
    });
    expect(await previewState(project, task(), d)).toEqual({ state: 'building', previousUrl: 'https://prev.vercel.app' });
  });

  it('an earlier success then a refused push keeps the preview with pushError', async () => {
    vi.mocked(lastBranchPush).mockReturnValue({ sha: 'h1', at: 'x', error: { kind: 'conflict' } });
    const { d } = deps({ deployments: [dep({})] });
    expect(await previewState(project, task(), d)).toMatchObject({ state: 'ready', pushError: 'conflict' });
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
  it('building: two calls within 30 s make one GitHub call; after 30 s a second', async () => {
    let t = 1000;
    const { d, deploymentsForRef } = deps({ deployments: [dep({ state: 'in_progress', url: undefined })] });
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

describe('GitHub cost', () => {
  it('a ready newest deployment costs one list call and one status call (5 per page)', async () => {
    const { d, refDeployments, deploymentStatus } = deps({
      deployments: [
        dep({ createdAt: '2026-11-10T11:00:00Z' }),
        dep({ createdAt: '2026-11-10T10:00:00Z' }),
        dep({ createdAt: '2026-11-10T09:00:00Z' }),
      ],
    });
    await previewState(project, task(), d);
    expect(refDeployments).toHaveBeenCalledWith('acme', 'app', 'vibe-teamlead/001-x', 5);
    expect(deploymentStatus).toHaveBeenCalledTimes(1);
  });

  it('building stops at the first older ready deployment', async () => {
    const { d, deploymentStatus } = deps({
      deployments: [
        dep({ state: 'in_progress', url: undefined, createdAt: '2026-11-10T11:00:00Z' }),
        dep({ url: 'https://ready-1', createdAt: '2026-11-10T10:00:00Z' }),
        dep({ url: 'https://ready-0', createdAt: '2026-11-10T09:00:00Z' }),
        dep({ url: 'https://ready-00', createdAt: '2026-11-10T08:00:00Z' }),
      ],
    });
    await previewState(project, task(), d);
    expect(deploymentStatus).toHaveBeenCalledTimes(2);
  });

  it('ready and failed stay cached until the next push; building only 30 s', async () => {
    let t = 1000;
    const ready = deps({ deployments: [dep({})] });
    ready.d.now = () => t;
    await previewState(project, task(), ready.d);
    t += 10 * 60_000;
    await previewState(project, task(), ready.d);
    expect(ready.refDeployments).toHaveBeenCalledTimes(1);
    vi.mocked(lastBranchPush).mockReturnValue({ sha: 'h2', at: 'y' });
    await previewState(project, task(), ready.d);
    expect(ready.refDeployments).toHaveBeenCalledTimes(2);

    invalidatePreview('t1');
    const failed = deps({ deployments: [dep({ state: 'failure', url: undefined })] });
    failed.d.now = () => t;
    await previewState(project, task(), failed.d);
    t += 10 * 60_000;
    await previewState(project, task(), failed.d);
    expect(failed.refDeployments).toHaveBeenCalledTimes(1);

    invalidatePreview('t1');
    const building = deps({ deployments: [dep({ state: 'in_progress', url: undefined })] });
    building.d.now = () => t;
    await previewState(project, task(), building.d);
    t += 31_000;
    await previewState(project, task(), building.d);
    expect(building.refDeployments).toHaveBeenCalledTimes(2);
  });

  it('concurrent asks for one task share one read', async () => {
    const { d, refDeployments } = deps({ deployments: [dep({})] });
    const [a, b, c] = await Promise.all([previewState(project, task(), d), previewState(project, task(), d), previewState(project, task(), d)]);
    expect(refDeployments).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });
});

describe('previewState from Vercel commit statuses (no GitHub Deployments for the branch)', () => {
  const vercel = (over: Partial<DeployDeployment>): DeployDeployment => ({
    environment: 'Vercel', state: 'in_progress', createdAt: '2026-11-12T10:00:00Z', logUrl: 'https://vercel.com/acme/app/AbC', ...over,
  });

  it('pending is building, asked for by the pushed commit', async () => {
    const { d, commitStatuses } = deps({ statuses: [vercel({})] });
    expect(await previewState(project, task(), d)).toEqual({ state: 'building' });
    expect(commitStatuses).toHaveBeenCalledWith('acme', 'app', 'h1');
  });

  it('several Vercel contexts: failure wins, then pending, then success', async () => {
    const ok = vercel({ environment: 'Vercel – web', state: 'success' });
    const failed = vercel({ environment: 'Vercel – api', state: 'failure', logUrl: 'https://vercel.com/acme/api/X' });
    const running = vercel({ environment: 'Vercel – docs', state: 'in_progress' });
    expect((await previewState(project, task(), deps({ statuses: [ok, running, failed] }).d)).state).toBe('failed');
    invalidatePreview('t1');
    expect((await previewState(project, task(), deps({ statuses: [ok, running] }).d)).state).toBe('building');
    invalidatePreview('t1');
    expect((await previewState(project, task(), deps({ statuses: [ok] }).d)).state).toBe('built');
  });

  it('links only to vercel.com for the Vercel page and *.vercel.app for the preview', async () => {
    const other = deps({ statuses: [vercel({ state: 'success', logUrl: 'https://evil.example/x' })] });
    expect(await previewState(project, task(), other.d)).toEqual({ state: 'building' });
    invalidatePreview('t1');
    const badUrl = deps({ statuses: [vercel({ state: 'success', url: 'https://evil.example' })] });
    expect((await previewState(project, task(), badUrl.d)).state).toBe('built');
    invalidatePreview('t1');
    const failed = deps({ statuses: [vercel({ state: 'failure', logUrl: 'https://evil.example/x' })] });
    expect(await previewState(project, task(), failed.d)).toEqual({ state: 'failed' });
  });

  it('failure is failed with the Vercel page as the log', async () => {
    const { d } = deps({ statuses: [vercel({ state: 'failure' })] });
    expect(await previewState(project, task(), d)).toEqual({ state: 'failed', logUrl: 'https://vercel.com/acme/app/AbC' });
  });

  it('failure with a failed Actions run of the pushed commit links that run', async () => {
    const { d } = deps({
      statuses: [vercel({ state: 'failure' })],
      runs: [{ id: 9, sha: 'h1' } as DeployRun],
      jobs: [{ id: 4, conclusion: 'failure' } as DeployJob],
    });
    expect(await previewState(project, task(), d)).toEqual({ state: 'failed', runId: 9, jobId: 4 });
  });

  it('success with a known https preview URL is ready', async () => {
    const { d } = deps({ statuses: [vercel({ state: 'success', url: 'https://app-git-x.vercel.app' })] });
    expect(await previewState(project, task(), d)).toEqual({ state: 'ready', url: 'https://app-git-x.vercel.app', builtAt: '2026-11-12T10:00:00Z' });
  });

  it('success without a preview URL is built, linking to the Vercel page, never a guessed URL', async () => {
    const { d } = deps({ statuses: [vercel({ state: 'success' })] });
    expect(await previewState(project, task(), d)).toEqual({ state: 'built', logUrl: 'https://vercel.com/acme/app/AbC', builtAt: '2026-11-12T10:00:00Z' });
  });

  it('success with no https link at all stays building', async () => {
    const { d } = deps({ statuses: [vercel({ state: 'success', logUrl: 'http://vercel.com/x' })] });
    expect(await previewState(project, task(), d)).toEqual({ state: 'building' });
  });

  it('no statuses either: building', async () => {
    const { d } = deps();
    expect(await previewState(project, task(), d)).toEqual({ state: 'building' });
  });

  it('built is cached until the next push; statuses are not read when deployments exist', async () => {
    const { d, commitStatuses } = deps({ statuses: [vercel({ state: 'success' })] });
    await previewState(project, task(), d);
    await previewState(project, task(), d);
    expect(commitStatuses).toHaveBeenCalledTimes(1);
    invalidatePreview('t1');
    const withDeployments = deps({ deployments: [dep({})], statuses: [vercel({ state: 'failure' })] });
    expect((await previewState(project, task(), withDeployments.d)).state).toBe('ready');
    expect(withDeployments.commitStatuses).not.toHaveBeenCalled();
  });
});
