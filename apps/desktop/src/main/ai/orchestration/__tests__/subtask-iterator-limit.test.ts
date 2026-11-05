import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { iterateSubtasks, type SubtaskIteratorConfig } from '../subtask-iterator';
import { codingFailure } from '../build-orchestrator';
import type { SessionResult } from '../../session/types';

const session = (outcome: SessionResult['outcome']) => ({ outcome, stepsExecuted: 1, durationMs: 1 }) as unknown as SessionResult;

function setup(outcomes: Array<SessionResult['outcome'] | ((planPath: string) => SessionResult['outcome'])>, ids = ['s1']) {
  const specDir = mkdtempSync(join(tmpdir(), 'vtl-limit-'));
  const planPath = join(specDir, 'implementation_plan.json');
  writeFileSync(planPath, JSON.stringify({ phases: [{ name: 'P', subtasks: ids.map((id) => ({ id, description: id, status: 'pending' })) }] }));
  let n = 0;
  const runSubtaskSession = vi.fn(async () => {
    const next = outcomes[n++] ?? 'completed';
    return session(typeof next === 'function' ? next(planPath) : next);
  });
  const onSubtaskStuck = vi.fn();
  const config = { specDir, projectDir: specDir, maxRetries: 3, autoContinueDelayMs: 0, runSubtaskSession, onSubtaskStuck } as unknown as SubtaskIteratorConfig;
  const status = (id = 's1') => JSON.parse(readFileSync(planPath, 'utf-8')).phases[0].subtasks.find((s: { id: string }) => s.id === id).status;
  return { config, runSubtaskSession, onSubtaskStuck, status };
}

describe('a coder session that reaches the turn limit', () => {
  it('is not counted as done: a new session continues, told so, and that one finishes it', async () => {
    const { config, runSubtaskSession, status } = setup(['max_steps', 'completed']);

    const result = await iterateSubtasks(config);

    expect(runSubtaskSession).toHaveBeenCalledTimes(2);
    expect(runSubtaskSession.mock.calls[0]).toEqual([expect.objectContaining({ id: 's1' }), 1, false]);
    expect(runSubtaskSession.mock.calls[1]).toEqual([expect.objectContaining({ id: 's1' }), 2, true]);
    expect(status()).toBe('completed');
    expect(result.stuckSubtasks).toEqual([]);
  });

  it('never marks it done while it keeps reaching the limit: it ends stuck, and others still run', async () => {
    const { config, runSubtaskSession, onSubtaskStuck, status } = setup(['max_steps', 'max_steps', 'max_steps', 'completed'], ['s1', 's2']);

    const result = await iterateSubtasks(config);

    expect(runSubtaskSession).toHaveBeenCalledTimes(4);
    expect(result.stuckSubtasks).toEqual(['s1']);
    expect(onSubtaskStuck).toHaveBeenCalledTimes(1);
    expect(status('s1')).not.toBe('completed');
    expect(status('s2')).toBe('completed');
  });

  it('keeps it done if the coder itself had marked it before the limit', async () => {
    const { config, runSubtaskSession, status } = setup([
      (planPath) => {
        const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
        plan.phases[0].subtasks[0].status = 'completed';
        writeFileSync(planPath, JSON.stringify(plan));
        return 'max_steps';
      },
    ]);
    await iterateSubtasks(config);
    expect(runSubtaskSession).toHaveBeenCalledTimes(1);
    expect(status()).toBe('completed');
  });

  it('a normal session still gets marked done even if the coder forgot', async () => {
    const { config, runSubtaskSession, status } = setup(['completed']);
    await iterateSubtasks(config);
    expect(runSubtaskSession).toHaveBeenCalledTimes(1);
    expect(status()).toBe('completed');
  });
});

describe('codingFailure', () => {
  it('stops the build with the names of unfinished subtasks, even if others were done', () => {
    expect(codingFailure(['s1', 's2'])).toContain('s1, s2');
    expect(codingFailure([])).toBeUndefined();
  });
});

describe('a coder session that gives up on its subtask', () => {
  const setStatus = (planPath: string, status: string) => {
    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
    plan.phases[0].subtasks[0].status = status;
    writeFileSync(planPath, JSON.stringify(plan));
  };

  it.each(['failed', 'blocked'])('is not counted as done when it says %s: it ends stuck, once, and others still run', async (given) => {
    const gaveUp = (planPath: string) => {
      setStatus(planPath, given);
      return 'completed' as const;
    };
    const { config, runSubtaskSession, onSubtaskStuck, status } = setup([gaveUp, 'completed'], ['s1', 's2']);

    const result = await iterateSubtasks(config);

    expect(status('s1')).toBe(given);
    expect(result.stuckSubtasks).toEqual(['s1']);
    expect(onSubtaskStuck).toHaveBeenCalledTimes(1);
    expect(runSubtaskSession).toHaveBeenCalledTimes(2);
    expect(status('s2')).toBe('completed');
  });

  it('gets another try on the next run, so Resume is not a dead end', async () => {
    const { config, runSubtaskSession, status } = setup(['completed']);
    setStatus(join(config.specDir, 'implementation_plan.json'), 'failed');

    const result = await iterateSubtasks(config);

    expect(runSubtaskSession).toHaveBeenCalledTimes(1);
    expect(status()).toBe('completed');
    expect(result.stuckSubtasks).toEqual([]);
  });
});

