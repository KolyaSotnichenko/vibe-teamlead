import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createStallWatch, instrumentIpc, instrumentSyncCalls, stallLogWriter, type StallRecord } from '../stall-watch';

const WORTH_RECORDING = 200;

describe('watching the main process for pauses', () => {
  let records: StallRecord[];

  beforeEach(() => {
    vi.useFakeTimers();
    records = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const setup = () => {
    const watch = createStallWatch({ write: (record) => records.push(record) });
    watch.start();
    return watch;
  };
  /** The thread does nothing for this long: the clock moves, no timer gets to run */
  const block = (ms: number) => vi.setSystemTime(Date.now() + ms);

  it('stays silent while the process keeps up', () => {
    setup();
    vi.advanceTimersByTime(60_000);
    expect(records).toEqual([]);
  });

  it('records a pause, and how long it lasted', () => {
    setup();
    vi.advanceTimersByTime(1000);
    block(3900);
    vi.advanceTimersByTime(100);

    expect(records).toHaveLength(1);
    expect(records[0].ms).toBeGreaterThanOrEqual(3900);
    expect(records[0].ms).toBeLessThan(4100);
  });

  it('ignores a pause too short to notice', () => {
    setup();
    block(100);
    vi.advanceTimersByTime(100);
    expect(records).toEqual([]);
  });

  it('names the calls still open during the pause and those that just ended', () => {
    const watch = setup();
    watch.ipcStarted('task:done')();
    const end = watch.ipcStarted('task:merge');
    block(1000);
    vi.advanceTimersByTime(100);
    end();

    expect(records[0].inFlight).toEqual(['task:merge']);
    expect(records[0].recent).toContain('task:done');
  });

  it('drops calls that ended long before the pause', () => {
    const watch = setup();
    watch.ipcStarted('task:old')();
    vi.advanceTimersByTime(30_000);
    block(1000);
    vi.advanceTimersByTime(100);
    expect(records[0].recent).not.toContain('task:old');
  });

  it('names a slow blocking call that happened in the pause', () => {
    const watch = setup();
    block(2000);
    watch.syncCall('rmSync', '/tmp/copy', 2000);
    vi.advanceTimersByTime(100);
    expect(records[0].slowCalls).toEqual([{ call: 'rmSync', detail: '/tmp/copy', ms: 2000 }]);
  });

  it("doesn't take the Mac's sleep for a pause", () => {
    const watch = setup();
    watch.suspend();
    block(3_600_000);
    vi.advanceTimersByTime(100);
    watch.resume();
    vi.advanceTimersByTime(100);
    expect(records).toEqual([]);
  });

  it("doesn't take sleep it wasn't told about for a pause", () => {
    setup();
    block(10 * 60_000);
    vi.advanceTimersByTime(100);
    expect(records).toEqual([]);
  });

  it('never lets a failed write reach the app', () => {
    const watch = createStallWatch({ write: () => { throw new Error('disk full'); } });
    watch.start();
    block(1000);
    expect(() => vi.advanceTimersByTime(100)).not.toThrow();
  });

  it('stops when told', () => {
    const watch = setup();
    watch.stop();
    block(1000);
    vi.advanceTimersByTime(1000);
    expect(records).toEqual([]);
  });
});

describe('telling the watch what runs', () => {
  const watchStub = () => {
    const ended: string[] = [];
    const started: string[] = [];
    const slow: Array<[string, string, number]> = [];
    return {
      started, ended, slow,
      watch: {
        ipcStarted: (name: string) => { started.push(name); return () => ended.push(name); },
        syncCall: (call: string, detail: string, ms: number) => slow.push([call, detail, ms]),
      },
    };
  };

  it('wraps IPC handlers and keeps what they return', async () => {
    const stub = watchStub();
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipc = { handle: (channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn); } };
    instrumentIpc(ipc, stub.watch);

    ipc.handle('a', async (_event, value) => `got ${value}`);
    const answer = handlers.get('a')!({}, 'x');
    expect(stub.started).toEqual(['a']);
    expect(stub.ended).toEqual([]);
    await expect(answer).resolves.toBe('got x');
    expect(stub.ended).toEqual(['a']);
  });

  it('ends a call that throws, and lets the error through', () => {
    const stub = watchStub();
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipc = { handle: (channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn); } };
    instrumentIpc(ipc, stub.watch);

    ipc.handle('a', () => { throw new Error('nope'); });
    expect(() => handlers.get('a')!({})).toThrow('nope');
    expect(stub.ended).toEqual(['a']);
  });

  it('notes a slow blocking call with what it worked on, and returns its result', () => {
    const stub = watchStub();
    const target = { rmSync: (path: string) => { vi.setSystemTime(Date.now() + 500); return `removed ${path}`; }, quick: () => 'ok', execFileSync: (file: string, args: string[]) => { vi.setSystemTime(Date.now() + 500); return `${file} ${args.join(' ')}`; } };
    vi.useFakeTimers();
    instrumentSyncCalls(target, ['rmSync', 'quick', 'execFileSync'], stub.watch);

    expect(target.rmSync('/tmp/x')).toBe('removed /tmp/x');
    expect(target.quick()).toBe('ok');
    expect(target.execFileSync('git', ['diff', '--stat', 'token-like-secret'])).toBe('git diff --stat token-like-secret');
    vi.useRealTimers();

    expect(stub.slow).toEqual([['rmSync', '/tmp/x', 500], ['execFileSync', 'git diff', 500]]);
  });
});

describe('the file of pauses', () => {
  const record = (ms: number): StallRecord => ({ at: 'now', ms, inFlight: [], recent: [], slowCalls: [] });

  it('keeps one line per pause, in order', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'stalls-')), 'stalls.jsonl');
    const write = stallLogWriter(file);
    write(record(1));
    write(record(2));
    await vi.waitFor(() => expect(existsSync(file) && readFileSync(file, 'utf-8').trim().split('\n').length).toBe(2));
    expect(readFileSync(file, 'utf-8').trim().split('\n').map((line) => JSON.parse(line).ms)).toEqual([1, 2]);
  });

  it('starts over at a size that cannot fill a disk, keeping the last file', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'stalls-')), 'stalls.jsonl');
    writeFileSync(file, 'x'.repeat(1024 * 1024));
    stallLogWriter(file)(record(7));
    await vi.waitFor(() => expect(existsSync(`${file}.1`)).toBe(true));
    await vi.waitFor(() => expect(existsSync(file)).toBe(true));
    expect(JSON.parse(readFileSync(file, 'utf-8')).ms).toBe(7);
  });
});

it('catches a real pause on a real clock, and the blocking call behind it', async () => {
  const records: StallRecord[] = [];
  const watch = createStallWatch({ write: (record) => records.push(record) });
  const target = { slow: () => { const until = Date.now() + 350; while (Date.now() < until); } };
  instrumentSyncCalls(target, ['slow'], watch, () => 'busy loop');
  watch.start();

  await new Promise((resolve) => setTimeout(resolve, 150));
  target.slow();
  await vi.waitFor(() => expect(records).toHaveLength(1));
  watch.stop();

  expect(records[0].ms).toBeGreaterThanOrEqual(WORTH_RECORDING);
  expect(records[0].slowCalls[0]).toMatchObject({ call: 'slow', detail: 'busy loop' });
});
