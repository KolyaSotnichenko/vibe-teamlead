import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { clearTurnLimits, parseTurnLimits, recordTurnLimit, TURN_LIMITS, TURN_LIMITS_FILE } from '../turn-limits';

const dir = () => mkdtempSync(join(tmpdir(), 'vtl-turns-'));

describe('turn limits per agent', () => {
  it('gives a coder session 120 turns, QA 200, planner and architect 120, the designer 80', () => {
    expect(TURN_LIMITS).toEqual({ coder: 120, qa_reviewer: 200, qa_fixer: 200, planner: 120, architect: 120, designer: 80 });
  });
});

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

  it('replaces a link at its path instead of writing through it: agents can write to this folder', () => {
    const specDir = dir();
    const outside = join(dir(), 'precious.txt');
    writeFileSync(outside, 'untouched');
    symlinkSync(outside, join(specDir, TURN_LIMITS_FILE));

    recordTurnLimit(specDir, { agentType: 'coder', limit: 200 });

    expect(readFileSync(outside, 'utf-8')).toBe('untouched');
    expect(lstatSync(join(specDir, TURN_LIMITS_FILE)).isSymbolicLink()).toBe(false);
    expect(readdirSync(specDir)).toEqual([TURN_LIMITS_FILE]);
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
