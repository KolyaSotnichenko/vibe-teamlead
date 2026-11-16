import { describe, expect, it, vi } from 'vitest';

import type { BotApi, TelegramUpdate } from '../bot-api';
import { TelegramApiError } from '../bot-api';
import { createPoller, type PollerState } from '../poller';

type Step = TelegramUpdate[] | TelegramApiError;

function scripted(steps: Step[], onEmpty: () => void) {
  const offsets: Array<number | undefined> = [];
  const api = {
    getUpdates: vi.fn(async (offset: number | undefined) => {
      offsets.push(offset);
      const step = steps.shift();
      if (!step) {
        onEmpty();
        return [];
      }
      if (step instanceof TelegramApiError) throw step;
      return step;
    }),
  } as unknown as BotApi;
  return { api, offsets };
}

const u = (id: number): TelegramUpdate => ({ update_id: id });

describe('poller', () => {
  it('passes batches on and advances the offset past the last update', async () => {
    const batches: number[][] = [];
    let poller: ReturnType<typeof createPoller> | undefined;
    const { api, offsets } = scripted([[u(5), u(6)], [u(9)]], () => void poller?.stop());
    poller = createPoller({ api, onBatch: async (ups) => void batches.push(ups.map((x) => x.update_id)), onState: () => undefined, sleep: async () => undefined });
    await poller.start();
    await poller.done();
    expect(batches).toEqual([[5, 6], [9]]);
    expect(offsets.slice(0, 3)).toEqual([undefined, 7, 10]);
  });

  it('stops on a bad token and reports it', async () => {
    const states: PollerState[] = [];
    const { api } = scripted([new TelegramApiError('unauthorized', 'no')], () => undefined);
    const poller = createPoller({ api, onBatch: async () => undefined, onState: (s) => void states.push(s), sleep: async () => undefined });
    await poller.start();
    await poller.done();
    expect(states.at(-1)).toEqual({ connection: 'error', error: 'bad_token' });
    expect(api.getUpdates).toHaveBeenCalledTimes(1);
  });

  it('waits retry_after on 429, backs off on network errors, and waits on 409', async () => {
    const waits: number[] = [];
    const states: PollerState[] = [];
    let poller: ReturnType<typeof createPoller> | undefined;
    const { api } = scripted(
      [
        new TelegramApiError('rate_limited', 'slow', 7),
        new TelegramApiError('network', 'x'),
        new TelegramApiError('network', 'x'),
        new TelegramApiError('conflict', 'other poller'),
        [u(1)],
      ],
      () => void poller?.stop(),
    );
    poller = createPoller({
      api,
      onBatch: async () => undefined,
      onState: (s) => void states.push(s),
      sleep: async (ms) => void waits.push(ms),
    });
    await poller.start();
    await poller.done();
    expect(waits.slice(0, 4)).toEqual([7000, 1000, 2000, 30_000]);
    expect(states).toContainEqual({ connection: 'error', error: 'rate_limited' });
    expect(states).toContainEqual({ connection: 'error', error: 'network' });
    expect(states).toContainEqual({ connection: 'error', error: 'conflict' });
    expect(states.at(-1)).toEqual({ connection: 'connected' });
  });

  it('tells the router how long the chat was not read', async () => {
    let clock = 0;
    const offline: number[] = [];
    let poller: ReturnType<typeof createPoller> | undefined;
    const { api } = scripted([[u(1)], new TelegramApiError('network', 'x'), [u(2)]], () => void poller?.stop());
    poller = createPoller({
      api,
      now: () => clock,
      onBatch: async (_ups, info) => void offline.push(info.offlineForMs),
      onState: () => undefined,
      // The computer slept 20 minutes during the back-off
      sleep: async () => {
        clock += 20 * 60_000;
      },
    });
    await poller.start();
    await poller.done();
    expect(offline[0]).toBe(0);
    expect(offline[1]).toBeGreaterThan(15 * 60_000);
  });

  it('stops cleanly: stop() aborts the long poll in flight', async () => {
    let aborted = false;
    const api = {
      getUpdates: (_o: number | undefined, signal?: AbortSignal) =>
        new Promise<TelegramUpdate[]>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            aborted = true;
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
    } as unknown as BotApi;
    const states: PollerState[] = [];
    const poller = createPoller({ api, onBatch: async () => undefined, onState: (s) => void states.push(s), sleep: async () => undefined });
    await poller.start();
    await poller.stop();
    expect(aborted).toBe(true);
    expect(poller.running()).toBe(false);
  });
});
