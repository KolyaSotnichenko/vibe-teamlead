import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project, Task } from '../../../../shared/types';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }));

const found: { task?: Task; project?: Project } = {};
vi.mock('../shared', () => ({ findTaskAndProject: () => ({ task: found.task, project: found.project }) }));

const sent: unknown[][] = [];
vi.mock('../../utils', () => ({
  safeSendToRenderer: (_get: unknown, ...args: unknown[]) => { sent.push(args); },
}));

vi.mock('../../../project-store', () => ({ projectStore: { invalidateTasksCache: vi.fn() } }));

import { IPC_CHANNELS } from '../../../../shared/constants';
import { projectStore } from '../../../project-store';
import { queueTask, returnStaleQueuedTask } from '../queue-task';

let dir: string;
const planFile = () => path.join(dir, '.vibe-teamlead', 'specs', '001-x', 'implementation_plan.json');

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'vtl-queue-'));
  sent.length = 0;
  found.project = { id: 'p1', path: dir, autoBuildPath: '.vibe-teamlead' } as unknown as Project;
  found.task = { id: 't1', specId: '001-x', projectId: 'p1', title: 'Fix', description: '', createdAt: new Date(), status: 'backlog' } as unknown as Task;
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('queueTask', () => {
  it('writes status queue to the plan and tells the window', async () => {
    mkdirSync(path.dirname(planFile()), { recursive: true });
    writeFileSync(planFile(), JSON.stringify({ status: 'pending', phases: [] }));
    await queueTask(() => null, 't1');
    const plan = JSON.parse(readFileSync(planFile(), 'utf-8'));
    expect(plan.status).toBe('queue');
    expect(plan.planStatus).toBe('queued');
    expect(sent).toEqual([[IPC_CHANNELS.TASK_STATUS_CHANGE, 't1', 'queue', 'p1']]);
  });

  it('creates the plan when it is missing', async () => {
    vi.mocked(projectStore.invalidateTasksCache).mockClear();
    await queueTask(() => null, 't1');
    expect(JSON.parse(readFileSync(planFile(), 'utf-8')).status).toBe('queue');
    // The task list must read the new plan
    expect(projectStore.invalidateTasksCache).toHaveBeenCalledWith('p1');
    expect(sent).toHaveLength(1);
  });

  it('does nothing for an unknown task', async () => {
    found.task = undefined;
    await queueTask(() => null, 'nope');
    expect(sent).toEqual([]);
  });
});

// F-002: a task the CI check queued must still have its reason when the queue starts it
describe('returnStaleQueuedTask', () => {
  const ciProject = () => ({ ...(found.project as Project), settings: { deploy: { repo: { owner: 'o', repo: 'r' } } } }) as unknown as Project;
  const queuedTask = () => ({ ...(found.task as Task), status: 'queue' }) as Task;
  const writeLedger = (key: string) => {
    const file = path.join(dir, '.vibe-teamlead', 'deploy', 'tasks.json');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ tasks: [{ key, specId: '001-x', at: '2026-11-01T10:00:00Z', kind: 'code' }], handledRuns: [], gaveUp: [] }));
  };
  const writeScan = (keys: string[]) => {
    const file = path.join(dir, '.vibe-teamlead', 'deploy', 'readiness.json');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({
      ci: 1, scannedAt: '2026-11-12T10:00:00Z', owner: [], workflow: {},
      blockers: keys.map((key) => ({ key, kind: 'code', subject: key, title: key, detail: key })),
    }));
  };
  const writePlan = () => {
    mkdirSync(path.dirname(planFile()), { recursive: true });
    writeFileSync(planFile(), JSON.stringify({ status: 'queue', planStatus: 'queued', phases: [] }));
  };

  it('lets a task nobody but the owner made start', async () => {
    writePlan();
    expect(await returnStaleQueuedTask(() => null, queuedTask(), ciProject())).toBeUndefined();
    expect(JSON.parse(readFileSync(planFile(), 'utf-8')).status).toBe('queue');
    expect(sent).toEqual([]);
  });

  it('lets a blocker task start while the saved check still reports the blocker', async () => {
    writePlan(); writeLedger('code:localhost'); writeScan(['code:localhost']);
    expect(await returnStaleQueuedTask(() => null, queuedTask(), ciProject())).toBeUndefined();
    expect(sent).toEqual([]);
  });

  it('puts a blocker task back in Planning when the saved check no longer reports the blocker', async () => {
    writePlan(); writeLedger('code:localhost'); writeScan(['code:other']);
    expect(await returnStaleQueuedTask(() => null, queuedTask(), ciProject())).toBe('blocker-gone');
    expect(JSON.parse(readFileSync(planFile(), 'utf-8')).status).toBe('backlog');
    expect(sent).toEqual([[IPC_CHANNELS.TASK_STATUS_CHANGE, 't1', 'backlog', 'p1']]);
  });

  it('puts it back when CI is no longer set up for the project', async () => {
    writePlan(); writeLedger('code:localhost'); writeScan(['code:localhost']);
    expect(await returnStaleQueuedTask(() => null, queuedTask(), found.project as Project)).toBe('ci-off');
    expect(JSON.parse(readFileSync(planFile(), 'utf-8')).status).toBe('backlog');
  });
});
