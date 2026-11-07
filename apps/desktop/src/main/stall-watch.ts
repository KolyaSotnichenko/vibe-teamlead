/**
 * Records when the main process stops answering. Everything in the window waits on
 * this thread, so a pause here is the window hanging, however fast the machine. A
 * timer that fires late is the proof, and the record says what was running then:
 * the IPC calls still open and the slow blocking calls. The file stays on this
 * machine. No Electron imports.
 */

import childProcess from 'node:child_process';
import fs from 'node:fs';
import { appendFile, rename, stat } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { basename, join } from 'node:path';

const TICK_MS = 100;
/** Shorter than this nobody notices */
const WORTH_RECORDING_MS = 200;
/** A blocking call this long is worth naming when a pause is explained */
const SLOW_CALL_MS = 50;
/** Calls that ended this long before a pause can't have caused it */
const RECENT_MS = 5000;
/** A process doesn't hang this long unnoticed: the Mac slept without saying so */
const LONGER_MEANS_ASLEEP_MS = 5 * 60_000;
const MAX_FILE_BYTES = 1024 * 1024;

export interface SlowCall {
  call: string;
  detail: string;
  ms: number;
}

export interface StallRecord {
  at: string;
  ms: number;
  /** IPC calls open during the pause */
  inFlight: string[];
  /** IPC calls that ended shortly before it */
  recent: string[];
  slowCalls: SlowCall[];
}

export function createStallWatch({ write }: { write: (record: StallRecord) => void }) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastTick = 0;
  let asleep = false;
  const open: string[] = [];
  let ended: Array<{ name: string; at: number }> = [];
  let slowCalls: Array<SlowCall & { at: number }> = [];

  const tick = () => {
    const now = Date.now();
    const ms = now - lastTick - TICK_MS;
    lastTick = now;
    const since = now - Math.max(ms, 0);
    ended = ended.filter((call) => call.at >= since - RECENT_MS);
    const during = slowCalls.filter((call) => call.at >= since);
    slowCalls = slowCalls.filter((call) => call.at >= since - RECENT_MS);
    if (asleep || ms < WORTH_RECORDING_MS || ms > LONGER_MEANS_ASLEEP_MS) return;
    try {
      write({
        at: new Date(since).toISOString(),
        ms,
        inFlight: [...open],
        recent: ended.map((call) => call.name),
        slowCalls: during.map(({ call, detail, ms: took }) => ({ call, detail, ms: took })),
      });
    } catch {
      // A diagnostic must never be what breaks the app
    }
  };

  return {
    start() {
      lastTick = Date.now();
      timer = setInterval(tick, TICK_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    suspend() {
      asleep = true;
    },
    resume() {
      asleep = false;
      lastTick = Date.now();
    },
    /** Returns what to call when it ends */
    ipcStarted(name: string): () => void {
      open.push(name);
      return () => {
        open.splice(open.indexOf(name), 1);
        ended.push({ name, at: Date.now() });
      };
    },
    syncCall(call: string, detail: string, ms: number) {
      slowCalls.push({ call, detail, ms, at: Date.now() });
    },
  };
}

type Handler = (...args: unknown[]) => unknown;

/** Every IPC handler registered from now on reports when it starts and ends. */
export function instrumentIpc(
  ipc: { handle: (channel: string, handler: Handler) => void },
  watch: { ipcStarted: (name: string) => () => void },
): void {
  const handle = ipc.handle.bind(ipc);
  ipc.handle = (channel, handler) =>
    handle(channel, (...args) => {
      const end = watch.ipcStarted(channel);
      let result: unknown;
      try {
        result = handler(...args);
      } catch (error) {
        end();
        throw error;
      }
      if (result instanceof Promise) return result.finally(end);
      end();
      return result;
    });
}

/** What a call worked on. Of a command only the tool and its subcommand: arguments can hold secrets. */
function describeCall(args: unknown[]): string {
  const [first, second] = args;
  if (typeof first !== 'string') return '';
  if (Array.isArray(second)) return [basename(first), second[0]].filter(Boolean).join(' ');
  return first;
}

/** Blocking functions of a module report when they take long. */
export function instrumentSyncCalls<T extends object>(
  target: T,
  names: Array<keyof T & string>,
  watch: { syncCall: (call: string, detail: string, ms: number) => void },
  describe: (args: unknown[]) => string = describeCall,
): void {
  for (const name of names) {
    const original = target[name] as unknown as Handler;
    target[name] = function wrapped(this: unknown, ...args: unknown[]) {
      const started = Date.now();
      try {
        return original.apply(this, args);
      } finally {
        const ms = Date.now() - started;
        if (ms >= SLOW_CALL_MS) watch.syncCall(name, describe(args), ms);
      }
    } as unknown as T[keyof T & string];
  }
}

/** One line per pause. The file is cut at a size that can't fill a disk. */
export function stallLogWriter(file: string): (record: StallRecord) => void {
  let queue: Promise<unknown> = Promise.resolve();
  return (record) => {
    queue = queue
      .then(async () => {
        const size = await stat(file).then((s) => s.size, () => 0);
        if (size >= MAX_FILE_BYTES) await rename(file, `${file}.1`);
        await appendFile(file, `${JSON.stringify(record)}\n`, 'utf-8');
      })
      .catch(() => {});
  };
}

export function startStallWatch(ipc: Parameters<typeof instrumentIpc>[0], logsDir: string) {
  const watch = createStallWatch({ write: stallLogWriter(join(logsDir, 'stalls.jsonl')) });
  instrumentIpc(ipc, watch);
  instrumentSyncCalls(fs, ['rmSync', 'cpSync', 'readFileSync', 'writeFileSync', 'readdirSync', 'renameSync', 'copyFileSync'], watch);
  // A whole command line can hold a secret: for these, its first word only
  instrumentSyncCalls(childProcess, ['execSync'], watch, ([command]) => String(command).split(' ')[0]);
  instrumentSyncCalls(childProcess, ['execFileSync', 'spawnSync'], watch);
  // The bundle imports these by name, and named imports don't see a change without this
  syncBuiltinESMExports();
  watch.start();
  return watch;
}
