import { describe, expect, it, vi } from 'vitest';

import { appEvents } from '../app-events';

describe('app events', () => {
  it('delivers typed events and unsubscribes', () => {
    const listener = vi.fn();
    const off = appEvents.on('task-merged', listener);
    appEvents.emit('task-merged', { taskId: 't1', projectId: 'p1' });
    off();
    appEvents.emit('task-merged', { taskId: 't2', projectId: 'p1' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ taskId: 't1', projectId: 'p1' });
  });

  it('a throwing listener does not reach the emitter', () => {
    const off = appEvents.on('task-stuck', () => {
      throw new Error('boom');
    });
    expect(() => appEvents.emit('task-stuck', { taskId: 't', projectId: 'p' })).not.toThrow();
    off();
  });
});
