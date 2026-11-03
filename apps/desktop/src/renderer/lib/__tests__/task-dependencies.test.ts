import { describe, expect, it } from 'vitest';

import type { Task } from '../../../shared/types';
import { isReadyToStart, unfinishedDependencies } from '../task-dependencies';

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
