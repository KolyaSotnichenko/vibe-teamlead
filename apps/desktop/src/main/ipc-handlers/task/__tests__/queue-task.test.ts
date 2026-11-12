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
import { queueTask } from '../queue-task';

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
