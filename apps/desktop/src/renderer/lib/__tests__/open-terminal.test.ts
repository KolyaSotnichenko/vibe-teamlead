/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import { listenOpenTerminal, openProjectTerminal, openTerminal } from '../open-terminal';

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

describe('openProjectTerminal', () => {
  const terminal = (id: string, status = 'idle') => ({ id, status, projectPath: '/p' });

  it('opens a terminal in the folder when there is room', () => {
    const store = { terminals: [terminal('a')], addTerminal: vi.fn(() => terminal('b')), setActiveTerminal: vi.fn() };
    expect(openProjectTerminal('/p/wt', '/p', store)).toBe('opened');
    expect(store.addTerminal).toHaveBeenCalledWith('/p/wt', '/p');
    expect(store.setActiveTerminal).not.toHaveBeenCalled();
  });

  it("when the project's terminal limit is reached, selects its latest live terminal and says so", () => {
    const store = {
      terminals: [terminal('a'), terminal('other-project'), terminal('b'), terminal('c', 'exited')].map((t) => (t.id === 'other-project' ? { ...t, projectPath: '/q' } : t)),
      addTerminal: vi.fn(() => null),
      setActiveTerminal: vi.fn(),
    };
    expect(openProjectTerminal('/p', '/p', store)).toBe('limit');
    expect(store.setActiveTerminal).toHaveBeenCalledWith('b');
  });

  it('says so even when no live terminal can be selected', () => {
    const store = { terminals: [], addTerminal: vi.fn(() => null), setActiveTerminal: vi.fn() };
    expect(openProjectTerminal('/p', '/p', store)).toBe('limit');
    expect(store.setActiveTerminal).not.toHaveBeenCalled();
  });
});
