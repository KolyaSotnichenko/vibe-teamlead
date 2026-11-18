/**
 * The queue settings (Settings → Project → Queue): the limit's validation, and what a save
 * does besides writing — turning auto-merge on offers the tasks QA approved that already wait.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mergeable, tasks } = vi.hoisted(() => ({
  mergeable: vi.fn(async (list: unknown[]) => list),
  tasks: [] as Array<{ id: string; title: string; projectId: string; status: string }>,
}));
vi.mock('../../hooks/useAutoMerge', () => ({ getAutoMerge: () => ({ mergeable }) }));
vi.mock('../../stores/task-store', () => ({ useTaskStore: { getState: () => ({ tasks }) } }));

import { maxParallelError, queueSettingsError, queueSettingsSaved, useMergeWaitingStore } from '../queue-settings';

beforeEach(() => {
  mergeable.mockClear();
  tasks.length = 0;
  useMergeWaitingStore.setState({ tasks: [] });
});

describe('maxParallelError', () => {
  it('accepts 1 to the maximum', () => {
    expect(maxParallelError(1)).toBeNull();
    expect(maxParallelError(3)).toBeNull();
  });

  it('refuses less than one and more than the maximum', () => {
    expect(maxParallelError(0)).toBe('tasks:queue.settings.minValueError');
    expect(maxParallelError(4)).toBe('tasks:queue.settings.maxValueError');
  });
});

describe('queueSettingsError', () => {
  it('checks the limit only when it changed, so an old saved value does not block other settings', () => {
    expect(queueSettingsError({ maxParallelTasks: 5 }, { maxParallelTasks: 5 })).toBeNull();
    expect(queueSettingsError({ maxParallelTasks: 1 }, { maxParallelTasks: 4 })).toBe('tasks:queue.settings.maxValueError');
    expect(queueSettingsError({}, { maxParallelTasks: 0 })).toBe('tasks:queue.settings.minValueError');
  });
});

describe('queueSettingsSaved', () => {
  const waiting = { id: 't1', title: 'One', projectId: 'p1', status: 'human_review' };

  it('offers the approved tasks that wait when auto-merge was just turned on', async () => {
    tasks.push(waiting, { id: 't2', title: 'Two', projectId: 'p2', status: 'human_review' }, { id: 't3', title: 'Three', projectId: 'p1', status: 'queue' });
    await queueSettingsSaved('p1', { autoMerge: false }, { autoMerge: true });
    expect(mergeable).toHaveBeenCalledWith([waiting]);
    expect(useMergeWaitingStore.getState().tasks).toEqual([waiting]);
  });

  it('offers nothing when auto-merge was already on, or stays off', async () => {
    tasks.push(waiting);
    await queueSettingsSaved('p1', { autoMerge: true }, { autoMerge: true });
    await queueSettingsSaved('p1', {}, { autoMerge: false });
    expect(mergeable).not.toHaveBeenCalled();
    expect(useMergeWaitingStore.getState().tasks).toEqual([]);
  });
});
