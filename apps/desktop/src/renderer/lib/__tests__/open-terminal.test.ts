/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import { listenOpenTerminal, openTerminal } from '../open-terminal';

describe('openTerminal', () => {
  it('asks the app for a terminal in a folder, until the listener unsubscribes', () => {
    const handler = vi.fn();
    const off = listenOpenTerminal(handler);
    openTerminal('/projects/planner');
    expect(handler).toHaveBeenCalledWith('/projects/planner');
    off();
    openTerminal('/elsewhere');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('ignores an event without a folder', () => {
    const handler = vi.fn();
    const off = listenOpenTerminal(handler);
    window.dispatchEvent(new CustomEvent('open-terminal', { detail: '' }));
    window.dispatchEvent(new CustomEvent('open-terminal'));
    expect(handler).not.toHaveBeenCalled();
    off();
  });
});
