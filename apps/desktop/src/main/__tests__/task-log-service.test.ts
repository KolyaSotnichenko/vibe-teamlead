import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reads = vi.hoisted(() => ({ files: [] as string[] }));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const readFileSync = ((file: unknown, ...rest: unknown[]) => {
    reads.files.push(String(file));
    return (actual.readFileSync as (...a: unknown[]) => unknown)(file, ...rest);
  }) as typeof actual.readFileSync;
  return { ...actual, readFileSync, default: { ...actual, readFileSync } };
});

const worktree = vi.hoisted(() => ({ path: null as string | null }));
vi.mock('../worktree-paths', () => ({ findTaskWorktree: () => worktree.path }));

import type { TaskLogs } from '../../shared/types';
import { TaskLogService } from '../task-log-service';

const SPEC = '001-x';
let dir: string;
let service: TaskLogService;
let when = 1_800_000_000;

const logs = (...lines: string[]) => ({
  spec_id: SPEC,
  created_at: '2026-11-13T10:00:00Z',
  updated_at: '2026-11-13T10:00:00Z',
  phases: {
    planning: { phase: 'planning', status: 'completed', started_at: null, completed_at: null, entries: [] },
    coding: {
      phase: 'coding', status: 'active', started_at: null, completed_at: null,
      entries: lines.map((content) => ({ timestamp: '2026-11-13T10:00:00Z', type: 'text', content, phase: 'coding' })),
    },
    validation: { phase: 'validation', status: 'pending', started_at: null, completed_at: null, entries: [] },
  },
});
/** Writes the log with a modification time of its own, as two writes a second apart have */
const write = (folder: string, ...lines: string[]) => {
  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, 'task_logs.json');
  writeFileSync(file, JSON.stringify(logs(...lines)));
  when += 1;
  utimesSync(file, when, when);
  return file;
};
const readsOf = (file: string) => reads.files.filter((f) => f === file).length;
const tick = (times = 1) => vi.advanceTimersByTime(1000 * times);

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'vtl-logs-'));
  worktree.path = null;
  reads.files.length = 0;
  service = new TaskLogService();
  vi.useFakeTimers();
});
afterEach(() => {
  service.stopWatching(SPEC);
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe('watching a task log', () => {
  it('tells when the log changes, with the new entries', () => {
    const specDir = path.join(dir, 'specs', SPEC);
    write(specDir, 'one');
    const changed: TaskLogs[] = [];
    service.on('logs-changed', (_id: string, l: TaskLogs) => changed.push(l));
    service.startWatching(SPEC, specDir);
    tick();
    expect(changed).toEqual([]);
    write(specDir, 'one', 'two');
    tick();
    expect(changed).toHaveLength(1);
    expect(changed[0].phases.coding?.entries.map((e) => e.content)).toEqual(['one', 'two']);
  });

  // F-013: every second the whole file was read and compared, however large, on the thread the window waits on
  it('does not read a log that has not changed', () => {
    const specDir = path.join(dir, 'specs', SPEC);
    const file = write(specDir, 'one');
    service.startWatching(SPEC, specDir);
    const afterStart = readsOf(file);
    tick(10);
    expect(readsOf(file)).toBe(afterStart);
  });

  it('reads a changed log once per change, not once to compare and again to load', () => {
    const specDir = path.join(dir, 'specs', SPEC);
    const file = write(specDir, 'one');
    service.startWatching(SPEC, specDir);
    const afterStart = readsOf(file);
    write(specDir, 'one', 'two');
    tick();
    expect(readsOf(file)).toBe(afterStart + 1);
  });

  it("follows the task's worktree once it exists, and merges its log in", () => {
    const specDir = path.join(dir, 'specs', SPEC);
    write(specDir, 'from main');
    const changed: TaskLogs[] = [];
    service.on('logs-changed', (_id: string, l: TaskLogs) => changed.push(l));
    service.startWatching(SPEC, specDir, dir, 'specs');
    tick();
    worktree.path = path.join(dir, 'worktree');
    write(path.join(worktree.path, 'specs', SPEC), 'from the worktree');
    tick();
    expect(changed.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(changed.at(-1))).toContain('from the worktree');
  });

  it('stops when told', () => {
    const specDir = path.join(dir, 'specs', SPEC);
    const file = write(specDir, 'one');
    service.startWatching(SPEC, specDir);
    service.stopWatching(SPEC);
    const before = readsOf(file);
    write(specDir, 'one', 'two');
    tick(3);
    expect(readsOf(file)).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
  });
});
