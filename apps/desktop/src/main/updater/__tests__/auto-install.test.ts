import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAutoInstall, type AutoInstallState } from '../auto-install';

function setup(running: string[] = [], installs = true) {
  const tasks = { running };
  const states: AutoInstallState[] = [];
  const install = vi.fn(() => installs);
  const auto = createAutoInstall({
    running: () => tasks.running,
    install,
    onState: (state) => states.push(state),
  });
  return { tasks, states, install, auto };
}

describe('installing an update once it has downloaded', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('restarts by itself after a countdown the user can see', () => {
    const { auto, install, states } = setup();
    auto.downloaded('2.0.0');
    expect(states[0]).toEqual({ kind: 'countdown', seconds: 10 });
    expect(install).not.toHaveBeenCalled();

    vi.advanceTimersByTime(9_000);
    expect(states.at(-1)).toEqual({ kind: 'countdown', seconds: 1 });
    expect(install).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_000);
    expect(install).toHaveBeenCalledTimes(1);
  });

  it("waits while agents work: restarting would stop them", () => {
    const { auto, install, states } = setup(['task-1', 'task-2']);
    auto.downloaded('2.0.0');
    expect(states.at(-1)).toEqual({ kind: 'waiting', tasks: 2 });

    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(install).not.toHaveBeenCalled();
  });

  it('starts the countdown when the last agent finishes', () => {
    const { auto, tasks, install, states } = setup(['task-1']);
    auto.downloaded('2.0.0');

    tasks.running = [];
    vi.advanceTimersByTime(15_000);
    expect(states.at(-1)).toEqual({ kind: 'countdown', seconds: 10 });

    vi.advanceTimersByTime(10_000);
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('goes back to waiting when a task starts during the countdown', () => {
    const { auto, tasks, install, states } = setup();
    auto.downloaded('2.0.0');

    vi.advanceTimersByTime(5_000);
    tasks.running = ['task-1'];
    vi.advanceTimersByTime(30_000);

    expect(states.at(-1)).toEqual({ kind: 'waiting', tasks: 1 });
    expect(install).not.toHaveBeenCalled();
  });

  it('never restarts after the user chose later', () => {
    const { auto, install, states } = setup();
    auto.downloaded('2.0.0');
    auto.postpone();
    expect(states.at(-1)).toEqual({ kind: 'idle' });

    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(install).not.toHaveBeenCalled();
  });

  it("doesn't ask again for the same version: update checks repeat", () => {
    const { auto, install, states } = setup();
    auto.downloaded('2.0.0');
    auto.postpone();
    const seen = states.length;

    auto.downloaded('2.0.0');
    vi.advanceTimersByTime(60_000);
    expect(states).toHaveLength(seen);
    expect(install).not.toHaveBeenCalled();
  });

  it('offers a newer version after the last one was put off', () => {
    const { auto, install } = setup();
    auto.downloaded('2.0.0');
    auto.postpone();

    auto.downloaded('2.0.1');
    vi.advanceTimersByTime(10_000);
    expect(install).toHaveBeenCalledTimes(1);
  });

  it("runs one countdown when the same update is reported twice", () => {
    const { auto, install } = setup();
    auto.downloaded('2.0.0');
    vi.advanceTimersByTime(4_000);
    auto.downloaded('2.0.0');
    vi.advanceTimersByTime(6_000);
    expect(install).toHaveBeenCalledTimes(1);
  });

  it("stops when the app can't install from where it runs", () => {
    const { auto, install, states } = setup([], false);
    auto.downloaded('2.0.0');
    vi.advanceTimersByTime(60_000);
    expect(install).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toEqual({ kind: 'idle' });
  });

  it('stops instead of crashing the app when installing throws', () => {
    const states: AutoInstallState[] = [];
    const auto = createAutoInstall({
      running: () => [],
      install: () => {
        throw new Error('no update');
      },
      onState: (state) => states.push(state),
    });
    auto.downloaded('2.0.0');
    vi.advanceTimersByTime(10_000);
    expect(states.at(-1)).toEqual({ kind: 'idle' });
  });

  it('stops without a word when cancelled by quitting or a channel change', () => {
    const { auto, install } = setup();
    auto.downloaded('2.0.0');
    auto.cancel();
    vi.advanceTimersByTime(60_000);
    expect(install).not.toHaveBeenCalled();
  });
});
