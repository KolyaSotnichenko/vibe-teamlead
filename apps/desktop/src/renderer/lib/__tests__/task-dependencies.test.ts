import { describe, expect, it } from 'vitest';

import type { Task } from '../../../shared/types';
import { isReadyToStart, nextQueuedToStart, unfinishedDependencies } from '../task-dependencies';

const task = (specId: string, status: Task['status'], dependencies?: string[]): Task =>
  ({ id: specId, specId, projectId: 'p', title: specId, description: '', status, subtasks: [], logs: [], metadata: { dependencies }, createdAt: new Date(), updatedAt: new Date() }) as Task;

describe('task dependencies', () => {
  it('waits for every dependency to be done; unknown ones do not block', () => {
    const tasks = [task('001-model', 'done'), task('002-editor', 'human_review'), task('003-send', 'queue', ['001-model', '002-editor', '999-gone'])];
    expect(unfinishedDependencies(tasks[2], tasks).map((t) => t.specId)).toEqual(['002-editor']);
    expect(isReadyToStart(tasks[2], tasks)).toBe(false);
    tasks[1] = task('002-editor', 'done');
    expect(isReadyToStart(tasks[2], tasks)).toBe(true);
    expect(isReadyToStart(task('004-x', 'queue'), tasks)).toBe(true);
  });
});

describe('nextQueuedToStart', () => {
  const at = (t: Task, minute: number): Task => ({ ...t, createdAt: new Date(2026, 10, 12, 10, minute) });

  it('starts queued tasks only up to the limit, oldest first', () => {
    // Five blocker tasks a Deploy scan queued, limit 1
    const tasks = [5, 4, 3, 2, 1].map((n) => at(task(`00${n}-blocker`, 'queue'), n));
    const first = nextQueuedToStart(tasks, 1);
    expect(first?.specId).toBe('001-blocker');
    // It started: the slot is taken, nothing else starts
    const running = tasks.map((t) => (t === first ? { ...t, status: 'in_progress' as const } : t));
    expect(nextQueuedToStart(running, 1)).toBeUndefined();
    // A limit of 2 lets the next oldest in
    expect(nextQueuedToStart(running, 2)?.specId).toBe('002-blocker');
  });

  it('skips tasks whose dependencies are open, archived ones and ones already tried', () => {
    const tasks = [
      at(task('001-dep', 'backlog'), 1),
      at(task('002-waits', 'queue', ['001-dep']), 2),
      { ...at(task('003-archived', 'queue'), 3), metadata: { archivedAt: '2026-11-12' } } as Task,
      at(task('004-failed', 'queue'), 4),
      at(task('005-next', 'queue'), 5),
    ];
    expect(nextQueuedToStart(tasks, 1, new Set(['004-failed']))?.specId).toBe('005-next');
  });
});
