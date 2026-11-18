/**
 * @vitest-environment jsdom
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project, Task } from '../../../shared/types';
import { useProjectStore } from '../../stores/project-store';
import { useQueuePauseStore } from '../../stores/queue-pause-store';
import { useTaskStore } from '../../stores/task-store';

const promoted: string[] = [];
vi.mock('../../stores/task-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/task-store')>();
  return {
    ...actual,
    persistTaskStatus: vi.fn(async (taskId: string) => {
      promoted.push(taskId);
      actual.useTaskStore.setState((state) => ({ tasks: state.tasks.map((t) => (t.id === taskId ? ({ ...t, status: 'in_progress' } as Task) : t)) }));
      return { success: true };
    }),
  };
});

import { useQueueProcessor } from '../useQueueProcessor';

const task = (id: string, status: string, createdAt = '2026-01-01T00:00:00Z') => ({ id, specId: id, projectId: 'p', status, createdAt, metadata: {} }) as unknown as Task;
const project = (maxParallelTasks: number) => ({ id: 'p', name: 'p', path: '/p', settings: { maxParallelTasks } }) as unknown as Project;

beforeEach(() => {
  promoted.length = 0;
  useQueuePauseStore.setState({ paused: false });
  useProjectStore.setState({ projects: [project(1)] });
  useTaskStore.setState({ tasks: [task('a', 'in_progress'), task('b', 'queue'), task('c', 'queue', '2026-01-02T00:00:00Z')] });
});
afterEach(() => cleanup());

describe('useQueueProcessor, at the app level', () => {
  it('starts queued tasks when the parallel limit grows, with no board open', async () => {
    renderHook(() => useQueueProcessor());
    await act(async () => {});
    expect(promoted).toEqual([]);
    await act(async () => { useProjectStore.setState({ projects: [project(3)] }); });
    await vi.waitFor(() => expect(promoted).toEqual(['b', 'c']));
  });

  it('fills a slot that comes free, and starts nothing while the queue is paused', async () => {
    useQueuePauseStore.setState({ paused: true });
    renderHook(() => useQueueProcessor());
    await act(async () => { useTaskStore.setState((state) => ({ tasks: state.tasks.map((t) => (t.id === 'a' ? ({ ...t, status: 'done' } as Task) : t)) })); });
    expect(promoted).toEqual([]);
    await act(async () => { useQueuePauseStore.setState({ paused: false }); });
    await vi.waitFor(() => expect(promoted).toEqual(['b']));
  });
});
