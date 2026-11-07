import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { BuildOrchestrator } from '../build-orchestrator';

const PLAN = 'implementation_plan.json';

function specDir(plan?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'vtl-epfr-'));
  if (plan !== undefined) writeFileSync(join(dir, PLAN), plan);
  return dir;
}

function orchestrator(dir: string, runSession = vi.fn().mockResolvedValue({ outcome: 'cancelled' })) {
  const o = new BuildOrchestrator({
    specDir: dir,
    projectDir: dir,
    generatePrompt: vi.fn().mockResolvedValue('prompt'),
    runSession,
    runQA: vi.fn().mockResolvedValue({ approved: true }),
    architectMode: 'never',
  });
  return { o, runSession };
}

// What the app itself leaves behind to keep a task's status while no plan exists.
const STATUS_ONLY = JSON.stringify({ feature: 'Task', status: 'queue', xstateState: 'backlog', phases: [] });

describe('a plan file that only holds the task status', () => {
  it('sends the task to the planner instead of failing validation', async () => {
    const { o, runSession } = orchestrator(specDir(STATUS_ONLY));

    await o.run();

    expect(runSession).toHaveBeenCalledWith(expect.objectContaining({ agentType: 'planner' }));
  });

  it('still counts a missing plan as a first run', async () => {
    const { o, runSession } = orchestrator(specDir());

    await o.run();

    expect(runSession).toHaveBeenCalledWith(expect.objectContaining({ agentType: 'planner' }));
  });

  it('does not re-plan a plan that has work in it, so progress survives a resume', async () => {
    const plan = JSON.stringify({
      feature: 'Task',
      phases: [{ id: 'p1', name: 'One', subtasks: [{ id: 's1', description: 'Do it', status: 'completed' }] }],
    });
    const { o, runSession } = orchestrator(specDir(plan));

    await o.run();

    expect(runSession).not.toHaveBeenCalledWith(expect.objectContaining({ agentType: 'planner' }));
  });

  it('reports a broken plan file rather than planning over it', async () => {
    const { o, runSession } = orchestrator(specDir('{ not json'));

    const outcome = await o.run();

    expect(runSession).not.toHaveBeenCalledWith(expect.objectContaining({ agentType: 'planner' }));
    expect(outcome.success).toBe(false);
  });
});
