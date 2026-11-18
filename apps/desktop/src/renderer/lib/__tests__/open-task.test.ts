/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import { listenOpenTask, openTask } from '../open-task';

describe('open-task event', () => {
  it('reaches the listener with the task id until it unsubscribes', () => {
    const handler = vi.fn();
    const stop = listenOpenTask(handler);
    openTask('t1');
    expect(handler).toHaveBeenCalledWith('t1');
    stop();
    openTask('t2');
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
