import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { flushRendererBeforeQuit } from '../settings-flush';

const CH = { request: 'settings:flushBeforeQuit', done: 'settings:flushedBeforeQuit' };

function fakes(reply: 'at-once' | 'never' | 'wrong-id') {
  const ipc = new EventEmitter();
  const send = vi.fn((_channel: string, ...args: unknown[]) => {
    const id = args[0] as string;
    if (reply === 'at-once') setTimeout(() => ipc.emit(CH.done, {}, id), 5);
    if (reply === 'wrong-id') setTimeout(() => ipc.emit(CH.done, {}, 'other'), 5);
  });
  return { ipc, win: { isDestroyed: () => false, webContents: { send, isDestroyed: () => false } }, send };
}

// Quitting with Settings open lost the open section's changes: the page saves first
describe('flushing the settings before quit', () => {
  it('asks the window and waits for its answer', async () => {
    const { ipc, win, send } = fakes('at-once');
    const started = Date.now();
    await expect(flushRendererBeforeQuit(win, ipc, 2000)).resolves.toBe('flushed');
    expect(send).toHaveBeenCalledWith(CH.request, expect.any(String));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(ipc.listenerCount(CH.done)).toBe(0);
  });

  it('never holds the quit longer than the timeout', async () => {
    const { ipc, win } = fakes('never');
    await expect(flushRendererBeforeQuit(win, ipc, 30)).resolves.toBe('timeout');
    expect(ipc.listenerCount(CH.done)).toBe(0);
  });

  it('ignores an answer to another request', async () => {
    const { ipc, win } = fakes('wrong-id');
    await expect(flushRendererBeforeQuit(win, ipc, 60)).resolves.toBe('timeout');
  });

  it('without a window there is nothing to wait for', async () => {
    const { ipc } = fakes('never');
    await expect(flushRendererBeforeQuit(null, ipc, 2000)).resolves.toBe('no-window');
    await expect(flushRendererBeforeQuit({ isDestroyed: () => true, webContents: { send: vi.fn(), isDestroyed: () => true } }, ipc, 2000)).resolves.toBe('no-window');
  });
});
