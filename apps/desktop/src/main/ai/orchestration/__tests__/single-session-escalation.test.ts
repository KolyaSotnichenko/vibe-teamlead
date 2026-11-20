/**
 * A task one session could not finish goes on under the short pipeline: the same
 * build, run again, plans what is left and codes it in subtasks (pipeline-choice.ts;
 * the worker joins the two runs).
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { BuildOrchestrator, type SessionRunConfig } from '../build-orchestrator';
import { decidedPipeline, escalateSingleSession, recordPipeline, singleSessionRanOut, writeSingleSessionPlan } from '../pipeline-choice';

const PLAN = 'implementation_plan.json';

const REPLANNED = {
  feature: 'Sea battle',
  workflow_type: 'feature',
  phases: [
    {
      id: '1',
      name: 'What is left',
      subtasks: [
        { id: '1-1', title: 'Commit what works', description: 'Bring the uncommitted work to a passing commit', status: 'pending' },
        { id: '1-2', title: 'Finish the board', description: 'AC-3: a ship cannot be placed over another', status: 'pending' },
      ],
    },
  ],
};

async function task() {
  const specDir = mkdtempSync(join(tmpdir(), 'vtl-escalation-'));
  await recordPipeline(specDir, { kind: 'single', by: 'assessor', reason: 'assessed' });
  await writeSingleSessionPlan(specDir, { title: 'Sea battle', description: 'A sea battle game.' });
  const plan = () => JSON.parse(readFileSync(join(specDir, PLAN), 'utf-8'));
  return { specDir, plan };
}

function build(specDir: string, runSession: (config: SessionRunConfig) => Promise<unknown>) {
  const run = vi.fn(runSession);
  const runQA = vi.fn().mockResolvedValue({ approved: true });
  const orchestrator = new BuildOrchestrator({
    specDir,
    projectDir: specDir,
    architectMode: 'never',
    autoContinueDelayMs: 0,
    generatePrompt: vi.fn().mockResolvedValue('prompt'),
    runSession: run as never,
    runQA,
  });
  return { orchestrator, run, runQA, agents: () => run.mock.calls.map(([config]) => config.agentType) };
}

/** A coder that always reaches its turn limit without finishing */
const outOfTurns = async () => ({ outcome: 'max_steps', stepsExecuted: 120, durationMs: 1 });

describe('one session that could not finish', () => {
  it('the build stops and says which subtask ran out of tries, without reaching QA', async () => {
    const { specDir } = await task();
    const first = build(specDir, outOfTurns);

    const outcome = await first.orchestrator.run();

    expect(outcome.success).toBe(false);
    expect(outcome.stuckSubtasks).toEqual(['1-1']);
    expect(outcome.gaveUpSubtasks).toEqual([]);
    expect(first.agents()).toEqual(['coder', 'coder', 'coder']);
    expect(first.runQA).not.toHaveBeenCalled();
    expect(singleSessionRanOut('single', outcome, false)).toBe(true);
  });

  it('goes on under the short pipeline: a planner plans what is left, coders build it, QA follows', async () => {
    const { specDir, plan } = await task();
    await build(specDir, outOfTurns).orchestrator.run();

    expect(await escalateSingleSession(specDir)).toBe(true);
    const second = build(specDir, async (config) => {
      const current = plan();
      if (config.agentType === 'planner') {
        writeFileSync(join(specDir, PLAN), JSON.stringify({ ...current, ...REPLANNED }));
      } else if (config.agentType === 'coder') {
        for (const phase of current.phases) for (const subtask of phase.subtasks) if (subtask.id === config.subtaskId) subtask.status = 'completed';
        writeFileSync(join(specDir, PLAN), JSON.stringify(current));
      }
      return { outcome: 'completed', stepsExecuted: 5, durationMs: 1 };
    });

    const outcome = await second.orchestrator.run();

    expect(second.agents()).toEqual(['planner', 'coder', 'coder']);
    expect(second.run.mock.calls.filter(([config]) => config.agentType === 'coder').map(([config]) => config.subtaskId)).toEqual(['1-1', '1-2']);
    expect(second.runQA).toHaveBeenCalledTimes(1);
    expect(outcome.success).toBe(true);
    expect((await decidedPipeline(specDir))?.kind).toBe('short');
  });

  it('a build that works is left alone', async () => {
    const { specDir, plan } = await task();
    const only = build(specDir, async (config) => {
      const current = plan();
      for (const phase of current.phases) for (const subtask of phase.subtasks) if (subtask.id === config.subtaskId) subtask.status = 'completed';
      writeFileSync(join(specDir, PLAN), JSON.stringify(current));
      return { outcome: 'completed', stepsExecuted: 5, durationMs: 1 };
    });

    const outcome = await only.orchestrator.run();

    expect(only.agents()).toEqual(['coder']);
    expect(outcome.success).toBe(true);
    expect(outcome.stuckSubtasks).toBeUndefined();
    expect(singleSessionRanOut('single', outcome, false)).toBe(false);
  });
});
