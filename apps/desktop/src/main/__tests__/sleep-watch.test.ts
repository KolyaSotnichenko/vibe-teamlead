import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSleepWatch } from '../sleep-watch';

const MINUTE = 60_000;

function setup(running: string[]) {
  const onSlept = vi.fn();
  const watch = createSleepWatch({ running: () => running, onSlept });
  const sleep = (ms: number) => {
    watch.suspend();
    vi.advanceTimersByTime(ms);
    watch.resume();
  };
  return { onSlept, watch, sleep };
}

describe('the Mac sleeping while agents work', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('tells the user on waking, with how many tasks it held up', () => {
    const { onSlept, sleep } = setup(['a', 'b']);
    sleep(30 * MINUTE);
    expect(onSlept).toHaveBeenCalledExactlyOnceWith({ tasks: 2 });
  });

  it('says nothing when no agent was working', () => {
    const { onSlept, sleep } = setup([]);
    sleep(30 * MINUTE);
    expect(onSlept).not.toHaveBeenCalled();
  });

  it('says nothing about a nap too short to matter', () => {
    const { onSlept, sleep } = setup(['a']);
    sleep(MINUTE);
    expect(onSlept).not.toHaveBeenCalled();
  });

  it('counts what ran when it went to sleep, not what runs on waking', () => {
    const running = ['a'];
    const onSlept = vi.fn();
    const watch = createSleepWatch({ running: () => running, onSlept });
    watch.suspend();
    running.length = 0;
    vi.advanceTimersByTime(30 * MINUTE);
    watch.resume();
    expect(onSlept).toHaveBeenCalledExactlyOnceWith({ tasks: 1 });
  });

  it('a wake without a sleep before it says nothing', () => {
    const { onSlept, watch } = setup(['a']);
    watch.resume();
    expect(onSlept).not.toHaveBeenCalled();
  });
});
