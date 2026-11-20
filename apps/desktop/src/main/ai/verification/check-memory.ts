/**
 * What the app's checks already found out, kept between runs.
 *
 * A check is a full run of the project's tests on a clean copy: minutes of every
 * core. The answer depends only on the commit, the commit it started from, the
 * commands and the project's settings, so asking the same question again gives the
 * same answer. In one project, 23 of 57 runs asked a question already answered:
 * QA rounds and restarts on a commit that had not moved, and the same base commit
 * run again for every task that started from it.
 *
 * Kept outside the folders agents work in, like the QA approvals: an agent that
 * could write here could write itself a pass. One file per project. No Electron
 * imports: this runs in the worker too.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { writeFileReplacingSync } from '../safe-write';
import type { CheckOutcome, VerificationReport } from './verify-task';

export const MAX_REPORTS = 30;
export const MAX_BASE_RESULTS = 60;

export function checkMemoryDir(): string {
  return join(homedir(), '.vibe-teamlead', 'check-results');
}

export interface BaseResult {
  outcome: CheckOutcome;
  /** The end of its output, when it failed */
  tail?: string;
}

export interface KeptReport {
  /** When the checks really ran */
  at: string;
  report: VerificationReport;
}

export interface CheckMemory {
  report(key: string): KeptReport | undefined;
  keepReport(key: string, report: VerificationReport): void;
  base(key: string): BaseResult | undefined;
  keepBase(key: string, result: BaseResult): void;
}

interface Stored {
  /** Oldest first */
  reports: [string, KeptReport][];
  base: [string, BaseResult][];
}

/** One key for everything an answer depends on. Pure. */
export function memoryKey(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** How long ago, in words for the task's log. Pure. */
export function ago(at: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(at)) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

function read(file: string): Stored {
  try {
    const stored = JSON.parse(readFileSync(file, 'utf-8')) as Partial<Stored>;
    return { reports: Array.isArray(stored.reports) ? stored.reports : [], base: Array.isArray(stored.base) ? stored.base : [] };
  } catch {
    return { reports: [], base: [] };
  }
}

/** Newest last, the oldest dropped past the limit */
function put<T>(entries: [string, T][], key: string, value: T, limit: number): [string, T][] {
  return [...entries.filter(([existing]) => existing !== key), [key, value] as [string, T]].slice(-limit);
}

/**
 * The memory of one project's checks. `project` is what its tasks share (the checks' lock).
 * Never throws: a memory that can't be read is empty, one that can't be written is lost.
 */
export function openCheckMemory(dir: string, project: string): CheckMemory {
  const file = join(dir, `${createHash('sha256').update(resolve(project)).digest('hex')}.json`);
  let stored = read(file);
  const save = () => {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileReplacingSync(file, JSON.stringify(stored));
    } catch {
      // The next run checks again
    }
  };
  return {
    report: (key) => stored.reports.find(([existing]) => existing === key)?.[1],
    keepReport: (key, report) => {
      stored = { ...stored, reports: put(stored.reports, key, { at: new Date().toISOString(), report }, MAX_REPORTS) };
      save();
    },
    base: (key) => stored.base.find(([existing]) => existing === key)?.[1],
    keepBase: (key, result) => {
      stored = { ...stored, base: put(stored.base, key, result, MAX_BASE_RESULTS) };
      save();
    },
  };
}
