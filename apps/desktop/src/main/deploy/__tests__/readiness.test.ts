import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project, Task } from '../../../shared/types';
import type { ReadinessBlocker, ReadinessResult, ReadinessState } from '../../../shared/types/deploy';
import { createReadiness, type ReadinessDeps } from '../readiness';
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
