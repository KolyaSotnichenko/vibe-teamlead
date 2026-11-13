/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

import { usePolling } from '../usePolling';

let visibility: DocumentVisibilityState = 'visible';
const show = (state: DocumentVisibilityState) => {
  visibility = state;
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
};

beforeEach(() => {
  vi.useFakeTimers();
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('usePolling', () => {
  it('calls the function every interval, and not at once (the first call is the caller\'s)', () => {
    const tick = vi.fn();
    renderHook(() => usePolling(tick, 1000));
    expect(tick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3000);
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it('does nothing while the window is hidden, and calls once as soon as it shows again', () => {
    const tick = vi.fn();
    renderHook(() => usePolling(tick, 1000));
    show('hidden');
    vi.advanceTimersByTime(10_000);
    expect(tick).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    show('visible');
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('starts hidden without a timer', () => {
    visibility = 'hidden';
    const tick = vi.fn();
    renderHook(() => usePolling(tick, 1000));
    vi.advanceTimersByTime(5000);
    expect(tick).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start a call while the one before it is still running', async () => {
    let finish!: () => void;
    const tick = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    renderHook(() => usePolling(tick, 1000));
    vi.advanceTimersByTime(3000);
    expect(tick).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); });
    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('goes on after a call that failed', async () => {
    const tick = vi.fn(() => Promise.reject(new Error('offline')));
    renderHook(() => usePolling(tick, 1000));
    vi.advanceTimersByTime(1000);
    await act(async () => { await Promise.resolve(); });
    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('does nothing while disabled, and stops when it is turned off or goes away', () => {
    const tick = vi.fn();
    const { rerender, unmount } = renderHook(({ on }) => usePolling(tick, 1000, on), { initialProps: { on: false } });
    vi.advanceTimersByTime(3000);
    expect(tick).not.toHaveBeenCalled();
    rerender({ on: true });
    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(1);
    rerender({ on: false });
    vi.advanceTimersByTime(3000);
    expect(tick).toHaveBeenCalledTimes(1);
    rerender({ on: true });
    unmount();
    vi.advanceTimersByTime(3000);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('always calls the newest function without restarting the timer', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ fn }) => usePolling(fn, 1000), { initialProps: { fn: first } });
    vi.advanceTimersByTime(600);
    rerender({ fn: second });
    vi.advanceTimersByTime(400);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
