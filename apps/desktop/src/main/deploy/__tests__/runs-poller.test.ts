import { describe, expect, it, vi } from 'vitest';
import type { DeployRun, DeployRunsState, GitHubError } from '../../../shared/types/deploy';
import type { Project } from '../../../shared/types';
import { createRunsPoller, fetchJobLog } from '../runs-poller';

const run = (id: number, status: DeployRun['status'] = 'completed'): DeployRun => ({
  id, name: 'CI', title: `run ${id}`, branch: 'main', sha: `sha${id}`, event: 'push', status,
  startedAt: '', updatedAt: '', htmlUrl: '', workflowPath: '.github/workflows/ci.yml',
});
const project = (id = 'p1') => ({ id, path: '/x' }) as unknown as Project;

function setup(over: Record<string, unknown> = {}) {
  const client = {
    runs: vi.fn(async () => [run(3), run(2)]),
    jobs: vi.fn(async () => []),
    workflowFile: vi.fn(async () => 'jobs:\n  build:\n    runs-on: x\n'),
    deployments: vi.fn(async () => []),
    productionUrl: vi.fn(async () => 'https://prod.example'),
    jobLog: vi.fn(async () => 'log'),
    ...over,
  };
  let now = 1_000_000;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let nextId = 1;
  const emitted: DeployRunsState[] = [];
  const resolveRepo = vi.fn(async () => ({ owner: 'o', repo: 'r' }) as { owner: string; repo: string } | null);
  const poller = createRunsPoller({
    client: client as never,
    resolveRepo,
    now: () => now,
    setTimer: ((fn: () => void, ms: number) => { const id = nextId++; timers.set(id, { fn, ms }); return id; }) as never,
    clearTimer: ((id: number) => { timers.delete(id); }) as never,
    emit: (s) => emitted.push(s),
  });
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const fire = async () => { const [id, t] = [...timers.entries()][0]; timers.delete(id); now += t.ms; t.fn(); await flush(); };
  return { client, poller, emitted, timers, resolveRepo, flush, fire, advance: (ms: number) => { now += ms; } };
}

describe('createRunsPoller', () => {
  it('first tick emits runs, selects the newest and builds its graph', async () => {
    const t = setup();
    t.poller.start(project());
    await t.flush();
    const s = t.emitted.at(-1)!;
    expect(s.repo).toEqual({ owner: 'o', repo: 'r' });
    expect(s.runs.map((r) => r.id)).toEqual([3, 2]);
    expect(s.selected?.runId).toBe(3);
    expect(s.selected?.graph.columns).toHaveLength(0);
    expect(s.productionUrl).toBe('https://prod.example');
    expect(t.client.deployments).toHaveBeenCalledWith('o', 'r', 'sha3');
  });

  it('polls in 5 s while a run is in progress and 60 s when all are completed', async () => {
    const a = setup({ runs: vi.fn(async () => [run(3, 'in_progress')]) });
    a.poller.start(project());
    await a.flush();
    expect([...a.timers.values()][0].ms).toBe(5000);
    const b = setup();
    b.poller.start(project());
    await b.flush();
    expect([...b.timers.values()][0].ms).toBe(60000);
    const s = b.emitted.at(-1)!;
    expect(Date.parse(s.nextPollAt)).toBe(1_000_000 + 60000);
  });

  it('caches the workflow file per path and sha; refreshes the production url at most every 60 s', async () => {
    const t = setup({ runs: vi.fn(async () => [run(3, 'in_progress')]) });
    t.poller.start(project());
    await t.flush();
    await t.fire();
    await t.fire();
    expect(t.client.runs).toHaveBeenCalledTimes(3);
    expect(t.client.workflowFile).toHaveBeenCalledTimes(1);
    expect(t.client.productionUrl).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 12; i++) await t.fire();
    expect(t.client.productionUrl).toHaveBeenCalledTimes(2);
  });

  it('select switches the graph immediately', async () => {
    const t = setup();
    t.poller.start(project());
    await t.flush();
    t.poller.select(2);
    await t.flush();
    expect(t.emitted.at(-1)!.selected?.runId).toBe(2);
    expect(t.client.jobs).toHaveBeenLastCalledWith('o', 'r', 2);
    expect(t.timers.size).toBe(1);
  });

  it('start with a selected run id keeps it', async () => {
    const t = setup();
    t.poller.start(project(), 2);
    await t.flush();
    expect(t.emitted.at(-1)!.selected?.runId).toBe(2);
  });

  it('stop clears the timer and a tick in flight emits nothing', async () => {
    let release!: () => void;
    const t = setup({ runs: vi.fn(() => new Promise((r) => { release = () => r([run(3)]); })) });
    t.poller.start(project());
    await t.flush();
    t.poller.stop('p1');
    release();
    await t.flush();
    expect(t.emitted).toHaveLength(0);
    expect(t.timers.size).toBe(0);
    const u = setup();
    u.poller.start(project());
    await u.flush();
    const n = u.emitted.length;
    u.poller.stop('p1');
    expect(u.timers.size).toBe(0);
    expect(u.emitted).toHaveLength(n);
  });

  it('stop for another project does nothing', async () => {
    const t = setup();
    t.poller.start(project('p1'));
    await t.flush();
    t.poller.stop('p2');
    expect(t.timers.size).toBe(1);
  });

  it('starting another project stops the first', async () => {
    const t = setup();
    t.poller.start(project('p1'));
    await t.flush();
    t.poller.start(project('p2'));
    await t.flush();
    expect(t.timers.size).toBe(1);
    const n = t.emitted.length;
    await t.fire();
    expect(t.emitted.slice(n).every((s) => s.projectId === 'p2')).toBe(true);
  });

  it('rate-limit: next tick at resetAt and the state carries the error', async () => {
    const err: GitHubError = { kind: 'rate-limit', resetAt: new Date(1_000_000 + 300_000).toISOString(), message: 'x' };
    const t = setup({ runs: vi.fn(async () => { throw err; }) });
    t.poller.start(project());
    await t.flush();
    expect([...t.timers.values()][0].ms).toBe(300_000);
    expect(t.emitted.at(-1)!.error).toEqual(err);
  });

  it('permissions and unavailable: error state, polling continues at 60 s', async () => {
    for (const kind of ['permissions', 'unavailable'] as const) {
      const t = setup({ runs: vi.fn(async () => { throw { kind, message: 'm' }; }) });
      t.poller.start(project());
      await t.flush();
      expect(t.emitted.at(-1)!.error?.kind).toBe(kind);
      expect([...t.timers.values()][0].ms).toBe(60000);
    }
  });

  it('a thrown non-GitHub error becomes an unavailable error, never a rejection', async () => {
    const t = setup({ runs: vi.fn(async () => { throw new Error('boom'); }) });
    t.poller.start(project());
    await t.flush();
    expect(t.emitted.at(-1)!.error?.kind).toBe('unavailable');
  });

  it('keeps the last runs when a later tick fails', async () => {
    const runs = vi.fn(async () => [run(3)]);
    const t = setup({ runs });
    t.poller.start(project());
    await t.flush();
    runs.mockRejectedValueOnce({ kind: 'unavailable', message: 'down' });
    await t.fire();
    const s = t.emitted.at(-1)!;
    expect(s.error?.kind).toBe('unavailable');
    expect(s.runs.map((r) => r.id)).toEqual([3]);
  });

  it('no repo: state without repo, no API calls', async () => {
    const t = setup();
    t.resolveRepo.mockResolvedValue(null);
    t.poller.start(project());
    await t.flush();
    const s = t.emitted.at(-1)!;
    expect(s.repo).toBeUndefined();
    expect(s.runs).toEqual([]);
    expect(t.client.runs).not.toHaveBeenCalled();
  });
});

describe('fetchJobLog', () => {
  const repo = { owner: 'o', repo: 'r' };
  it('ready with text', async () => {
    expect(await fetchJobLog({ jobLog: async () => 'hi' } as never, repo, 1)).toEqual({ state: 'ready', text: 'hi' });
  });
  it('404 (null) is pending', async () => {
    expect(await fetchJobLog({ jobLog: async () => null } as never, repo, 1)).toEqual({ state: 'pending' });
  });
  it('unavailable (e.g. 410) is expired; other errors too, never throws', async () => {
    const fail = (e: unknown) => ({ jobLog: async () => { throw e; } }) as never;
    expect(await fetchJobLog(fail({ kind: 'unavailable', message: '' }), repo, 1)).toEqual({ state: 'expired' });
    expect(await fetchJobLog(fail(new Error('x')), repo, 1)).toEqual({ state: 'expired' });
  });
});
