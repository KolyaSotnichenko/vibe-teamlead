/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/terminal-buffer-manager', () => ({
  terminalBufferManager: { append: vi.fn(), getSize: vi.fn(() => 0), get: vi.fn(() => ''), set: vi.fn(), clear: vi.fn(), dispose: vi.fn() },
}));
vi.mock('../../../shared/utils/debug-logger', () => ({ debugLog: vi.fn(), debugError: vi.fn() }));

import { useTerminalStore } from '../terminal-store';

describe('addTerminal launch', () => {
  it('keeps what main should run in the new terminal; a plain terminal has none', () => {
    const store = useTerminalStore.getState();
    const plain = store.addTerminal('/p', '/p');
    const setup = store.addTerminal('/p', '/p', 'claude-setup-token');
    expect(plain?.launch).toBeUndefined();
    expect(setup?.launch).toBe('claude-setup-token');
    expect(useTerminalStore.getState().getTerminal(setup!.id)?.launch).toBe('claude-setup-token');
  });
});
