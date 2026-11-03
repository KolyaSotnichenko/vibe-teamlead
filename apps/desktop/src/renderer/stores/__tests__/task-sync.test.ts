/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../../shared/types';
import { syncTasksFromDisk, useTaskStore } from '../task-store';

function task(id: string, status: Task['status'], extra: Partial<Task> = {}): Task {
  return { id, specId: id, projectId: 'p', title: id, description: '', status, subtasks: [], logs: [], createdAt: new Date(), updatedAt: new Date(), ...extra } as Task;
}

describe('syncTasksFromDisk', () => {
  beforeEach(() => {
    useTaskStore.getState().setTasks([task('a', 'in_progress', { logs: ['streamed'] }), task('b', 'queue')]);
  });

  it('applies status changes the window missed, through updateTaskStatus', async () => {
    const changes: string[] = [];
    const unregister = useTaskStore.getState().registerTaskStatusChangeListener((id, from, to) => changes.push(`${id}:${from}->${to}`));
    (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = { ...(window as any).electronAPI, getTasks: vi.fn().mockResolvedValue({ success: true, data: [task('a', 'human_review'), task('b', 'in_progress')] }) };

    await syncTasksFromDisk('p');

    const tasks = useTaskStore.getState().tasks;
    expect(tasks.find((t) => t.id === 'a')?.status).toBe('human_review');
    expect(tasks.find((t) => t.id === 'b')?.status).toBe('in_progress');
    expect(changes).toEqual(['a:in_progress->human_review', 'b:queue->in_progress']);
    unregister();
  });

  it('takes new tasks and keeps streamed logs', async () => {
    (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = { ...(window as any).electronAPI, getTasks: vi.fn().mockResolvedValue({ success: true, data: [task('a', 'in_progress'), task('b', 'queue'), task('c', 'queue')] }) };
    await syncTasksFromDisk('p');
    const tasks = useTaskStore.getState().tasks;
    expect(tasks.map((t) => t.id)).toEqual(['a', 'b', 'c']);
    expect(tasks.find((t) => t.id === 'a')?.logs).toEqual(['streamed']);
  });

  it('does not move a running task back to the backlog (plan file rewritten without status)', async () => {
    (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      ...(window as any).electronAPI,
      getTasks: vi.fn().mockResolvedValue({ success: true, data: [task('a', 'backlog'), task('b', 'queue')] }),
      checkTaskRunning: vi.fn().mockResolvedValue({ success: true, data: true }),
    };
    await syncTasksFromDisk('p');
    expect(useTaskStore.getState().tasks.find((t) => t.id === 'a')?.status).toBe('in_progress');

    // Once its agent has stopped, the file is right
    (window as any).electronAPI.checkTaskRunning = vi.fn().mockResolvedValue({ success: true, data: false });
    await syncTasksFromDisk('p');
    expect(useTaskStore.getState().tasks.find((t) => t.id === 'a')?.status).toBe('backlog');
  });

  it('leaves the board alone when the read fails', async () => {
    (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = { ...(window as any).electronAPI, getTasks: vi.fn().mockResolvedValue({ success: false, error: 'x' }) };
    await syncTasksFromDisk('p');
    expect(useTaskStore.getState().tasks.map((t) => t.status)).toEqual(['in_progress', 'queue']);
  });
});
