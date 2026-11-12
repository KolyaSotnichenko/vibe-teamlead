import { describe, expect, it, vi } from 'vitest';
import type { DeployRun, DeployRunsState, GitHubError } from '../../../shared/types/deploy';
import type { Project } from '../../../shared/types';
import { createRunsPoller, fetchJobLog, prepareLog } from '../runs-poller';

const run = (id: number, status: DeployRun['status'] = 'completed'): DeployRun => ({
  id, name: 'CI', title: `run ${id}`, branch: 'main', sha: `sha${id}`, event: 'push', status,
  number: 1, startedAt: '', updatedAt: '', htmlUrl: '', workflowPath: '.github/workflows/ci.yml',
});
const project = (id = 'p1') => ({ id, path: '/x' }) as unknown as Project;

function setup(over: Record<string, unknown> = {}) {
  const client = {
    runs: vi.fn(async () => [run(3), run(2)]),
    jobs: vi.fn(async () => []),
    workflowFile: vi.fn(async () => 'jobs:\n  build:\n    runs-on: x\n'),
    deployments: vi.fn(async () => []),
    commitStatuses: vi.fn(async () => []),
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
    t.poller.select('p1', 2);
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

  it('keeps the previous selected graph when a later tick fails after runs succeeded', async () => {
    const jobs = vi.fn(async () => [{ id: 9, name: 'build', status: 'completed', steps: [] }]);
    const t = setup({ jobs });
    t.poller.start(project());
    await t.flush();
    const before = t.emitted.at(-1)!.selected;
    expect(before?.jobs).toHaveLength(1);
    jobs.mockRejectedValueOnce({ kind: 'unavailable', message: 'down' });
    await t.fire();
    const s = t.emitted.at(-1)!;
    expect(s.error?.kind).toBe('unavailable');
    expect(s.selected).toEqual(before);
  });

  it('workflowFile rate-limit sets the error and pauses at resetAt', async () => {
    const err: GitHubError = { kind: 'rate-limit', resetAt: new Date(1_000_000 + 120_000).toISOString(), message: 'x' };
    const t = setup({ workflowFile: vi.fn(async () => { throw err; }) });
    t.poller.start(project());
    await t.flush();
    expect(t.emitted.at(-1)!.error).toEqual(err);
    expect([...t.timers.values()][0].ms).toBe(120_000);
  });

  it('workflowFile permissions sets state.error and still builds a graph', async () => {
    const t = setup({ workflowFile: vi.fn(async () => { throw { kind: 'permissions', message: 'p' }; }) });
    t.poller.start(project());
    await t.flush();
    const s = t.emitted.at(-1)!;
    expect(s.error?.kind).toBe('permissions');
    expect(s.selected?.runId).toBe(3);
  });

  it('workflowFile unavailable gives a flat graph, no error, no refetch within 60 s', async () => {
    const t = setup({
      runs: vi.fn(async () => [run(3, 'in_progress')]),
      jobs: vi.fn(async () => [{ id: 9, name: 'build', status: 'in_progress', steps: [] }]),
      workflowFile: vi.fn(async () => { throw { kind: 'unavailable', message: 'down' }; }),
    });
    t.poller.start(project());
    await t.flush();
    const s = t.emitted.at(-1)!;
    expect(s.error).toBeUndefined();
    expect(s.selected?.graph.columns[0].stage).toBe('other');
    await t.fire();
    await t.fire();
    expect(t.client.workflowFile).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 12; i++) await t.fire();
    expect(t.client.workflowFile).toHaveBeenCalledTimes(2);
  });

  it('ignores select for a project that is not the current session', async () => {
    const t = setup();
    t.poller.start(project('p1'));
    await t.flush();
    const n = t.emitted.length;
    t.poller.select('other', 2);
    await t.flush();
    expect(t.emitted).toHaveLength(n);
  });

  it('stopAll stops the current session', async () => {
    const t = setup();
    t.poller.start(project());
    await t.flush();
    t.poller.stopAll();
    expect(t.timers.size).toBe(0);
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

describe('repo resolution', () => {
  it('retries a failed resolution on the next 60 s tick, then polls', async () => {
    const t = setup();
    t.resolveRepo.mockResolvedValueOnce(null);
    t.poller.start(project());
    await t.flush();
    expect(t.emitted.at(-1)!.repo).toBeUndefined();
    expect([...t.timers.values()].map((x) => x.ms)).toEqual([60_000]);
    await t.fire();
    expect(t.resolveRepo).toHaveBeenCalledTimes(2);
    expect(t.client.runs).toHaveBeenCalled();
    expect(t.emitted.at(-1)!.repo).toEqual({ owner: 'o', repo: 'r' });
  });

  it('retries after a resolution that throws', async () => {
    const t = setup();
    t.resolveRepo.mockRejectedValueOnce(new Error('git'));
    t.poller.start(project());
    await t.flush();
    expect(t.timers.size).toBe(1);
    await t.fire();
    expect(t.resolveRepo).toHaveBeenCalledTimes(2);
  });

  it('a stopped session does not retry the resolution', async () => {
    const t = setup();
    t.resolveRepo.mockResolvedValue(null);
    t.poller.start(project());
    await t.flush();
    t.poller.stop('p1');
    expect(t.timers.size).toBe(0);
  });

  it('repoFor gives the resolved repo of the current project only', async () => {
    const t = setup();
    expect(t.poller.repoFor('p1')).toBeUndefined();
    t.poller.start(project());
    await t.flush();
    expect(t.poller.repoFor('p1')).toEqual({ owner: 'o', repo: 'r' });
    expect(t.poller.repoFor('p2')).toBeUndefined();
  });
});

describe('prepareLog', () => {
  it('keeps the last 2 000 lines', () => {
    const text = Array.from({ length: 2500 }, (_, i) => `line-${i + 1}`).join('\n');
    const out = prepareLog(text);
    expect(out.split('\n')).toHaveLength(2000);
    expect(out.startsWith('line-501\n')).toBe(true);
    expect(out.endsWith('line-2500')).toBe(true);
  });
  it('does not count a trailing newline as a line, and keeps a short log whole', () => {
    expect(prepareLog('a\nb\n')).toBe('a\nb');
    expect(prepareLog('a\r\nb', 1)).toBe('b');
  });
  it('strips ANSI escape codes (colours, cursor, OSC links)', () => {
    expect(prepareLog('\x1b[36;1mRun npm test\x1b[0m\n\x1b[2K\x1b]8;;https://x\x07link\x1b]8;;\x07 ok')).toBe('Run npm test\nlink ok');
  });
});

describe('fetchJobLog', () => {
  const repo = { owner: 'o', repo: 'r' };
  it('ready with text', async () => {
    expect(await fetchJobLog({ jobLog: async () => 'hi' } as never, repo, 1)).toEqual({ state: 'ready', text: 'hi' });
  });
  it('sends the log trimmed and without ANSI codes', async () => {
    const text = `\x1b[31m${Array.from({ length: 2001 }, (_, i) => `l${i}`).join('\n')}\x1b[0m\n`;
    const r = await fetchJobLog({ jobLog: async () => text } as never, repo, 1);
    expect(r).toEqual({ state: 'ready', text: Array.from({ length: 2000 }, (_, i) => `l${i + 1}`).join('\n') });
  });
  it('404 (null) is pending', async () => {
    expect(await fetchJobLog({ jobLog: async () => null } as never, repo, 1)).toEqual({ state: 'pending' });
  });
  const fail = (e: unknown) => ({ jobLog: async () => { throw e; } }) as never;
  it('410 (gone) is expired', async () => {
    expect(await fetchJobLog(fail({ kind: 'unavailable', status: 410, message: '' }), repo, 1)).toEqual({ state: 'expired' });
  });
  it('a network drop, a 5xx or a thrown Error is an unavailable error, not expired', async () => {
    const drop = { kind: 'unavailable', message: 'Could not reach GitHub' };
    expect(await fetchJobLog(fail(drop), repo, 1)).toEqual({ state: 'error', error: drop });
    const e5xx = { kind: 'unavailable', status: 502, message: 'GitHub API error 502' };
    expect(await fetchJobLog(fail(e5xx), repo, 1)).toEqual({ state: 'error', error: e5xx });
    expect(await fetchJobLog(fail(new Error('x')), repo, 1)).toEqual({ state: 'error', error: { kind: 'unavailable', message: 'x' } });
  });
  it('rate-limit, permissions, no-connection are errors', async () => {
    for (const kind of ['rate-limit', 'permissions', 'no-connection'] as const) {
      const e = { kind, message: 'm' };
      const r = await fetchJobLog({ jobLog: async () => { throw e; } } as never, repo, 1);
      expect(r).toEqual({ state: 'error', error: e });
    }
  });
});

describe('createRunsPoller main runs', () => {
  it('passes own push runs on main (also unfinished ones) to handleMainRuns and survives its errors', async () => {
    const own = (r: DeployRun): DeployRun => ({ ...r, headRepo: 'o/r' });
    const runs = [
      own(run(4, 'in_progress')),
      { ...own(run(3)), branch: 'feat' },
      { ...own(run(5)), event: 'pull_request', headRepo: 'evil/r' },
      own(run(2)),
      own(run(1)),
    ];
    const client = { runs: vi.fn(async () => runs), jobs: vi.fn(async () => []), workflowFile: vi.fn(async () => null), deployments: vi.fn(async () => []), productionUrl: vi.fn(async () => null) };
    const seen: number[][] = [];
    const poller = createRunsPoller({
      client: client as never,
      resolveRepo: async () => ({ owner: 'o', repo: 'r' }),
      setTimer: (() => 1) as never,
      clearTimer: (() => undefined) as never,
      emit: () => undefined,
      mainBranch: async () => 'main',
      handleMainRuns: async (_p, rs) => { seen.push(rs.map((r) => r.id)); throw new Error('boom'); },
    });
    poller.start(project());
    for (let i = 0; i < 40; i++) await Promise.resolve();
    expect(seen).toEqual([[4, 2, 1]]);
  });
});

describe('deploy stage from Vercel commit statuses (no GitHub Deployments for the sha)', () => {
  const vercel = (state: 'in_progress' | 'success' | 'failure') => ({
    environment: 'Vercel', state, createdAt: '2026-11-12T10:00:00Z', logUrl: 'https://vercel.com/acme/app/AbC',
  });
  const deployNodes = (s: DeployRunsState) => s.selected?.graph.columns.find((c) => c.stage === 'deploy')?.nodes ?? [];

  it('builds the deploy column from the Vercel status of the run\'s sha, with its link', async () => {
    const t = setup({ commitStatuses: vi.fn(async () => [vercel('failure')]) });
    t.poller.start(project());
    await t.flush();
    expect(t.client.commitStatuses).toHaveBeenCalledWith('o', 'r', 'sha3');
    expect(deployNodes(t.emitted.at(-1)!)).toEqual([
      expect.objectContaining({ key: 'deploy:Vercel', label: 'Vercel', status: 'failure', logUrl: 'https://vercel.com/acme/app/AbC' }),
    ]);
  });

  it('does not read statuses when the sha has deployments', async () => {
    const t = setup({
      deployments: vi.fn(async () => [{ environment: 'Production', state: 'success', createdAt: 'x' }]),
      commitStatuses: vi.fn(async () => [vercel('failure')]),
    });
    t.poller.start(project());
    await t.flush();
    expect(t.client.commitStatuses).not.toHaveBeenCalled();
    expect(deployNodes(t.emitted.at(-1)!).map((n) => n.label)).toEqual(['Production']);
  });

  it('a finished status is read once per sha; a pending one again on the next poll', async () => {
    const done = setup({ runs: vi.fn(async () => [run(3, 'in_progress')]), commitStatuses: vi.fn(async () => [vercel('success')]) });
    done.poller.start(project());
    await done.flush();
    await done.fire();
    expect(done.client.commitStatuses).toHaveBeenCalledTimes(1);
    expect(deployNodes(done.emitted.at(-1)!)[0].status).toBe('success');
    const pending = setup({ runs: vi.fn(async () => [run(3, 'in_progress')]), commitStatuses: vi.fn(async () => [vercel('in_progress')]) });
    pending.poller.start(project());
    await pending.flush();
    await pending.fire();
    expect(pending.client.commitStatuses).toHaveBeenCalledTimes(2);
    expect(deployNodes(pending.emitted.at(-1)!)[0].status).toBe('running');
  });

  it('a failed status read leaves the graph without a deploy column and is no error', async () => {
    const t = setup({ commitStatuses: vi.fn(async () => { throw { kind: 'unavailable', message: 'x' }; }) });
    t.poller.start(project());
    await t.flush();
    const s = t.emitted.at(-1)!;
    expect(deployNodes(s)).toEqual([]);
    expect(s.error).toBeUndefined();
  });
});
