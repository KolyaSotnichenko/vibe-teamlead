import { describe, expect, it, vi } from 'vitest';

import type { Task } from '../../../shared/types';
import { createQueueProcessor } from '../queue-processor';

const task = (id: string, status: string, createdAt = '2026-01-01T00:00:00Z') => ({ id, specId: id, projectId: 'p', status, createdAt, metadata: {} }) as unknown as Task;

function setup(initial: Task[], options: { limit?: number; paused?: boolean; fail?: string[]; stale?: string[] } = {}) {
  let tasks = initial;
  let limit = options.limit ?? 1;
  let paused = options.paused ?? false;
  const promote = vi.fn(async (taskId: string) => {
    if (options.stale?.includes(taskId)) return { success: false, staleCiTask: true };
    if (options.fail?.includes(taskId)) return { success: false, error: 'no' };
    tasks = tasks.map((t) => (t.id === taskId ? ({ ...t, status: 'in_progress' } as Task) : t));
    return { success: true };
  });
  const onStaleCiTask = vi.fn();
  const processor = createQueueProcessor({ getTasks: () => tasks, limit: () => limit, paused: () => paused, promote, onStaleCiTask });
  return { processor, promote, onStaleCiTask, setLimit: (n: number) => { limit = n; }, setPaused: (p: boolean) => { paused = p; }, tasks: () => tasks };
}

describe('the queue processor', () => {
  it('starts the oldest queued tasks while slots are free, and no more', async () => {
    const s = setup([task('a', 'in_progress'), task('b', 'queue', '2026-01-03T00:00:00Z'), task('c', 'queue', '2026-01-02T00:00:00Z'), task('d', 'queue', '2026-01-04T00:00:00Z')], { limit: 3 });
    await s.processor.process();
    expect(s.promote.mock.calls.map(([id]) => id)).toEqual(['c', 'b']);
  });

  it('starts more when the limit grows', async () => {
    const s = setup([task('a', 'in_progress'), task('b', 'queue')]);
    await s.processor.process();
    expect(s.promote).not.toHaveBeenCalled();
    s.setLimit(2);
    await s.processor.process();
    expect(s.promote).toHaveBeenCalledWith('b');
  });

  it('starts nothing while the queue is paused', async () => {
    const s = setup([task('b', 'queue')], { paused: true });
    await s.processor.process();
    expect(s.promote).not.toHaveBeenCalled();
  });

  it('never starts a task twice when asked again while it runs, and does not miss what changed meanwhile', async () => {
    const s = setup([task('b', 'queue'), task('c', 'queue', '2026-01-02T00:00:00Z')]);
    const first = s.processor.process();
    s.setLimit(2);
    const second = s.processor.process();
    await Promise.all([first, second]);
    expect(s.promote.mock.calls.map(([id]) => id)).toEqual(['b', 'c']);
  });

  it('skips a task that fails to start and goes on; a stale CI task is said', async () => {
    const s = setup([task('b', 'queue'), task('c', 'queue', '2026-01-02T00:00:00Z'), task('d', 'queue', '2026-01-03T00:00:00Z')], { limit: 5, fail: ['b'], stale: ['c'] });
    await s.processor.process();
    expect(s.promote.mock.calls.map(([id]) => id)).toEqual(['b', 'c', 'd']);
    expect(s.onStaleCiTask).toHaveBeenCalledWith(expect.objectContaining({ id: 'c' }));
  });
});
