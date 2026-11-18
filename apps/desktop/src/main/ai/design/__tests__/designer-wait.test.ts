import { describe, expect, it, vi } from 'vitest';

import { createDesignerWaiter } from '../designer-wait';

const info = { attempt: 2, of: 3, until: Date.parse('2026-11-18T14:05:00Z') };

function setup() {
  const abort = new AbortController();
  const progress = vi.fn();
  const rateLimitWait = vi.fn((_ms: number, _error: string, signal: AbortSignal) => new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })));
  const waiter = createDesignerWaiter({ signal: abort.signal, progress, rateLimitWait });
  return { abort, progress, rateLimitWait, waiter };
}

describe("the designer's wait between tries", () => {
  it('shows the wait on the card (attempt, retry time) while it lasts', async () => {
    const { waiter, progress, rateLimitWait } = setup();
    rateLimitWait.mockImplementationOnce(async () => undefined);
    expect(await waiter.wait(60_000, 'rate_limited', 'Rate limit reached', info)).toBe(true);
    expect(progress).toHaveBeenCalledWith({ kind: 'rate_limited', until: '2026-11-18T14:05:00.000Z', attempt: 2, of: 3 });
    expect(rateLimitWait).toHaveBeenCalledWith(60_000, 'Rate limit reached', expect.any(AbortSignal));
  });

  it("the owner's Stop waiting ends it at once with 'stop'", async () => {
    const { waiter } = setup();
    const pending = waiter.wait(60 * 60_000, 'rate_limited', 'Rate limit reached', info);
    expect(waiter.stopWaiting()).toBe(true);
    expect(await pending).toBe('stop');
    // Nothing waits any more
    expect(waiter.stopWaiting()).toBe(false);
  });

  it('a passing error waits on a timer, and a stopped task ends the wait as cancelled', async () => {
    const { waiter, abort, rateLimitWait } = setup();
    const pending = waiter.wait(60 * 60_000, 'transient', 'Overloaded', info);
    abort.abort();
    expect(await pending).toBe(false);
    expect(rateLimitWait).not.toHaveBeenCalled();
  });

  it('a short passing-error wait runs out and tries again', async () => {
    const { waiter } = setup();
    expect(await waiter.wait(5, 'transient', 'Overloaded', info)).toBe(true);
  });
});
