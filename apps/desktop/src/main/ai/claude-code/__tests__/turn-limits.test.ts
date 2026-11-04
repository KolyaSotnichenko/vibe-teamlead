import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { clearTurnLimits, parseTurnLimits, recordTurnLimit, TURN_LIMITS_FILE } from '../turn-limits';

const dir = () => mkdtempSync(join(tmpdir(), 'vtl-turns-'));

describe('turn limit records', () => {
  it('adds one per session, grouped by agent and subtask', () => {
    const specDir = dir();
    recordTurnLimit(specDir, { agentType: 'coder', subtaskId: 's1', limit: 200 });
    recordTurnLimit(specDir, { agentType: 'coder', subtaskId: 's1', limit: 200 });
    recordTurnLimit(specDir, { agentType: 'qa_reviewer', limit: 200 });

    expect(parseTurnLimits(JSON.parse(readFileSync(join(specDir, TURN_LIMITS_FILE), 'utf-8')))).toEqual([
      { agentType: 'coder', subtaskId: 's1', limit: 200, count: 2 },
      { agentType: 'qa_reviewer', limit: 200, count: 1 },
    ]);
  });

  it('never fails a session over its own bookkeeping', () => {
    expect(() => recordTurnLimit('/no/such/dir', { agentType: 'coder', limit: 200 })).not.toThrow();
    const specDir = dir();
    writeFileSync(join(specDir, TURN_LIMITS_FILE), 'not json');
    recordTurnLimit(specDir, { agentType: 'coder', limit: 200 });
    expect(parseTurnLimits(JSON.parse(readFileSync(join(specDir, TURN_LIMITS_FILE), 'utf-8')))).toHaveLength(1);
  });

  it('a new run starts clean', () => {
    const specDir = dir();
    recordTurnLimit(specDir, { agentType: 'coder', limit: 200 });
    clearTurnLimits(specDir);
    expect(existsSync(join(specDir, TURN_LIMITS_FILE))).toBe(false);
  });

  it('reads only well-formed records: agents can write to this folder', () => {
    expect(parseTurnLimits('x')).toEqual([]);
    expect(parseTurnLimits([{ agentType: 'coder', limit: 'many', count: 1 }, { agentType: 'coder', limit: 200, count: 1 }, null])).toEqual([
      { agentType: 'coder', limit: 200, count: 1 },
    ]);
  });
});
