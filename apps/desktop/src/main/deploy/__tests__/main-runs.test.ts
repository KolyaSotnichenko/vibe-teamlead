import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project, Task, TaskMetadata } from '../../../shared/types';
import type { DeployJob, DeployRun } from '../../../shared/types/deploy';
import { type DeployTaskDeps, markRunHandled, wasRunHandled } from '../deploy-tasks';
import { findLastMainRun, handleMainRun, handleMainRuns, isOwnPushOnMain, watchMainRuns, type MainRunDeps } from '../main-runs';

let dir: string;
let tasks: Task[];
let created: Array<{ title: string; description: string; metadata: TaskMetadata }>;
let started: string[];
let seq = 0;

const project = (over: Record<string, unknown> = {}) =>
  ({ id: `p${seq}`, path: dir, settings: { mainBranch: 'main', deploy: { enabled: true } }, ...over }) as unknown as Project;

const run = (id: number, over: Partial<DeployRun> = {}): DeployRun => ({
  id, number: id, name: 'CI', title: 't', branch: 'main', sha: 'abc', event: 'push', headRepo: 'o/r', status: 'completed', conclusion: 'failure',
  startedAt: '', updatedAt: '', htmlUrl: `https://github.com/o/r/actions/runs/${id}`, workflowPath: '.github/workflows/ci.yml', ...over,
});
const job = (id: number, name: string, conclusion: string): DeployJob => ({ id, name, status: 'completed', conclusion, steps: [] });

function saveReadiness() {
  mkdirSync(path.join(dir, '.vibe-teamlead', 'deploy'), { recursive: true });
  writeFileSync(
    path.join(dir, '.vibe-teamlead', 'deploy', 'readiness.json'),
    JSON.stringify({ scannedAt: 'x', blockers: [], services: [], owner: [], workflow: { state: 'present' } }),
  );
}

function makeDeps(over: Partial<MainRunDeps> = {}) {
  const client = {
    runs: vi.fn(async () => [] as DeployRun[]),
    jobs: vi.fn(async () => [job(1, 'build', 'failure'), job(2, 'lint', 'success')]),
    jobLog: vi.fn(async () => Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n')),
  };
  const taskDeps: DeployTaskDeps = {
    getTasks: () => tasks,
    createTask: async (_p, title, description, metadata) => {
      const t = { id: `t${tasks.length + 1}`, specId: `00${tasks.length + 1}-x`, status: 'backlog' } as unknown as Task;
      tasks.push(t);
      created.push({ title, description, metadata });
      return t;
    },
    startTask: async (id) => { started.push(id); },
  };
  const deps: MainRunDeps = { client, resolveRepo: async () => ({ owner: 'o', repo: 'r' }), tasks: taskDeps, ...over };
  return Object.assign(deps, { client });
}

beforeEach(() => { seq++; dir = mkdtempSync(path.join(tmpdir(), 'mainruns-')); tasks = []; created = []; started = []; saveReadiness(); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.useRealTimers(); });

describe('handleMainRun', () => {
  it('a failed run creates one urgent task with failed jobs, log tails and the run URL', async () => {
    const deps = makeDeps();
    expect(await handleMainRun(project(), run(10), deps)).toBe('created');
    expect(created).toHaveLength(1);
    expect(created[0].title).toBe('Fix the failed CI run on main');
    expect(created[0].metadata).toMatchObject({ priority: 'urgent', deployKey: 'run:.github/workflows/ci.yml' });
    const d = created[0].description;
    expect(d).toContain('build');
    expect(d).not.toContain('lint');
    expect(d).toContain('line 300');
    expect(d).toContain('line 101');
    expect(d).not.toContain('line 100\n');
    expect(d).toContain('https://github.com/o/r/actions/runs/10');
    expect(d).toContain("Fix whichever is wrong, the project or the workflow; don't skip or weaken checks.");
    expect(started).toEqual(['t1']);
  });

  it('the same run again is seen', async () => {
    const deps = makeDeps();
    await handleMainRun(project(), run(10), deps);
    expect(await handleMainRun(project(), run(10), deps)).toBe('seen');
    expect(created).toHaveLength(1);
    expect(wasRunHandled(dir, 10)).toBe(true);
  });

  it('a second failed run of the same workflow while the task is open makes no task', async () => {
    const deps = makeDeps();
    await handleMainRun(project(), run(10), deps);
    expect(await handleMainRun(project(), run(11), deps)).toBe('open');
    expect(created).toHaveLength(1);
  });

  it('after the task is done a new failed run makes a new task', async () => {
    const deps = makeDeps();
    await handleMainRun(project(), run(10), deps);
    tasks[0].status = 'done' as never;
    expect(await handleMainRun(project(), run(11), deps)).toBe('created');
    expect(created).toHaveLength(2);
  });

  it('two workflows make two tasks', async () => {
    const deps = makeDeps();
    await handleMainRun(project(), run(10), deps);
    await handleMainRun(project(), run(11, { name: 'Lint', workflowPath: '.github/workflows/lint.yml' }), deps);
    expect(created.map((c) => c.title)).toEqual(['Fix the failed CI run on main', 'Fix the failed Lint run on main']);
  });

  it('a passed run makes nothing', async () => {
    const deps = makeDeps();
    expect(await handleMainRun(project(), run(10, { conclusion: 'success' }), deps)).toBe('passed');
    expect(created).toHaveLength(0);
    expect(deps.client.jobs).not.toHaveBeenCalled();
  });

  it('does nothing without deploy enabled or a saved readiness result', async () => {
    const deps = makeDeps();
    expect(await handleMainRun(project({ settings: { deploy: { enabled: false } } }), run(10), deps)).toBe('seen');
    rmSync(path.join(dir, '.vibe-teamlead', 'deploy', 'readiness.json'));
    expect(await handleMainRun(project(), run(11), deps)).toBe('seen');
    expect(created).toHaveLength(0);
    expect(deps.client.jobs).not.toHaveBeenCalled();
  });

  it('keeps the created task entries when marking runs handled', async () => {
    const deps = makeDeps();
    await handleMainRun(project(), run(10), deps);
    for (let i = 0; i < 120; i++) markRunHandled(dir, 1000 + i);
    expect(wasRunHandled(dir, 10)).toBe(false);
    expect(wasRunHandled(dir, 1119)).toBe(true);
    expect(await handleMainRun(project(), run(500), deps)).toBe('open');
  });
});

describe('handleMainRun safety', () => {
  it('ignores a pull request run on a branch named main, and marks it handled', async () => {
    const deps = makeDeps();
    expect(await handleMainRun(project(), run(10, { event: 'pull_request' }), deps)).toBe('seen');
    expect(created).toHaveLength(0);
    expect(wasRunHandled(dir, 10)).toBe(true);
    expect(deps.client.jobLog).not.toHaveBeenCalled();
  });

  it('ignores a push from another head repository (case-insensitive match for the own one)', async () => {
    const deps = makeDeps();
    expect(await handleMainRun(project(), run(10, { headRepo: 'evil/r' }), deps)).toBe('seen');
    expect(created).toHaveLength(0);
    expect(await handleMainRun(project(), run(11, { headRepo: 'O/R' }), deps)).toBe('created');
    expect(await handleMainRun(project(), run(12, { headRepo: undefined, workflowPath: 'x.yml' }), deps)).toBe('seen');
  });

  it('clips job and run names to one line of at most 100 characters in headings and the title', async () => {
    const deps = makeDeps();
    const jobName = `build\n## injected ${'j'.repeat(300)}`;
    deps.client.jobs.mockResolvedValue([job(1, jobName, 'failure')]);
    await handleMainRun(project(), run(10, { name: `CI\n# evil ${'r'.repeat(300)}` }), deps);
    const { title, description } = created[0];
    expect(title).not.toContain('\n');
    expect(title.length).toBeLessThanOrEqual('Fix the failed  run on main'.length + 100);
    const heading = description.split('\n').find((l) => l.startsWith('### '));
    expect(heading).toBeDefined();
    expect((heading as string).length).toBeLessThanOrEqual(4 + 100);
    expect(description).not.toContain('\n## injected');
    expect(description).not.toContain('\n# evil');
    expect(description).not.toContain('j'.repeat(150));
  });

  it('a log with fence sequences cannot break out of its fence', async () => {
    const deps = makeDeps();
    deps.client.jobLog.mockResolvedValue('before\n```\n# injected\n````\nafter');
    await handleMainRun(project(), run(10), deps);
    const fences = created[0].description.split('\n').filter((l) => l.startsWith('```'));
    expect(fences).toHaveLength(2);
    expect(created[0].description).toContain('injected');
  });
});

describe('handleMainRuns (newest completed run per workflow)', () => {
  const at = (n: number) => `2026-11-12T10:0${n}:00Z`;
  it('an old failure already followed by a success makes no task; both are marked handled', async () => {
    const deps = makeDeps();
    await handleMainRuns(project(), [run(1, { startedAt: at(1) }), run(2, { startedAt: at(2), conclusion: 'success' })], deps);
    expect(created).toHaveLength(0);
    expect(wasRunHandled(dir, 1)).toBe(true);
    expect(wasRunHandled(dir, 2)).toBe(true);
  });

  it('a failure that is the newest makes one task, whatever the order of the list', async () => {
    const deps = makeDeps();
    await handleMainRuns(project(), [run(2, { startedAt: at(2) }), run(1, { startedAt: at(1), conclusion: 'success' })], deps);
    expect(created).toHaveLength(1);
    expect(wasRunHandled(dir, 1)).toBe(true);
  });

  it('two workflows each newest-failed make two tasks', async () => {
    const deps = makeDeps();
    await handleMainRuns(
      project(),
      [run(1, { startedAt: at(1) }), run(2, { name: 'Lint', workflowPath: 'l.yml', startedAt: at(2) })],
      deps,
    );
    expect(created).toHaveLength(2);
  });

  it('a fork run does not shadow the own newest run', async () => {
    const deps = makeDeps();
    await handleMainRuns(project(), [run(1, { startedAt: at(1) }), run(2, { startedAt: at(2), conclusion: 'success', headRepo: 'evil/r' })], deps);
    expect(created).toHaveLength(1);
  });

  it('skips a workflow while a newer own push run of it is not completed yet', async () => {
    const deps = makeDeps();
    const newer = run(2, { startedAt: at(2), status: 'in_progress', conclusion: undefined });
    await handleMainRuns(project(), [run(1, { startedAt: at(1) }), newer], deps);
    expect(created).toHaveLength(0);
    expect(wasRunHandled(dir, 1)).toBe(false);
    // A newer run from a fork does not hold the own failure back
    await handleMainRuns(project(), [run(1, { startedAt: at(1) }), { ...newer, headRepo: 'evil/r' }], deps);
    expect(created).toHaveLength(1);
  });
});

describe('isOwnPushOnMain', () => {
  const repo = { owner: 'o', repo: 'r' };
  it('is a push of the own repository (any case) on main only', () => {
    expect(isOwnPushOnMain(run(1), repo, 'main')).toBe(true);
    expect(isOwnPushOnMain(run(1, { headRepo: 'O/R' }), repo, 'main')).toBe(true);
    expect(isOwnPushOnMain(run(1, { headRepo: 'evil/r' }), repo, 'main')).toBe(false);
    expect(isOwnPushOnMain(run(1, { event: 'pull_request' }), repo, 'main')).toBe(false);
    expect(isOwnPushOnMain(run(1, { branch: 'dev' }), repo, 'main')).toBe(false);
    expect(isOwnPushOnMain(run(1), repo, undefined)).toBe(false);
  });
});

describe('findLastMainRun', () => {
  const at = (n: number) => `2026-11-12T10:0${n}:00Z`;
  it('asks GitHub for runs on main and ignores a fork pull request run on a branch named main', async () => {
    const deps = makeDeps();
    deps.client.runs.mockResolvedValue([
      run(2, { startedAt: at(2), event: 'pull_request', headRepo: 'evil/r', conclusion: 'success' }),
      run(1, { startedAt: at(1), sha: 's1' }),
    ]);
    const last = await findLastMainRun(project(), deps);
    expect(deps.client.runs).toHaveBeenCalledWith('o', 'r', 20, 'main');
    expect(last).toEqual({ conclusion: 'failure', runId: 1, sha: 's1', failedJobs: ['build'], workflowPath: '.github/workflows/ci.yml' });
  });

  it('clips failed job names to one line of 100 characters', async () => {
    const deps = makeDeps();
    deps.client.runs.mockResolvedValue([run(1)]);
    deps.client.jobs.mockResolvedValue([job(1, `a\n${'n'.repeat(300)}`, 'failure')]);
    const last = await findLastMainRun(project(), deps);
    expect(last?.failedJobs[0].length).toBeLessThanOrEqual(100);
    expect(last?.failedJobs[0]).not.toContain('\n');
  });

  it('is undefined with no own completed run, or when GitHub fails', async () => {
    const deps = makeDeps();
    deps.client.runs.mockResolvedValue([run(1, { headRepo: 'evil/r' }), run(2, { status: 'in_progress', conclusion: undefined })]);
    expect(await findLastMainRun(project(), deps)).toBeUndefined();
    deps.client.runs.mockRejectedValue(new Error('down'));
    expect(await findLastMainRun(project(), deps)).toBeUndefined();
  });
});

describe('watchMainRuns', () => {
  function timers() {
    let now = 0;
    const pending: Array<{ fn: () => void; ms: number }> = [];
    return {
      now: () => now,
      setTimer: ((fn: () => void, ms: number) => { const t = { fn, ms }; pending.push(t); return t; }) as never,
      clearTimer: (() => undefined) as never,
      pending,
      async fire() {
        const t = pending.shift();
        if (!t) return false;
        now += t.ms;
        t.fn();
        for (let i = 0; i < 40; i++) await Promise.resolve();
        return true;
      },
    };
  }
  const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

  it('polls runs of the sha on main, handles completed ones and stops when all are completed', async () => {
    const t = timers();
    const deps = makeDeps({ now: t.now, setTimer: t.setTimer, clearTimer: t.clearTimer });
    deps.client.runs
      .mockResolvedValueOnce([run(10, { status: 'in_progress', conclusion: undefined })])
      .mockResolvedValue([run(10)]);
    watchMainRuns(project(), 'abc', deps);
    await flush();
    expect(deps.client.runs).toHaveBeenCalledWith('o', 'r', expect.any(Number), 'main');
    expect(created).toHaveLength(0);
    expect(t.pending[0].ms).toBe(60_000);
    await t.fire();
    expect(created).toHaveLength(1);
    expect(t.pending).toHaveLength(0);
  });

  it('only waits for runs of the pushed sha (a newest failure of another sha is still handled)', async () => {
    const t = timers();
    const deps = makeDeps({ now: t.now, setTimer: t.setTimer, clearTimer: t.clearTimer });
    deps.client.runs.mockResolvedValue([run(10, { sha: 'other' })]);
    watchMainRuns(project(), 'abc', deps);
    await flush();
    expect(created).toHaveLength(1);
    expect(t.pending).toHaveLength(1);
  });

  it('stops after 60 minutes', async () => {
    const t = timers();
    const deps = makeDeps({ now: t.now, setTimer: t.setTimer, clearTimer: t.clearTimer });
    deps.client.runs.mockResolvedValue([run(10, { status: 'in_progress', conclusion: undefined })]);
    watchMainRuns(project(), 'abc', deps);
    await flush();
    let fires = 0;
    while (t.pending.length && fires < 200) { await t.fire(); fires++; }
    expect(fires).toBe(60);
    expect(t.pending).toHaveLength(0);
  });

  it('one watcher per project and sha', async () => {
    const t = timers();
    const deps = makeDeps({ now: t.now, setTimer: t.setTimer, clearTimer: t.clearTimer });
    deps.client.runs.mockResolvedValue([]);
    watchMainRuns(project(), 'abc', deps);
    watchMainRuns(project(), 'abc', deps);
    await flush();
    expect(deps.client.runs).toHaveBeenCalledTimes(1);
    expect(t.pending).toHaveLength(1);
  });

  it('does not watch a project without deploy or readiness', async () => {
    const t = timers();
    const deps = makeDeps({ now: t.now, setTimer: t.setTimer, clearTimer: t.clearTimer });
    watchMainRuns(project({ settings: {} }), 'abc', deps);
    await flush();
    expect(deps.client.runs).not.toHaveBeenCalled();
  });
});
