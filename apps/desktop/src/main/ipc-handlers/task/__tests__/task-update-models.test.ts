import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers, found } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<{ success: boolean }>>(),
  found: { task: null as unknown, project: null as unknown },
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => Promise<{ success: boolean }>) => handlers.set(channel, fn), on: vi.fn() },
  nativeImage: {},
  app: { getPath: () => tmpdir(), getVersion: () => '0' },
}));
vi.mock('../shared', () => ({ findTaskAndProject: () => found }));
vi.mock('../../../project-store', () => ({ projectStore: { invalidateTasksCache: vi.fn() } }));
vi.mock('../../../title-generator', () => ({ titleGenerator: {} }));
vi.mock('../../../agent', () => ({ AgentManager: class {} }));
vi.mock('../../../utils/worktree-cleanup', () => ({ cleanupWorktree: vi.fn() }));
vi.mock('../../../cli-tool-manager', () => ({ getToolPath: () => 'git' }));
vi.mock('../../../task-state-manager', () => ({ taskStateManager: {} }));
vi.mock('../../../sentry', () => ({ safeBreadcrumb: vi.fn() }));

import { IPC_CHANNELS } from '../../../../shared/constants';
import { registerTaskCRUDHandlers } from '../crud-handlers';

const SPEC = '001-task';
const models = { spec: 'a', planning: 'a', coding: 'a', qa: 'a' };

describe('editing the models of a task', () => {
  beforeEach(() => {
    handlers.clear();
    registerTaskCRUDHandlers({} as never);
  });

  function project(withWorktree: boolean): { main: string; copy: string } {
    const root = mkdtempSync(join(tmpdir(), 'task-update-'));
    const main = join(root, '.vibe-teamlead/specs', SPEC);
    const copy = join(root, '.vibe-teamlead/worktrees/tasks', SPEC, '.vibe-teamlead/specs', SPEC);
    mkdirSync(main, { recursive: true });
    writeFileSync(join(main, 'task_metadata.json'), JSON.stringify({ isAutoProfile: true, phaseModels: models }));
    if (withWorktree) {
      mkdirSync(copy, { recursive: true });
      writeFileSync(join(copy, 'task_metadata.json'), JSON.stringify({ sourceType: 'manual', isAutoProfile: true, phaseModels: models }));
    }
    found.project = { id: 'p', path: root, autoBuildPath: '.vibe-teamlead' };
    found.task = { id: 't', specId: SPEC, title: 'T', description: 'D', metadata: { isAutoProfile: true, phaseModels: models } };
    return { main, copy };
  }
  const update = (metadata: object) => handlers.get(IPC_CHANNELS.TASK_UPDATE)!({}, 't', { metadata });
  const read = (dir: string) => JSON.parse(readFileSync(join(dir, 'task_metadata.json'), 'utf-8'));

  it('reaches the copy a started task reads', async () => {
    const { main, copy } = project(true);
    const phaseModels = { ...models, qa: 'b' };

    expect((await update({ phaseModels, modelsChosen: true })).success).toBe(true);

    expect(read(main).phaseModels.qa).toBe('b');
    expect(read(copy).phaseModels.qa).toBe('b');
    expect(read(copy).modelsChosen).toBe(true);
    expect(read(copy).sourceType).toBe('manual');
  });

  it('works for a task that has no worktree yet', async () => {
    const { main } = project(false);
    expect((await update({ phaseModels: { ...models, qa: 'b' } })).success).toBe(true);
    expect(read(main).phaseModels.qa).toBe('b');
  });
});
