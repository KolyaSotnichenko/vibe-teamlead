import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project, Task, TaskMetadata } from '../../../shared/types';
import type { DeployJob, DeployRun } from '../../../shared/types/deploy';
import { type DeployTaskDeps, gaveUpKeys, markRunHandled, wasRunHandled } from '../deploy-tasks';
import { findLastMainRun, handleMainRun, handleMainRuns, isOwnPushOnMain, watchMainRuns, type MainRunDeps } from '../main-runs';

let dir: string;
let tasks: Task[];
let created: Array<{ title: string; description: string; metadata: TaskMetadata }>;
let started: string[];
let seq = 0;

const project = (over: Record<string, unknown> = {}) =>
  ({ id: `p${seq}`, path: dir, settings: { mainBranch: 'main', deploy: { repo: { owner: 'o', repo: 'r', createdByApp: true } } }, ...over }) as unknown as Project;

const run = (id: number, over: Partial<DeployRun> = {}): DeployRun => ({
  id, number: id, name: 'CI', title: 't', branch: 'main', sha: 'abc', event: 'push', headRepo: 'o/r', status: 'completed', conclusion: 'failure',
  startedAt: '', updatedAt: '', htmlUrl: `https://github.com/o/r/actions/runs/${id}`, workflowPath: '.github/workflows/ci.yml', ...over,
});
const job = (id: number, name: string, conclusion: string): DeployJob => ({ id, name, status: 'completed', conclusion, steps: [] });

function saveReadiness() {
  mkdirSync(path.join(dir, '.vibe-teamlead', 'deploy'), { recursive: true });
  writeFileSync(
    path.join(dir, '.vibe-teamlead', 'deploy', 'readiness.json'),
    JSON.stringify({ ci: 1, scannedAt: 'x', blockers: [], owner: [], workflow: { state: 'present' } }),
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
    queueTask: async () => { throw new Error('a run-fix task starts at once'); },
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

  it('gives up on a workflow after two fixes, keeps the run link, and starts again once a run passes', async () => {
    const deps = makeDeps();
    for (const id of [10, 11]) {
      await handleMainRun(project(), run(id), deps);
      tasks[tasks.length - 1].status = 'done' as never;
    }
    expect(await handleMainRun(project(), run(12), deps)).toBe('open');
    expect(created).toHaveLength(2);
    expect(gaveUpKeys(dir)).toEqual([{ key: 'run:.github/workflows/ci.yml', url: 'https://github.com/o/r/actions/runs/12' }]);
    // A fork's passing run says nothing about the own workflow
    await handleMainRun(project(), run(13, { conclusion: 'success', headRepo: 'evil/r' }), deps);
    expect(gaveUpKeys(dir)).toHaveLength(1);
    expect(await handleMainRun(project(), run(14, { conclusion: 'success' }), deps)).toBe('passed');
    expect(gaveUpKeys(dir)).toEqual([]);
    expect(await handleMainRun(project(), run(15), deps)).toBe('created');
  });

  it('a passed run makes nothing', async () => {
    const deps = makeDeps();
    expect(await handleMainRun(project(), run(10, { conclusion: 'success' }), deps)).toBe('passed');
    expect(created).toHaveLength(0);
    expect(deps.client.jobs).not.toHaveBeenCalled();
  });

  it('does nothing without CI set up (no repository recorded) or a saved readiness result', async () => {
    const deps = makeDeps();
    expect(await handleMainRun(project({ settings: { deploy: { enabled: false } } }), run(10), deps)).toBe('seen');
    expect(await handleMainRun(project({ settings: { deploy: { enabled: true } } }), run(12), deps)).toBe('seen');
    rmSync(path.join(dir, '.vibe-teamlead', 'deploy', 'readiness.json'));
    expect(await handleMainRun(project(), run(11), deps)).toBe('seen');
    expect(created).toHaveLength(0);
    expect(deps.client.jobs).not.toHaveBeenCalled();
  });

  it('a project set up under the old Deploy (enabled, repo and a Vercel project) still gets fix tasks', async () => {
    const deps = makeDeps();
    const old = project({ settings: { mainBranch: 'main', deploy: { enabled: true, repo: { owner: 'o', repo: 'r', createdByApp: true }, vercel: { projectId: 'prj', projectName: 'app' } } } });
    expect(await handleMainRun(old, run(20), deps)).not.toBe('seen');
    expect(created).toHaveLength(1);
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
      clearTimer: ((t: { fn: () => void; ms: number }) => { const i = pending.indexOf(t); if (i >= 0) pending.splice(i, 1); }) as never,
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

  it('an older failure waits while GitHub does not list a run of the pushed sha yet', async () => {
    const t = timers();
    const deps = makeDeps({ now: t.now, setTimer: t.setTimer, clearTimer: t.clearTimer });
    // Right after the push: only yesterday's failed run is listed
    deps.client.runs.mockResolvedValue([run(10, { sha: 'other', startedAt: '2026-11-12T13:34:22Z' })]);
    watchMainRuns(project(), 'abc', deps);
    await flush();
    expect(created).toHaveLength(0);
    expect(t.pending).toHaveLength(1);
    // The pushed sha's run shows up and passes: the old failure is settled without a task
    deps.client.runs.mockResolvedValue([
      run(10, { sha: 'other', startedAt: '2026-11-12T13:34:22Z' }),
      run(11, { sha: 'abc', startedAt: '2026-11-13T08:14:35Z', conclusion: 'success' }),
    ]);
    await t.fire();
    expect(created).toHaveLength(0);
    expect(t.pending).toHaveLength(0);
  });

  it('the poller also holds an older failure back while a watcher waits for the pushed sha', async () => {
    const t = timers();
    const deps = makeDeps({ now: t.now, setTimer: t.setTimer, clearTimer: t.clearTimer });
    deps.client.runs.mockResolvedValue([]);
    const p = project();
    watchMainRuns(p, 'abc', deps);
    await flush();
    await handleMainRuns(p, [run(10, { sha: 'other' })], deps);
    expect(created).toHaveLength(0);
  });

  it('when the pushed sha never gets a run, the older failure gets its task on the last tick', async () => {
    const t = timers();
    const deps = makeDeps({ now: t.now, setTimer: t.setTimer, clearTimer: t.clearTimer });
    deps.client.runs.mockResolvedValue([run(10, { sha: 'other' })]);
    watchMainRuns(project(), 'abc', deps);
    await flush();
    let fires = 0;
    while (t.pending.length && fires < 200) { await t.fire(); fires++; }
    expect(fires).toBe(60);
    expect(created).toHaveLength(1);
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

  it('keeps watching while a failed run of the sha could not be processed (GitHub error), then makes its task', async () => {
    const t = timers();
    const deps = makeDeps({ now: t.now, setTimer: t.setTimer, clearTimer: t.clearTimer });
    deps.client.runs.mockResolvedValue([run(10)]);
    deps.client.jobs.mockRejectedValueOnce(new Error('GitHub down'));
    watchMainRuns(project(), 'abc', deps);
    await flush();
    expect(created).toHaveLength(0);
    expect(t.pending).toHaveLength(1);
    await t.fire();
    expect(created).toHaveLength(1);
    expect(t.pending).toHaveLength(0);
  });

  it('handleMainRuns reports a failed run it could not process', async () => {
    const deps = makeDeps();
    deps.client.jobs.mockRejectedValueOnce(new Error('GitHub down'));
    expect(await handleMainRuns(project(), [run(10)], deps)).toEqual({ pending: true });
    expect(await handleMainRuns(project(), [run(10)], deps)).toEqual({ pending: false });
  });

  it('one watcher per project: a new push replaces the old watcher and follows the new sha', async () => {
    const t = timers();
    const deps = makeDeps({ now: t.now, setTimer: t.setTimer, clearTimer: t.clearTimer });
    deps.client.runs.mockResolvedValue([
      run(10, { sha: 'abc', status: 'in_progress', conclusion: undefined }),
      run(11, { sha: 'def', status: 'in_progress', conclusion: undefined }),
    ]);
    const p = project();
    watchMainRuns(p, 'abc', deps);
    await flush();
    watchMainRuns(p, 'def', deps);
    await flush();
    expect(deps.client.runs).toHaveBeenCalledTimes(2);
    expect(t.pending).toHaveLength(1);
    // abc completes, def still runs: the (replaced) abc watcher is gone, def keeps going
    deps.client.runs.mockResolvedValue([run(10, { sha: 'abc', conclusion: 'success' }), run(11, { sha: 'def', status: 'in_progress', conclusion: undefined })]);
    await t.fire();
    expect(t.pending).toHaveLength(1);
    deps.client.runs.mockResolvedValue([run(11, { sha: 'def', conclusion: 'success' })]);
    await t.fire();
    expect(t.pending).toHaveLength(0);
  });

  it('a replaced watcher whose tick is in flight does not schedule again', async () => {
    const t = timers();
    const deps = makeDeps({ now: t.now, setTimer: t.setTimer, clearTimer: t.clearTimer });
    let release!: (v: DeployRun[]) => void;
    deps.client.runs.mockImplementationOnce(() => new Promise<DeployRun[]>((r) => { release = r; }));
    deps.client.runs.mockResolvedValue([run(11, { sha: 'def', status: 'in_progress', conclusion: undefined })]);
    const p = project();
    watchMainRuns(p, 'abc', deps);
    await flush();
    watchMainRuns(p, 'def', deps);
    await flush();
    release([run(10, { sha: 'abc', status: 'in_progress', conclusion: undefined })]);
    await flush();
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

describe('no run-fix task while open tasks already work on the failure', () => {
  const open = (over: Record<string, unknown>) => tasks.push({ id: `o${tasks.length}`, specId: `9${tasks.length}-o`, status: 'in_progress', title: 'Other', description: '', ...over } as unknown as Task);
  /** The readiness scan names the workflow that runs the project's checks */
  const checksWorkflow = (workflowPath: string) =>
    writeFileSync(
      path.join(dir, '.vibe-teamlead', 'deploy', 'readiness.json'),
      JSON.stringify({ ci: 1, scannedAt: 'x', blockers: [], owner: [], workflow: { path: workflowPath } }),
    );

  it.each([
    ['its title names the workflow run', { title: 'Fix the failing CI run on main' }],
    ['its title names the workflow', { title: 'CI workflow misses the Postgres service' }],
    ['its description names the workflow file', { description: 'The job in .github/workflows/ci.yml needs a browser.' }],
    ['its description names the file by its name', { description: 'Add a Playwright install step to ci.yml' }],
  ])('none while an open task covers it (%s); the run is asked about again later', async (_name, over) => {
    open(over);
    expect(await handleMainRun(project(), run(10), makeDeps())).toBe('open');
    expect(created).toHaveLength(0);
    expect(wasRunHandled(dir, 10)).toBe(false);
  });

  it('once the covering task is done, the next poll creates the fix task', async () => {
    open({ title: 'Fix the failing CI run on main' });
    const deps = makeDeps();
    expect(await handleMainRun(project(), run(10), deps)).toBe('open');
    tasks[0].status = 'done' as never;
    expect(await handleMainRuns(project(), [run(10)], deps)).toEqual({ pending: false });
    expect(created).toHaveLength(1);
    expect(wasRunHandled(dir, 10)).toBe(true);
  });

  it('a backlog task that names the workflow does not cover it', async () => {
    open({ description: 'Add a Playwright install step to ci.yml', status: 'backlog' });
    expect(await handleMainRun(project(), run(10), makeDeps())).toBe('created');
  });

  it('an open base-fix task covers the workflow that runs the project\'s checks only', async () => {
    checksWorkflow('.github/workflows/ci.yml');
    open({ title: 'Fix the base branch', metadata: { sourceType: 'base-fix' } });
    expect(await handleMainRun(project(), run(10), makeDeps())).toBe('open');
    expect(await handleMainRun(project(), run(11, { name: 'Release', workflowPath: '.github/workflows/release.yml' }), makeDeps())).toBe('created');
  });

  it('an open base-fix task covers nothing while the checks workflow is unknown', async () => {
    open({ title: 'Fix the base branch', metadata: { sourceType: 'base-fix' } });
    expect(await handleMainRun(project(), run(10), makeDeps())).toBe('created');
  });

  it('a closed task that names the workflow does not count', async () => {
    checksWorkflow('.github/workflows/ci.yml');
    open({ title: 'Fix the failing CI run on main', status: 'done' });
    open({ title: 'Fix the base branch', metadata: { sourceType: 'base-fix' }, status: 'pr_created' });
    expect(await handleMainRun(project(), run(10), makeDeps())).toBe('created');
  });

  it('a task that only uses the workflow name as a word does not count', async () => {
    open({ title: 'Build the settings page', description: 'Then test it.' });
    expect(await handleMainRun(project(), run(10, { name: 'Build', workflowPath: '.github/workflows/build.yml' }), makeDeps())).toBe('created');
  });

  it('an open deploy workflow task holds the run task back (the run is handled)', async () => {
    mkdirSync(path.join(dir, '.vibe-teamlead', 'deploy'), { recursive: true });
    writeFileSync(
      path.join(dir, '.vibe-teamlead', 'deploy', 'tasks.json'),
      JSON.stringify({ tasks: [{ key: 'workflow-ci-browser-install', kind: 'workflow', specId: '90-o', at: '2026-01-01T00:00:00Z' }], handledRuns: [], gaveUp: [] }),
    );
    open({ title: 'Install browsers on the runner' });
    expect(await handleMainRun(project(), run(10), makeDeps())).toBe('open');
    expect(created).toHaveLength(0);
    expect(wasRunHandled(dir, 10)).toBe(true);
  });
});
