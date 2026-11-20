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
 * Kept outside the folders agents work in, one file per project. That alone is not
 * enough: the checks run the task's own code with the user's rights, and so do
 * agents' shell commands, so either could write a pass here. Every entry is signed
 * with a key that exists only in the app's memory, made anew each time the app
 * starts, and an entry without a valid signature does not exist. So a result is
 * kept while the app runs, and after a restart a commit is checked once more.
 * No Electron imports: this runs in the worker too.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
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

/** Where results are kept and the key that signs them */
export interface CheckMemoryPlace {
  dir: string;
  secret: string;
}

let appSecret: string | undefined;

/**
 * This run of the app's memory of checks. Main process only: a worker thread has its own copy
 * of this module, so it gets the place through its session, never by calling this.
 */
export function appCheckMemory(): CheckMemoryPlace {
  appSecret ??= randomBytes(32).toString('hex');
  return { dir: checkMemoryDir(), secret: appSecret };
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

/** Key, value, signature */
type Entry<T> = [string, T, string];

interface Stored {
  /** Oldest first */
  reports: Entry<KeptReport>[];
  base: Entry<BaseResult>[];
}

function sign(secret: string, kind: 'report' | 'base', key: string, value: unknown): string {
  return createHmac('sha256', secret).update(JSON.stringify([kind, key, value])).digest('hex');
}

function signedBy(secret: string, kind: 'report' | 'base', entry: unknown): boolean {
  if (!Array.isArray(entry) || typeof entry[0] !== 'string' || typeof entry[2] !== 'string') return false;
  const expected = Buffer.from(sign(secret, kind, entry[0], entry[1]), 'hex');
  const given = Buffer.from(entry[2], 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
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

/** Only what this run of the app signed: anything else, an earlier run's entries included, is dropped */
function read(file: string, secret: string): Stored {
  try {
    const stored = JSON.parse(readFileSync(file, 'utf-8')) as { reports?: unknown; base?: unknown };
    const signed = <T>(entries: unknown, kind: 'report' | 'base') => (Array.isArray(entries) ? (entries.filter((entry) => signedBy(secret, kind, entry)) as Entry<T>[]) : []);
    return { reports: signed<KeptReport>(stored.reports, 'report'), base: signed<BaseResult>(stored.base, 'base') };
  } catch {
    return { reports: [], base: [] };
  }
}

/** Newest last, the oldest dropped past the limit */
function put<T>(entries: Entry<T>[], entry: Entry<T>, limit: number): Entry<T>[] {
  return [...entries.filter(([existing]) => existing !== entry[0]), entry].slice(-limit);
}

/**
 * The memory of one project's checks. `project` is what its tasks share (the checks' lock).
 * Never throws: a memory that can't be read is empty, one that can't be written is lost.
 */
export function openCheckMemory({ dir, secret }: CheckMemoryPlace, project: string): CheckMemory {
  const file = join(dir, `${createHash('sha256').update(resolve(project)).digest('hex')}.json`);
  let stored = read(file, secret);
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
      const value: KeptReport = { at: new Date().toISOString(), report };
      stored = { ...stored, reports: put(stored.reports, [key, value, sign(secret, 'report', key, value)], MAX_REPORTS) };
      save();
    },
    base: (key) => stored.base.find(([existing]) => existing === key)?.[1],
    keepBase: (key, result) => {
      stored = { ...stored, base: put(stored.base, [key, result, sign(secret, 'base', key, result)], MAX_BASE_RESULTS) };
      save();
    },
  };
}
