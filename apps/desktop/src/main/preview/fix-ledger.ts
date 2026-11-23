/**
 * What the agent that fixes a preview start (fix-start.ts) found, one result per distinct
 * failure, and the bound on how often it starts by itself: never twice for the same failure,
 * and at most three times in any day per project. A failure is told from another by the
 * commit it happened on, the recipe the start used, and the stage and service that failed, so
 * a project that fails the same way on every open costs one session, not one per open. A run
 * the owner asks for is not bounded. Kept in the app's data, per project. No Electron imports.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PreviewRecipe } from '../../shared/types/preview';
import { writeFileReplacingSync } from '../ai/safe-write';
import type { FixOutcome } from './fix-start';
import { recipeFileText } from './recipe';

export const AUTO_RUNS_PER_DAY = 3;
const MAX_RECORDS = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface FixRecord {
  key: string;
  at: string;
  /** Started by the app itself, not asked for by the owner */
  auto: boolean;
  outcome: FixOutcome;
}

interface LedgerFile {
  records: FixRecord[];
  /** When the app started the agent by itself, for the day's bound; kept apart from the records, which are capped */
  autoRuns: string[];
}

/** What tells one failed start from another */
export function failureKey(parts: { commit: string; recipe: PreviewRecipe; stage?: string; service?: string }): string {
  return createHash('sha256').update([parts.commit, recipeFileText(parts.recipe), parts.stage ?? '', parts.service ?? ''].join('\0')).digest('hex');
}

export interface FixLedger {
  get: (key: string) => FixRecord | undefined;
  /** Whether the agent may start by itself for this failure now */
  mayRunAutomatically: (key: string, now?: Date) => boolean;
  /** An automatic run begins: it counts toward the day's bound from now, whether it finishes or not */
  begin: (now?: Date) => void;
  record: (key: string, outcome: FixOutcome, auto: boolean, now?: Date) => void;
}

export function openFixLedger(dataDir: string, projectId: string): FixLedger {
  const dir = join(dataDir, 'preview');
  const file = join(dir, `${projectId.replace(/[^\w-]/g, '_')}-start-fix.json`);

  const read = (): LedgerFile => {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<LedgerFile>;
      return { records: Array.isArray(parsed.records) ? parsed.records : [], autoRuns: Array.isArray(parsed.autoRuns) ? parsed.autoRuns.filter((at) => typeof at === 'string') : [] };
    } catch {
      return { records: [], autoRuns: [] };
    }
  };
  const write = (ledger: LedgerFile) => {
    mkdirSync(dir, { recursive: true });
    writeFileReplacingSync(file, JSON.stringify(ledger, null, 2));
  };
  const within = (at: string, now: Date) => {
    const time = Date.parse(at);
    return Number.isFinite(time) && now.getTime() - time < DAY_MS;
  };

  return {
    get: (key) => read().records.find((record) => record.key === key),
    mayRunAutomatically: (key, now = new Date()) => {
      const ledger = read();
      if (ledger.records.some((record) => record.key === key)) return false;
      return ledger.autoRuns.filter((at) => within(at, now)).length < AUTO_RUNS_PER_DAY;
    },
    begin: (now = new Date()) => {
      const ledger = read();
      write({ records: ledger.records, autoRuns: [...ledger.autoRuns.filter((run) => within(run, now)), now.toISOString()] });
    },
    record: (key, outcome, auto, now = new Date()) => {
      const ledger = read();
      const records = [...ledger.records.filter((record) => record.key !== key), { key, at: now.toISOString(), auto, outcome }].slice(-MAX_RECORDS);
      write({ records, autoRuns: ledger.autoRuns.filter((run) => within(run, now)) });
    },
  };
}
