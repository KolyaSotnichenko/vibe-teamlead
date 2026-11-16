import { describe, expect, it, vi } from 'vitest';

import { claimSingleInstance, focusWindow, removesAppMenu } from '../app-instance';

function fakeApp(gotLock: boolean) {
  const listeners: Record<string, () => void> = {};
  return {
    listeners,
    requestSingleInstanceLock: vi.fn(() => gotLock),
    on: vi.fn((event: string, listener: () => void) => {
      listeners[event] = listener;
    }),
    exit: vi.fn(),
  };
}

describe('claimSingleInstance', () => {
  it('a second launch exits at once and nothing else runs', () => {
    const app = fakeApp(false);
    expect(claimSingleInstance(app, vi.fn())).toBe(false);
    expect(app.exit).toHaveBeenCalledWith(0);
    expect(app.on).not.toHaveBeenCalled();
  });

  it('the first instance keeps the lock and focuses its window when the app is launched again', () => {
    const app = fakeApp(true);
    const focus = vi.fn();
    expect(claimSingleInstance(app, focus)).toBe(true);
    expect(app.exit).not.toHaveBeenCalled();
    app.listeners['second-instance']();
    expect(focus).toHaveBeenCalledTimes(1);
  });
});

describe('focusWindow', () => {
  const win = (minimized: boolean, destroyed = false) => ({
    isDestroyed: () => destroyed,
    isMinimized: () => minimized,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  });

  it('restores a minimized window, shows and focuses it', () => {
    const w = win(true);
    focusWindow(w);
    expect(w.restore).toHaveBeenCalled();
    expect(w.show).toHaveBeenCalled();
    expect(w.focus).toHaveBeenCalled();
  });

  it('does nothing without a live window', () => {
    expect(() => focusWindow(null)).not.toThrow();
    const gone = win(false, true);
    focusWindow(gone);
    expect(gone.focus).not.toHaveBeenCalled();
  });
});

describe('removesAppMenu', () => {
  it('drops the default menu only in a packaged Windows build', () => {
    expect(removesAppMenu('win32', false)).toBe(true);
    expect(removesAppMenu('win32', true)).toBe(false);
    expect(removesAppMenu('darwin', false)).toBe(false);
    expect(removesAppMenu('linux', false)).toBe(false);
  });
});
