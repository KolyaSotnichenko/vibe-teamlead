import { describe, expect, it, vi } from 'vitest';

import { createQueuePause, stopTaskLikeStop, stopAllTasks } from '../task-control';

describe('stopTaskLikeStop (the Stop button path)', () => {
  it('kills the agent, unwatches, stops the task with its plan state and clears restart tracking', () => {
    const task = { id: 't1' };
    const project = { id: 'p1' };
    const deps = {
      killTask: vi.fn(),
      unwatch: vi.fn(async () => undefined),
      findTaskAndProject: vi.fn(() => ({ task, project })),
      hasPlanWithSubtasks: vi.fn(() => true),
      stopTask: vi.fn(),
      prepareForRestart: vi.fn(),
    };
    stopTaskLikeStop('t1', deps as never);
    expect(deps.killTask).toHaveBeenCalledWith('t1');
    expect(deps.unwatch).toHaveBeenCalledWith('t1');
    expect(deps.stopTask).toHaveBeenCalledWith('t1', task, project, true);
    expect(deps.prepareForRestart).toHaveBeenCalledWith('t1');
  });

  it('only kills when the task is unknown', () => {
    const deps = {
      killTask: vi.fn(),
      unwatch: vi.fn(async () => undefined),
      findTaskAndProject: vi.fn(() => ({})),
      hasPlanWithSubtasks: vi.fn(),
      stopTask: vi.fn(),
      prepareForRestart: vi.fn(),
    };
    stopTaskLikeStop('gone', deps as never);
    expect(deps.killTask).toHaveBeenCalled();
    expect(deps.stopTask).not.toHaveBeenCalled();
  });
});

describe('stopAllTasks', () => {
  it('pauses the queue first, then stops every running task', () => {
    const order: string[] = [];
    const pause = createQueuePause();
    pause.onChange((paused) => order.push(`paused:${paused}`));
    const stopped = stopAllTasks({ running: () => ['a', 'b'], stop: (id) => void order.push(`stop:${id}`), pause });
    expect(stopped).toEqual(['a', 'b']);
    expect(order).toEqual(['paused:true', 'stop:a', 'stop:b']);
    expect(pause.isPaused()).toBe(true);
  });
});

describe('queue pause', () => {
  it('reports changes only when the state changes', () => {
    const pause = createQueuePause();
    const heard: boolean[] = [];
    const off = pause.onChange((p) => heard.push(p));
    expect(pause.set(false)).toBe(false);
    expect(pause.set(true)).toBe(true);
    expect(pause.set(true)).toBe(false);
    expect(pause.set(false)).toBe(true);
    off();
    pause.set(true);
    expect(heard).toEqual([true, false]);
  });
});
