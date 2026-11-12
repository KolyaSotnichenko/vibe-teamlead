import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Project, Task, TaskMetadata } from '../../../shared/types';
import type { ReadinessBlocker } from '../../../shared/types/deploy';
import { tryLoadPrompt } from '../../ai/prompts/prompt-loader';
import { createBlockerTasks, createRunFixTask, deployTaskStatus, isDeployTask, type DeployTaskDeps } from '../deploy-tasks';

let dir: string;
let tasks: Task[];
let started: string[];
let created: Array<{ title: string; description: string; metadata: TaskMetadata }>;
const project = () => ({ id: 'p1', path: dir, settings: {} }) as unknown as Project;
const ledger = () => path.join(dir, '.vibe-teamlead', 'deploy', 'tasks.json');

function deps(): DeployTaskDeps {
  return {
    getTasks: () => tasks,
    createTask: async (_p, title, description, metadata) => {
      const t = { id: `t${tasks.length + 1}`, specId: `00${tasks.length + 1}-x`, status: 'backlog', metadata } as unknown as Task;
      tasks.push(t);
      created.push({ title, description, metadata });
      return t;
    },
    startTask: async (id) => { started.push(id); },
    defaultModels: () => ({ model: 'm' } as Partial<TaskMetadata>),
    now: () => new Date('2026-11-12T10:00:00Z'),
  };
}

const code: ReadinessBlocker = { key: 'code:localhost', kind: 'code', subject: 'localhost', title: 'Hardcoded localhost', detail: 'api.ts uses localhost:3000' };
const wf: ReadinessBlocker = { key: 'workflow:ci', kind: 'workflow', subject: 'ci', title: 'Add CI workflow', detail: 'No workflow found.' };
const unsupported: ReadinessBlocker = { key: 'unsupported:go', kind: 'unsupported', subject: 'go', title: 'Go', detail: 'x' };
const FIXED = 'Found by the Deploy readiness scan; fix what blocks deploying to Vercel. Don\'t delete, skip or weaken tests.';

beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'dtasks-')); tasks = []; started = []; created = []; });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('createBlockerTasks', () => {
  it('creates and starts one task per blocker', async () => {
    const keys = await createBlockerTasks(project(), [code, wf], deps());
    expect(keys).toEqual(['code:localhost', 'workflow:ci']);
    expect(started).toEqual(['t1', 't2']);
    expect(created[0].metadata).toMatchObject({ model: 'm', sourceType: 'deploy', priority: 'high', deployKey: 'code:localhost', category: 'bug_fix' });
    expect(created[1].metadata.category).toBe('infrastructure');
  });

  it('creates nothing again while tasks are open', async () => {
    await createBlockerTasks(project(), [code, wf], deps());
    expect(await createBlockerTasks(project(), [code, wf], deps())).toEqual([]);
    expect(tasks).toHaveLength(2);
  });

  it('creates a new task for a key whose task is done', async () => {
    await createBlockerTasks(project(), [code, wf], deps());
    tasks[0].status = 'done';
    expect(await createBlockerTasks(project(), [code, wf], deps())).toEqual(['code:localhost']);
    expect(tasks).toHaveLength(3);
  });

  it('skips unsupported blockers', async () => {
    expect(await createBlockerTasks(project(), [unsupported], deps())).toEqual([]);
    expect(tasks).toHaveLength(0);
  });

  it('composes the descriptions exactly', async () => {
    await createBlockerTasks(project(), [code, wf], deps());
    const rules = tryLoadPrompt('deploy_workflow_rules');
    expect(rules).toContain('browser-mode unit tests');
    expect(created[0].title).toBe('Hardcoded localhost');
    expect(created[0].description).toBe(`api.ts uses localhost:3000\n\n${FIXED}`);
    expect(created[1].description).toBe(`No workflow found.\n\n${FIXED}\n\n${rules}`);
  });

  it('creates one task for two concurrent calls with the same key', async () => {
    await Promise.all([createBlockerTasks(project(), [code], deps()), createBlockerTasks(project(), [code], deps())]);
    expect(tasks).toHaveLength(1);
  });

  it('treats a garbage ledger as empty and keeps handledRuns', async () => {
    mkdirSync(path.dirname(ledger()), { recursive: true });
    writeFileSync(ledger(), '{{not json');
    expect(await createBlockerTasks(project(), [code], deps())).toEqual(['code:localhost']);
    expect(JSON.parse(readFileSync(ledger(), 'utf-8'))).toMatchObject({ tasks: [{ key: 'code:localhost' }], handledRuns: [] });
  });

  it('preserves handledRuns and keeps the last 200 tasks', async () => {
    mkdirSync(path.dirname(ledger()), { recursive: true });
    const old = Array.from({ length: 200 }, (_, i) => ({ key: `k${i}`, specId: `s${i}`, at: 'x' }));
    writeFileSync(ledger(), JSON.stringify({ tasks: old, handledRuns: [5, 6] }));
    await createBlockerTasks(project(), [code], deps());
    const l = JSON.parse(readFileSync(ledger(), 'utf-8'));
    expect(l.tasks).toHaveLength(200);
    expect(l.tasks[199].key).toBe('code:localhost');
    expect(l.handledRuns).toEqual([5, 6]);
  });
});

describe('createRunFixTask', () => {
  it('creates an urgent bug_fix task once while open', async () => {
    const fix = { key: 'run:7', title: 'Fix CI', description: 'it fails' };
    expect(await createRunFixTask(project(), fix, deps())).toBe(true);
    expect(created[0]).toMatchObject({ title: 'Fix CI', description: 'it fails' });
    expect(created[0].metadata).toMatchObject({ priority: 'urgent', category: 'bug_fix', sourceType: 'deploy', deployKey: 'run:7' });
    expect(started).toEqual(['t1']);
    expect(await createRunFixTask(project(), fix, deps())).toBe(false);
  });
});

describe('deployTaskStatus', () => {
  it('maps keys to spec and status', async () => {
    await createBlockerTasks(project(), [code], deps());
    expect(deployTaskStatus(project(), () => tasks)).toEqual({ 'code:localhost': { specId: '001-x', status: 'backlog' } });
  });
});

describe('isDeployTask', () => {
  it('is true for a spec the ledger recorded', async () => {
    await createBlockerTasks(project(), [code], deps());
    expect(isDeployTask(dir, '001-x')).toBe(true);
  });

  it('is false for a spec the ledger does not hold, even one marked deploy in its metadata', async () => {
    await createBlockerTasks(project(), [code], deps());
    expect(isDeployTask(dir, '999-other')).toBe(false);
  });

  it('is false when there is no ledger', () => {
    expect(isDeployTask(dir, '001-x')).toBe(false);
  });

  it.each([
    ['garbage JSON', 'not json{'],
    ['tasks that is not a list', JSON.stringify({ tasks: 'x', handledRuns: [] })],
    ['entries that are not objects', JSON.stringify({ tasks: [null, 5, 'x'], handledRuns: [] })],
  ])('is false for a ledger with %s', (_name, content) => {
    mkdirSync(path.dirname(ledger()), { recursive: true });
    writeFileSync(ledger(), content);
    expect(isDeployTask(dir, '001-x')).toBe(false);
  });
});
