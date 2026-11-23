import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import type { PreviewRecipe } from '../../../shared/types/preview';
import { AUTO_RUNS_PER_DAY, failureKey, openFixLedger } from '../fix-ledger';
import type { FixOutcome } from '../fix-start';

const RECIPE: PreviewRecipe = { version: 1, kind: 'web', services: [{ name: 'web', dir: '', command: 'npm run dev', page: true }] };
const UNKNOWN: FixOutcome = { outcome: 'unknown', summary: 'nothing found' };
const key = (over: Partial<Parameters<typeof failureKey>[0]> = {}) => failureKey({ commit: 'abc123', recipe: RECIPE, stage: 'services', service: 'web', ...over });
const at = (hours: number) => new Date(Date.UTC(2026, 10, 23, 10) + hours * 3_600_000);

describe('the ledger of fixed starts', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'vtl-fix-'));
  });

  it('tells one failure from another by the commit, the recipe, the stage and the service', () => {
    expect(key()).toBe(key());
    expect(key({ recipe: JSON.parse(JSON.stringify(RECIPE)) })).toBe(key());
    for (const other of [key({ commit: 'def456' }), key({ recipe: { version: 1, kind: 'none' } }), key({ stage: 'migrations' }), key({ service: 'api' }), key({ service: undefined })]) {
      expect(other).not.toBe(key());
    }
    expect(key()).toMatch(/^[0-9a-f]{32,}$/);
  });

  it('counts a run when it begins, not when it is recorded, so a stopped one counts and a finished one only once', () => {
    const ledger = openFixLedger(dataDir, 'p1');
    for (let i = 0; i < AUTO_RUNS_PER_DAY; i++) ledger.begin(at(i / 10));
    expect(ledger.mayRunAutomatically(key({ commit: 'new' }), at(1))).toBe(false);
    const other = openFixLedger(mkdtempSync(join(tmpdir(), 'vtl-fix-')), 'p1');
    other.begin(at(0));
    other.record(key(), UNKNOWN, true, at(0));
    other.record(key({ commit: 'b' }), UNKNOWN, true, at(0));
    expect(other.mayRunAutomatically(key({ commit: 'c' }), at(1))).toBe(true);
  });

  it('lets a failure be worked on by itself once, and keeps what was found', () => {
    const ledger = openFixLedger(dataDir, 'p1');
    expect(ledger.get(key())).toBeUndefined();
    expect(ledger.mayRunAutomatically(key(), at(0))).toBe(true);
    ledger.record(key(), UNKNOWN, true, at(0));
    expect(ledger.get(key())).toEqual({ key: key(), at: at(0).toISOString(), auto: true, outcome: UNKNOWN });
    expect(ledger.mayRunAutomatically(key(), at(1))).toBe(false);
    expect(ledger.mayRunAutomatically(key(), at(100))).toBe(false);
  });

  it(`lets ${AUTO_RUNS_PER_DAY} failures be worked on by themselves in a day, and the next only a day after the first`, () => {
    const ledger = openFixLedger(dataDir, 'p1');
    for (let i = 0; i < AUTO_RUNS_PER_DAY; i++) {
      expect(ledger.mayRunAutomatically(key({ commit: `c${i}` }), at(i))).toBe(true);
      // Counted when it starts: a run stopped half-way costs as much as one that finished
      ledger.begin(at(i));
    }
    expect(ledger.mayRunAutomatically(key({ commit: 'next' }), at(5))).toBe(false);
    expect(ledger.mayRunAutomatically(key({ commit: 'next' }), at(23.9))).toBe(false);
    expect(ledger.mayRunAutomatically(key({ commit: 'next' }), at(24.1))).toBe(true);
  });

  it("does not count the runs the owner asked for, and replaces a failure's result with the newer one", () => {
    const ledger = openFixLedger(dataDir, 'p1');
    for (let i = 0; i < 10; i++) ledger.record(key({ commit: `m${i}` }), UNKNOWN, false, at(i / 10));
    expect(ledger.mayRunAutomatically(key({ commit: 'auto' }), at(2))).toBe(true);
    const fixed: FixOutcome = { outcome: 'fixed', recipe: RECIPE, summary: 'ok' };
    ledger.record(key({ commit: 'm1' }), fixed, false, at(3));
    expect(ledger.get(key({ commit: 'm1' }))?.outcome).toEqual(fixed);
  });

  it('keeps each project apart, and survives a restart of the app', () => {
    openFixLedger(dataDir, 'p1').record(key(), UNKNOWN, true, at(0));
    expect(openFixLedger(dataDir, 'p1').get(key())?.outcome).toEqual(UNKNOWN);
    expect(openFixLedger(dataDir, 'p1').mayRunAutomatically(key(), at(1))).toBe(false);
    expect(openFixLedger(dataDir, 'p2').get(key())).toBeUndefined();
    expect(openFixLedger(dataDir, '../p1').get(key())).toBeUndefined();
  });

  it('keeps the latest fifty results, and still counts a day\'s runs after older ones are gone', () => {
    const ledger = openFixLedger(dataDir, 'p1');
    for (let i = 0; i < 60; i++) ledger.record(key({ commit: `k${i}` }), UNKNOWN, false, at(i / 100));
    expect(ledger.get(key({ commit: 'k0' }))).toBeUndefined();
    expect(ledger.get(key({ commit: 'k59' }))).toBeDefined();
    const file = JSON.parse(readFileSync(join(dataDir, 'preview', 'p1-start-fix.json'), 'utf-8')) as { records: unknown[] };
    expect(file.records).toHaveLength(50);
  });

  it('starts empty from a file it cannot read', () => {
    const ledger = openFixLedger(dataDir, 'p1');
    ledger.record(key(), UNKNOWN, true, at(0));
    writeFileSync(join(dataDir, 'preview', 'p1-start-fix.json'), '{ not json');
    const again = openFixLedger(dataDir, 'p1');
    expect(again.get(key())).toBeUndefined();
    expect(again.mayRunAutomatically(key(), at(1))).toBe(true);
    again.record(key(), UNKNOWN, true, at(1));
    expect(openFixLedger(dataDir, 'p1').get(key())).toBeDefined();
  });
});
