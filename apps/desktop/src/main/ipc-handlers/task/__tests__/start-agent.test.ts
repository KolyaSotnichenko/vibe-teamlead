import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const worktree = vi.hoisted(() => ({ path: null as string | null }));
vi.mock('../../../worktree-paths', () => ({ findTaskWorktree: () => worktree.path }));
const watcher = vi.hoisted(() => ({ watch: vi.fn(async () => undefined) }));
vi.mock('../../../file-watcher', () => ({ fileWatcher: watcher }));

import type { Project, Task } from '../../../../shared/types';
import { specDirForWatcher, watchAndStartAgent } from '../start-agent';

let dir: string;
const agent = { startSpecCreation: vi.fn(), startTaskExecution: vi.fn() };
const project = () => ({ id: 'p1', path: dir, autoBuildPath: '.vibe-teamlead', settings: { mainBranch: 'develop' } }) as unknown as Project;
const task = (over: Record<string, unknown> = {}) =>
  ({ id: '001-x', specId: '001-x', title: 'Title', description: 'Do the thing', metadata: { useWorktree: true, pushNewBranches: false }, ...over }) as unknown as Task;
const specDir = () => path.join(dir, '.vibe-teamlead', 'specs', '001-x');

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'vtl-start-'));
  mkdirSync(specDir(), { recursive: true });
  worktree.path = null;
  vi.clearAllMocks();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// F-023: this was written three times in the execution handlers (start, start from the queue, recovery)
describe('watchAndStartAgent', () => {
  it('a task without a spec starts spec creation, with its description, folder, settings and base branch', () => {
    expect(watchAndStartAgent(agent as never, '001-x', task(), project(), specDir(), '[T]')).toBe('spec');
    expect(agent.startSpecCreation).toHaveBeenCalledWith('001-x', dir, 'Do the thing', specDir(), { useWorktree: true, pushNewBranches: false }, 'develop', 'p1');
    expect(agent.startTaskExecution).not.toHaveBeenCalled();
  });

  it('falls back to the title when the task has no description', () => {
    watchAndStartAgent(agent as never, '001-x', task({ description: '' }), project(), specDir(), '[T]');
    expect(agent.startSpecCreation.mock.calls[0][2]).toBe('Title');
  });

  it('a task with a spec starts the build (which plans first when the plan has no subtasks)', () => {
    writeFileSync(path.join(specDir(), 'spec.md'), '# Spec');
    expect(watchAndStartAgent(agent as never, '001-x', task({ metadata: { baseBranch: 'release', useLocalBranch: true } }), project(), specDir(), '[T]')).toBe('build');
    expect(agent.startTaskExecution).toHaveBeenCalledWith(
      '001-x', dir, '001-x',
      { parallel: false, workers: 1, baseBranch: 'release', useWorktree: undefined, useLocalBranch: true, pushNewBranches: undefined },
      'p1',
    );
    expect(agent.startSpecCreation).not.toHaveBeenCalled();
  });

  it("watches the plan in the project's spec folder, or in the worktree once the plan is there", () => {
    watchAndStartAgent(agent as never, '001-x', task(), project(), specDir(), '[T]');
    expect(watcher.watch).toHaveBeenLastCalledWith('001-x', specDir());

    worktree.path = path.join(dir, 'wt');
    const inWorktree = path.join(worktree.path, '.vibe-teamlead', 'specs', '001-x');
    mkdirSync(inWorktree, { recursive: true });
    expect(specDirForWatcher(dir, '.vibe-teamlead/specs', '001-x')).toBe(specDir());
    writeFileSync(path.join(inWorktree, 'implementation_plan.json'), '{}');
    watchAndStartAgent(agent as never, '001-x', task(), project(), specDir(), '[T]');
    expect(watcher.watch).toHaveBeenLastCalledWith('001-x', inWorktree);
  });

  it('a watcher that fails does not stop the start', async () => {
    watcher.watch.mockRejectedValueOnce(new Error('too many files'));
    expect(() => watchAndStartAgent(agent as never, '001-x', task(), project(), specDir(), '[T]')).not.toThrow();
    await Promise.resolve();
    expect(agent.startSpecCreation).toHaveBeenCalled();
  });
});
