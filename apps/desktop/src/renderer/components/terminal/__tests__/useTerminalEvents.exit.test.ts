/**
 * @vitest-environment jsdom
 */
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  terminals: new Map<string, { id: string; status: string; launch?: string; isCLIMode?: boolean }>(),
}));
vi.mock('../../../stores/terminal-store', () => ({
  useTerminalStore: {
    getState: () => ({
      getTerminal: (id: string) => store.terminals.get(id),
      setTerminalStatus: (id: string, status: string) => {
        const t = store.terminals.get(id);
        if (t) t.status = status;
      },
      setCLIMode: vi.fn(),
      removeTerminal: (id: string) => store.terminals.delete(id),
    }),
  },
}));

import { useTerminalEvents } from '../useTerminalEvents';

let exitHandler: ((id: string, code: number) => void) | undefined;
const destroyTerminal = vi.fn(async () => undefined);

beforeEach(() => {
  vi.useFakeTimers();
  store.terminals.clear();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    onTerminalExit: (handler: (id: string, code: number) => void) => {
      exitHandler = handler;
      return () => undefined;
    },
    destroyTerminal,
  };
  // Every other terminal event: subscribed, never fired here
  const api = (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI;
  for (const name of ['onTerminalTitleChange', 'onTerminalWorktreeConfigChange', 'onTerminalClaudeSession', 'onTerminalClaudeBusy', 'onTerminalClaudeExit', 'onTerminalPendingResume']) {
    api[name] = () => () => undefined;
  }
});
afterEach(() => vi.useRealTimers());

describe('a terminal whose program ended', () => {
  it('is removed after a moment', () => {
    store.terminals.set('a', { id: 'a', status: 'running' });
    renderHook(() => useTerminalEvents({ terminalId: 'a' }));
    exitHandler?.('a', 0);
    vi.advanceTimersByTime(2500);
    expect(store.terminals.has('a')).toBe(false);
  });

  // setup-token runs as the terminal itself: it ends right after printing the token to copy
  it('stays when it is the "Get a token" terminal, until the owner closes it', () => {
    store.terminals.set('t', { id: 't', status: 'running', launch: 'claude-setup-token' });
    renderHook(() => useTerminalEvents({ terminalId: 't' }));
    exitHandler?.('t', 0);
    vi.advanceTimersByTime(10_000);
    expect(store.terminals.get('t')?.status).toBe('exited');
    expect(destroyTerminal).not.toHaveBeenCalled();
  });
});
