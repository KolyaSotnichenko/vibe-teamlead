import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project, Task } from '../../../shared/types';
import type { ReadinessBlocker, ReadinessResult, ReadinessState } from '../../../shared/types/deploy';
import { autoSetUpAllowed, createReadiness, type ReadinessDeps } from '../readiness';
import { runReadinessScan, type ScanInput } from '../../ai/runners/deploy-readiness';
import { readReadiness, writeReadiness } from '../readiness-store';

let dir: string;
let deploy: Record<string, unknown> | undefined;
const project = () => ({ id: 'p1', path: dir, settings: { ...(deploy ? { deploy } : {}) } }) as unknown as Project;
const blocker = (subject: string): ReadinessBlocker => ({ key: `code:${subject}`, kind: 'code', subject, title: subject, detail: 'd' });
const result = (blockers: ReadinessBlocker[]): ReadinessResult => ({
  scannedAt: '2026-11-12T10:00:00Z',
  blockers,
  services: [],
  owner: [],
  workflow: {},
});

let tasks: Task[];
let created: string[];
let emitted: ReadinessState[];
let setUp: ReturnType<typeof vi.fn>;
let scan: ReturnType<typeof vi.fn>;
let canAutoSetUp: ReturnType<typeof vi.fn>;

function make(over: Partial<ReadinessDeps> = {}) {
  const deps: ReadinessDeps = {
    scan: scan as never,
    lastMainRun: async () => undefined,
    variableNames: async () => ['A'],
    headCommit: async () => 'abc',
    branches: async () => ['main', 'dev'],
    tasks: {
      getTasks: () => tasks,
      createTask: async (_p, title) => {
        created.push(title);
        const t = { id: `t${tasks.length + 1}`, specId: `00${tasks.length + 1}-x`, status: 'backlog' } as unknown as Task;
        tasks.push(t);
        return t;
      },
      startTask: async () => {},
      queueTask: async () => {},
    },
    setUp: setUp as never,
    canAutoSetUp: canAutoSetUp as never,
    emit: (_id, state) => { emitted.push(JSON.parse(JSON.stringify(state))); },
    ...over,
  };
  return createReadiness(deps);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ready-'));
  deploy = undefined;
  tasks = [];
  created = [];
  emitted = [];
  setUp = vi.fn(async () => ({}));
  canAutoSetUp = vi.fn(async () => true);
  scan = vi.fn(async () => result([]));
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('triggers', () => {
  it('open scans once, then not when a result is saved', async () => {
    const r = make();
    await r.scan(project(), 'open');
    await r.scan(project(), 'open');
    expect(scan).toHaveBeenCalledTimes(1);
    expect(readReadiness(dir)).not.toBeNull();
  });

  it('merge without a saved result does not scan', async () => {
    await make().scan(project(), 'merge', 'main');
    expect(scan).not.toHaveBeenCalled();
  });

  it('merge into a non-main branch does not scan; into main it does', async () => {
    writeReadiness(dir, result([]));
    const r = make();
    await r.scan(project(), 'merge', 'dev');
    expect(scan).not.toHaveBeenCalled();
    await r.scan(project(), 'merge', 'main');
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it('merge uses the configured main branch', async () => {
    writeReadiness(dir, result([]));
    const p = { ...project(), settings: { mainBranch: 'trunk' } } as unknown as Project;
    await make().scan(p, 'merge', 'main');
    expect(scan).not.toHaveBeenCalled();
    await make().scan(p, 'merge', 'trunk');
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it('check-again always scans and passes names and commit, never values', async () => {
    writeReadiness(dir, result([]));
    await make().scan(project(), 'check-again');
    expect(scan).toHaveBeenCalledWith(expect.objectContaining({ projectPath: dir, commit: 'abc', variableNames: ['A'], databaseAdded: false, servicesAdded: [] }));
  });

  it('passes the last run on main only when it ran on the commit being scanned', async () => {
    const last = { conclusion: 'failure', runId: 7, failedJobs: ['test'], sha: 'abc' };
    await make({ lastMainRun: async () => last }).scan(project(), 'check-again');
    expect(scan.mock.calls[0][0].lastMainRun).toEqual(last);
    // After a merge HEAD moved on: the run is of the commit before it
    await make({ lastMainRun: async () => ({ ...last, sha: 'old' }) }).scan(project(), 'check-again');
    expect(scan.mock.calls[1][0]).not.toHaveProperty('lastMainRun');
    // HEAD unknown: the run can't be matched
    await make({ lastMainRun: async () => last, headCommit: async () => undefined }).scan(project(), 'check-again');
    expect(scan.mock.calls[2][0]).not.toHaveProperty('lastMainRun');
  });

  it('passes the recorded services so the scan knows what is added', async () => {
    const p = { ...project(), settings: { deploy: { enabled: true, services: { redis: { addedAt: 't' } } } } } as unknown as Project;
    await make().scan(p, 'check-again');
    expect(scan).toHaveBeenCalledWith(expect.objectContaining({ servicesAdded: ['redis'] }));
  });
});

describe('giving up', () => {
  it('a blocker fixed twice and found again is given up and shown; a scan without it starts the count again', async () => {
    const r = make();
    scan.mockResolvedValue(result([blocker('x')]));
    for (let i = 0; i < 3; i++) {
      await r.scan(project(), 'check-again');
      for (const t of tasks) t.status = 'done' as never;
    }
    expect(created).toHaveLength(2);
    expect(r.state(project()).gaveUp).toEqual(['code:x']);
    scan.mockResolvedValue(result([]));
    await r.scan(project(), 'check-again');
    expect(r.state(project()).gaveUp).toBeUndefined();
    scan.mockResolvedValue(result([blocker('x')]));
    await r.scan(project(), 'check-again');
    expect(created).toHaveLength(3);
  });

  it('a given-up run key carries its run link', () => {
    mkdirSync(path.join(dir, '.vibe-teamlead', 'deploy'), { recursive: true });
    writeFileSync(
      path.join(dir, '.vibe-teamlead', 'deploy', 'tasks.json'),
      JSON.stringify({ tasks: [], handledRuns: [], gaveUp: [{ key: 'run:ci.yml', url: 'https://github.com/o/r/actions/runs/3' }] }),
    );
    expect(make().state(project())).toMatchObject({ gaveUp: ['run:ci.yml'], gaveUpLinks: { 'run:ci.yml': 'https://github.com/o/r/actions/runs/3' } });
  });
});

describe('single flight', () => {
  it('three scans during a running one run exactly one more', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    scan.mockImplementationOnce(async () => { await gate; return result([]); });
    const r = make();
    const first = r.scan(project(), 'check-again');
    await Promise.resolve();
    const more = [r.scan(project(), 'check-again'), r.scan(project(), 'check-again'), r.scan(project(), 'check-again')];
    release();
    await Promise.all([first, ...more]);
    expect(scan).toHaveBeenCalledTimes(2);
  });
});

describe('open while the first scan runs', () => {
  it('two concurrent opens with nothing saved scan once', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    scan.mockImplementationOnce(async () => { await gate; return result([]); });
    const r = make();
    const first = r.scan(project(), 'open');
    await Promise.resolve();
    const second = r.scan(project(), 'open');
    release();
    await Promise.all([first, second]);
    expect(scan).toHaveBeenCalledTimes(1);
  });
});

describe('a failed first scan', () => {
  it('is not retried by opening the tab again, only by Check again', async () => {
    scan.mockRejectedValueOnce(new Error('down'));
    const r = make();
    await r.scan(project(), 'open');
    await r.scan(project(), 'open');
    expect(scan).toHaveBeenCalledTimes(1);
    await r.scan(project(), 'check-again');
    expect(scan).toHaveBeenCalledTimes(2);
  });
});

describe('fresh project per scan', () => {
  it('each scan of a flight reads the project again, so setup sees deploy turned on meanwhile', async () => {
    writeReadiness(dir, result([blocker('a')]));
    let enabled = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    scan.mockImplementationOnce(async () => { await gate; return result([blocker('a')]); });
    const loadProject = vi.fn(() => ({ ...project(), settings: { deploy: { enabled } } }) as unknown as Project);
    const r = make({ loadProject });
    const first = r.scan(project(), 'check-again');
    await Promise.resolve();
    const queued = r.scan(project(), 'check-again');
    enabled = true; // the owner set deploy up by hand while the first scan ran
    release();
    await Promise.all([first, queued]);
    expect(scan).toHaveBeenCalledTimes(2);
    expect(loadProject).toHaveBeenCalledTimes(2);
    expect(setUp).not.toHaveBeenCalled();
  });
});

describe('outcome', () => {
  it('a failing scan keeps the old result, sets the error and creates no task', async () => {
    writeReadiness(dir, result([blocker('old')]));
    scan.mockRejectedValueOnce(new Error('secret raw failure'));
    const r = make();
    await r.scan(project(), 'check-again');
    const state = r.state(project());
    expect(state.result?.blockers[0].subject).toBe('old');
    expect(state.error).toBe('The readiness scan failed. Try again.');
    expect(state.scanning).toBe(false);
    expect(created).toEqual([]);
    expect(JSON.stringify(emitted)).not.toContain('secret raw failure');
    expect(emitted.at(-1)?.error).toBe('The readiness scan failed. Try again.');
  });

  it('success writes the result, creates blocker tasks and clears the error', async () => {
    scan.mockResolvedValueOnce(result([blocker('x')]));
    const r = make();
    await r.scan(project(), 'check-again');
    expect(readReadiness(dir)?.blockers).toHaveLength(1);
    expect(created).toHaveLength(1);
    expect(r.state(project()).error).toBeUndefined();
    expect(Object.keys(r.state(project()).tasks)).toEqual(['code:x']);
  });

  it('emits scanning: true, then the final state', async () => {
    await make().scan(project(), 'check-again');
    expect(emitted[0].scanning).toBe(true);
    expect(emitted.at(-1)?.scanning).toBe(false);
    expect(emitted.at(-1)?.result).toBeDefined();
  });
});

describe('automatic setup', () => {
  it('blockers 1 -> 0 with deploy off sets up once', async () => {
    writeReadiness(dir, result([blocker('x')]));
    await make().scan(project(), 'check-again');
    expect(setUp).toHaveBeenCalledTimes(1);
  });

  it('blockers -> none with variable owner items still sets up (values can only be added once it is)', async () => {
    writeReadiness(dir, result([blocker('x')]));
    scan.mockResolvedValue({ ...result([]), owner: [{ kind: 'variable', variable: 'CSRF_SECRET', message: 'x' }] });
    await make().scan(project(), 'check-again');
    expect(setUp).toHaveBeenCalledTimes(1);
    expect(created).toEqual([]);
  });

  it('a workflow-only change counts: unsupported blockers do not', async () => {
    writeReadiness(dir, result([blocker('x')]));
    scan.mockResolvedValueOnce(result([{ key: 'unsupported:go', kind: 'unsupported', subject: 'go', title: 'Go', detail: 'x' }]));
    await make().scan(project(), 'check-again');
    expect(setUp).toHaveBeenCalledTimes(1);
  });

  it('0 -> 0 does not set up', async () => {
    writeReadiness(dir, result([]));
    await make().scan(project(), 'check-again');
    expect(setUp).not.toHaveBeenCalled();
  });

  it('no previous result does not set up', async () => {
    await make().scan(project(), 'check-again');
    expect(setUp).not.toHaveBeenCalled();
  });

  it('blockers remaining does not set up', async () => {
    writeReadiness(dir, result([blocker('x')]));
    scan.mockResolvedValueOnce(result([blocker('y')]));
    await make().scan(project(), 'check-again');
    expect(setUp).not.toHaveBeenCalled();
  });

  it('deploy already enabled does not set up', async () => {
    deploy = { enabled: true };
    writeReadiness(dir, result([blocker('x')]));
    await make().scan(project(), 'check-again');
    expect(setUp).not.toHaveBeenCalled();
  });

  it('R3: does not set up when the project has no team choice and the account has teams', async () => {
    canAutoSetUp.mockResolvedValue(false);
    writeReadiness(dir, result([blocker('x')]));
    await make().scan(project(), 'check-again');
    expect(setUp).not.toHaveBeenCalled();
  });

  it('a setUp that throws does not fail the scan', async () => {
    setUp.mockRejectedValue(new Error('boom'));
    writeReadiness(dir, result([blocker('x')]));
    const r = make();
    await r.scan(project(), 'check-again');
    expect(r.state(project()).error).toBeUndefined();
  });
});

describe('autoSetUpAllowed', () => {
  const p = (deploy: Record<string, unknown> = {}) => ({ id: 'p1', path: '/x', settings: { deploy: { enabled: false, ...deploy } } }) as unknown as Project;
  const deps = (over: Partial<Parameters<typeof autoSetUpAllowed>[1]> = {}) => ({
    vercelTeamCount: vi.fn(async () => 0),
    resolveRepo: vi.fn(async () => ({ owner: 'o', repo: 'r' })),
    repoVisibility: vi.fn(async () => 'private' as const),
    ...over,
  });

  it('allows a private GitHub origin, or no GitHub origin at all (setup makes a private one)', async () => {
    expect(await autoSetUpAllowed(p(), deps())).toBe(true);
    expect(await autoSetUpAllowed(p(), deps({ resolveRepo: vi.fn(async () => null) }))).toBe(true);
  });

  it('refuses a repo recorded as public, without asking GitHub', async () => {
    const d = deps();
    expect(await autoSetUpAllowed(p({ repo: { owner: 'o', repo: 'r', createdByApp: false, public: true } }), d)).toBe(false);
    expect(d.repoVisibility).not.toHaveBeenCalled();
  });

  it('refuses a public origin, or one whose visibility cannot be read', async () => {
    expect(await autoSetUpAllowed(p(), deps({ repoVisibility: vi.fn(async () => 'public' as const) }))).toBe(false);
    expect(await autoSetUpAllowed(p(), deps({ repoVisibility: vi.fn(async () => { throw new Error('403'); }) }))).toBe(false);
    expect(await autoSetUpAllowed(p(), deps({ resolveRepo: vi.fn(async () => { throw new Error('git'); }) }))).toBe(false);
  });

  it('R3: waits for a team choice when the account has teams and none is recorded', async () => {
    expect(await autoSetUpAllowed(p(), deps({ vercelTeamCount: vi.fn(async () => 2) }))).toBe(false);
    expect(await autoSetUpAllowed(p({ vercelTeamId: 'team_1' }), deps({ vercelTeamCount: vi.fn(async () => 2) }))).toBe(true);
  });
});

describe('a rescan that words a known blocker differently (roadmaply, beta.39)', () => {
  const migrations1 = { kind: 'code', subject: 'api migrations', title: 'Prisma migrations never run on deploy', detail: 'd' };
  const migrations2 = { kind: 'code', subject: 'database migrations', title: 'Prisma migrations never run on deploy', detail: 'd' };
  const logo = { kind: 'code', subject: 'logo upload storage', title: 'Uploads use the local filesystem', detail: 'd' };
  let answers: unknown[][];
  let inputs: ScanInput[];
  const realScan = (input: ScanInput) => {
    inputs.push(input);
    const blockers = answers.shift() ?? [];
    return runReadinessScan(input, {
      run: (async () => ({ text: '', output: { blockers, services: [], owner: [] }, session: {} })) as never,
      feature: () => ({ model: 'm', thinkingLevel: 'low' }),
      now: () => new Date('2026-11-12T10:00:00Z'),
    });
  };
  const ledgerTasks = () =>
    (JSON.parse(readFileSync(path.join(dir, '.vibe-teamlead', 'deploy', 'tasks.json'), 'utf-8')).tasks as Array<{ key: string; settled?: boolean }>).map((t) => [t.key, !!t.settled]);

  beforeEach(() => { answers = []; inputs = []; });

  it('reuses the open key: no second task, nothing settled; an unrelated blocker gets its task', async () => {
    answers = [[migrations1], [migrations2, logo]];
    const r = make({ scan: realScan as never });
    await r.scan(project(), 'check-again');
    expect(created).toHaveLength(1);
    tasks[0].status = 'in_progress' as never;
    (tasks[0] as { title: string }).title = 'Prisma migrations never run on deploy';
    await r.scan(project(), 'check-again');
    expect(inputs[1].knownBlockers).toEqual([
      { key: 'code-api-migrations', kind: 'code', subject: 'api migrations', title: 'Prisma migrations never run on deploy' },
    ]);
    expect(readReadiness(dir)?.blockers.map((b) => b.key)).toEqual(['code-api-migrations', 'code-logo-upload-storage']);
    expect(created).toHaveLength(2);
    expect(ledgerTasks()).toEqual([['code-api-migrations', false], ['code-logo-upload-storage', false]]);
  });

  it('knows an open task\'s key even when the saved result lost it', async () => {
    answers = [[migrations1], [], [migrations2]];
    const r = make({ scan: realScan as never });
    await r.scan(project(), 'check-again');
    (tasks[0] as { title: string }).title = 'Prisma migrations never run on deploy';
    tasks[0].status = 'in_progress' as never;
    await r.scan(project(), 'check-again');
    await r.scan(project(), 'check-again');
    expect(inputs[2].knownBlockers).toEqual([{ key: 'code-api-migrations', kind: 'code', title: 'Prisma migrations never run on deploy' }]);
    expect(created).toHaveLength(1);
    expect(ledgerTasks()).toEqual([['code-api-migrations', false]]);
  });

  it('a blocker whose task is done and that is still reported gets a new task as before', async () => {
    answers = [[migrations1], [migrations2]];
    const r = make({ scan: realScan as never });
    await r.scan(project(), 'check-again');
    (tasks[0] as { title: string }).title = 'Prisma migrations never run on deploy';
    tasks[0].status = 'done' as never;
    await r.scan(project(), 'check-again');
    expect(readReadiness(dir)?.blockers.map((b) => b.key)).toEqual(['code-api-migrations']);
    expect(created).toHaveLength(2);
    expect(ledgerTasks()).toEqual([['code-api-migrations', false], ['code-api-migrations', false]]);
  });
});
