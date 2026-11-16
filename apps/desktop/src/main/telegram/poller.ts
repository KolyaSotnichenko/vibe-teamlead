/**
 * The long-poll loop: `getUpdates` with a 50 s timeout, so Telegram answers the moment an update
 * arrives. One poller per app (the single-instance lock keeps a second app from starting one).
 *
 * - The offset moves past every update received, before the batch is handled, so one that
 *   throws is not fetched again and again.
 * - A bad token (401) stops the loop and is reported; another poller on the same token (409)
 *   waits 30 s; a rate limit (429) waits `retry_after`; other errors back off 1 s → 60 s.
 * - stop() aborts the request in flight and resolves when the loop has ended.
 */

import { LONG_POLL_SECONDS, type BotApi, TelegramApiError, type TelegramUpdate } from './bot-api';
import type { TelegramConnection, TelegramErrorReason } from '../../shared/types/telegram';

export interface PollerState {
  connection: Exclude<TelegramConnection, 'not_set'>;
  error?: TelegramErrorReason;
}

export interface PollerOptions {
  api: BotApi;
  onBatch: (updates: TelegramUpdate[], info: { offlineForMs: number }) => Promise<void>;
  onState: (state: PollerState) => void;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface Poller {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Resolves when the loop has ended (stopped, or a bad token) */
  done(): Promise<void>;
  running(): boolean;
}

const CONFLICT_WAIT_MS = 30_000;
const MAX_BACKOFF_MS = 60_000;
/** A normal long poll may take this long without the chat being "unread" */
const NORMAL_POLL_MS = LONG_POLL_SECONDS * 1000 + 10_000;

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

const reasonOf = (error: unknown): TelegramErrorReason => {
  if (!(error instanceof TelegramApiError)) return 'unknown';
  switch (error.kind) {
    case 'unauthorized':
      return 'bad_token';
    case 'conflict':
      return 'conflict';
    case 'rate_limited':
      return 'rate_limited';
    case 'network':
      return 'network';
    default:
      return 'unknown';
  }
};

export function createPoller(options: PollerOptions): Poller {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  let controller: AbortController | undefined;
  let loop: Promise<void> = Promise.resolve();
  let active = false;

  const run = async (signal: AbortSignal) => {
    let offset: number | undefined;
    let lastOkAt: number | undefined;
    let backoff = 1000;
    let lastState: string | undefined;
    const report = (state: PollerState) => {
      const key = `${state.connection}:${state.error ?? ''}`;
      if (key === lastState) return;
      lastState = key;
      options.onState(state);
    };
    report({ connection: 'connecting' });
    while (!signal.aborted) {
      let updates: TelegramUpdate[];
      try {
        // Until connected, ask without waiting: Settings learns at once that the token works
        updates = await options.api.getUpdates(offset, signal, lastState === 'connected:' ? undefined : 0);
      } catch (error) {
        if (signal.aborted) break;
        const reason = reasonOf(error);
        report({ connection: 'error', error: reason });
        if (reason === 'bad_token') break;
        let wait: number;
        if (reason === 'rate_limited') wait = ((error as TelegramApiError).retryAfter ?? 5) * 1000;
        else if (reason === 'conflict') wait = CONFLICT_WAIT_MS;
        else {
          wait = backoff;
          backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        }
        await sleep(wait, signal);
        continue;
      }
      if (signal.aborted) break;
      backoff = 1000;
      const at = now();
      const offlineForMs = lastOkAt === undefined ? 0 : Math.max(0, at - lastOkAt - NORMAL_POLL_MS);
      lastOkAt = at;
      report({ connection: 'connected' });
      if (updates.length) {
        offset = Math.max(...updates.map((u) => u.update_id)) + 1;
        try {
          await options.onBatch(updates, { offlineForMs });
        } catch {
          // A failing handler must not stop the loop; the router reports its own errors
        }
      }
    }
    active = false;
  };

  return {
    async start() {
      if (active) return;
      active = true;
      controller = new AbortController();
      loop = run(controller.signal);
    },
    async stop() {
      controller?.abort();
      await loop;
      active = false;
    },
    done: () => loop,
    running: () => active,
  };
}
