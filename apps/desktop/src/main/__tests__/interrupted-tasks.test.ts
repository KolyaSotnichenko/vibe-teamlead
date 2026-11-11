import { describe, expect, it, vi } from 'vitest';

import { interruptedTasks, settleInterruptedTasks } from '../interrupted-tasks';

const task = (id: string, status: string, over: Record<string, unknown> = {}) => ({ id, status, metadata: {}, ...over }) as never;

describe('tasks the last session left running', () => {
  it('are the ones in progress or in QA, not archived ones and not the ones waiting for the owner', () => {
    const tasks = [
      task('a', 'in_progress'),
      task('b', 'ai_review'),
      task('c', 'human_review'),
      task('d', 'backlog'),
      task('e', 'in_progress', { metadata: { archivedAt: '2026-11-01' } }),
      task('f', 'done'),
    ];
    expect(interruptedTasks(tasks).map((t: { id: string }) => t.id)).toEqual(['a', 'b']);
  });

  it('at launch are stopped the way Stop stops them, so they can be resumed, and never restarted', () => {
    const stop = vi.fn();
    const projects = [{ id: 'p1' }, { id: 'p2' }] as never[];
    const tasksOf = (id: string) => (id === 'p1' ? [task('a', 'in_progress'), task('c', 'human_review')] : [task('b', 'ai_review')]);
    const hasPlan = (_p: unknown, t: { id: string }) => t.id === 'a';
    const isRunning = (id: string) => id === 'b';

    const settled = settleInterruptedTasks({ projects, tasksOf, hasPlan, isRunning, stop });

    expect(settled).toBe(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith('a', expect.objectContaining({ id: 'a' }), { id: 'p1' }, true);
  });

  it('one broken project does not keep the others interrupted', () => {
    const stop = vi.fn();
    const tasksOf = (id: string) => {
      if (id === 'bad') throw new Error('unreadable');
      return [task('a', 'in_progress')];
    };
    expect(settleInterruptedTasks({ projects: [{ id: 'bad' }, { id: 'ok' }] as never[], tasksOf, hasPlan: () => false, isRunning: () => false, stop })).toBe(1);
  });
});
