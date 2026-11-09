import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ownerDecisionsPath, readOwnerDecisions, recordOwnerDecision } from '../owner-decisions';

const root = () => mkdtempSync(join(tmpdir(), 'vtl-owner-'));

describe('owner decisions', () => {
  it('live under the app data, one file per task, outside the project', () => {
    const r = '/data';
    const a = ownerDecisionsPath(r, '/p/roadmaply/.vibe-teamlead/specs/023-x');
    expect(a.startsWith('/data/owner-decisions/')).toBe(true);
    expect(a).not.toContain('roadmaply');
    expect(ownerDecisionsPath(r, '/p/roadmaply/.vibe-teamlead/specs/023-x')).toBe(a);
    expect(ownerDecisionsPath(r, '/p/roadmaply/.vibe-teamlead/specs/024-y')).not.toBe(a);
  });

  it('records a skip and an instruction per subtask, and a later decision replaces the earlier one', () => {
    const file = join(root(), 'owner-decisions', 't.json');
    recordOwnerDecision(file, [{ id: 's1', fingerprint: 'f1' }], { action: 'retry', instruction: '  You may change product code.  ' });
    expect(readOwnerDecisions(file)).toEqual({ skipped: {}, instructions: { s1: { text: 'You may change product code.', fingerprint: 'f1' } } });

    recordOwnerDecision(file, [{ id: 's1', fingerprint: 'f1' }, { id: 's2', fingerprint: 'f2' }], { action: 'skip' });
    expect(readOwnerDecisions(file)).toEqual({ skipped: { s1: 'f1', s2: 'f2' }, instructions: {} });

    recordOwnerDecision(file, [{ id: 's2', fingerprint: 'f2' }], { action: 'retry' });
    expect(readOwnerDecisions(file)).toEqual({ skipped: { s1: 'f1' }, instructions: {} });
  });

  it('reads nothing from a missing, broken or odd file', () => {
    const dir = root();
    expect(readOwnerDecisions(join(dir, 'none.json'))).toEqual({ skipped: {}, instructions: {} });
    expect(readOwnerDecisions(undefined)).toEqual({ skipped: {}, instructions: {} });
    writeFileSync(join(dir, 'bad.json'), '{not json');
    expect(readOwnerDecisions(join(dir, 'bad.json'))).toEqual({ skipped: {}, instructions: {} });
    writeFileSync(join(dir, 'odd.json'), JSON.stringify({ subtasks: { s1: { skipped: 'yes', instruction: 5, fingerprint: 'f' }, s2: { skipped: true } } }));
    expect(readOwnerDecisions(join(dir, 'odd.json'))).toEqual({ skipped: {}, instructions: {} });
  });

  it('caps an instruction', () => {
    const file = join(root(), 't.json');
    recordOwnerDecision(file, [{ id: 's1', fingerprint: 'f1' }], { action: 'retry', instruction: 'x'.repeat(9000) });
    expect(readOwnerDecisions(file).instructions.s1.text).toHaveLength(4000);
    expect(JSON.parse(readFileSync(file, 'utf-8')).subtasks.s1.at).toEqual(expect.any(String));
  });
});
