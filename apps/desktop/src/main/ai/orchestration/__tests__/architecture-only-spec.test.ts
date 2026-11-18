import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { SpecOrchestrator, type SpecSessionRunConfig } from '../spec-orchestrator';

const OUTPUTS: Record<string, string> = {
  discovery: 'context.json',
  requirements: 'requirements.json',
  spec_writing: 'spec.md',
  architecture: 'architecture/architecture.md',
};

/** A fake session that writes each phase's file, so the orchestrator moves on */
function fakeRun(specDir: string, failArchitect = false) {
  return vi.fn(async (cfg: SpecSessionRunConfig) => {
    if (cfg.specPhase === 'architecture' && failArchitect) return { outcome: 'error', error: { message: 'boom' } } as never;
    const file = OUTPUTS[cfg.specPhase];
    if (file) {
      mkdirSync(dirname(join(specDir, file)), { recursive: true });
      writeFileSync(join(specDir, file), file.endsWith('.json') ? '{}' : '# x');
    }
    return { outcome: 'completed', toolCallCount: 1 } as never;
  });
}

function run(options: { architectureOnly?: boolean; failArchitect?: boolean; planAfterDesign?: boolean; architectMode?: 'always' | 'never' }) {
  const specDir = mkdtempSync(join(tmpdir(), 'vtl-arch-only-'));
  const runSession = fakeRun(specDir, options.failArchitect);
  const orchestrator = new SpecOrchestrator({
    specDir,
    projectDir: specDir,
    taskDescription: 'Design the cloud architecture of this project, its services and how they connect',
    complexityOverride: 'standard',
    architectMode: options.architectMode ?? 'always',
    architectureOnly: options.architectureOnly,
    planAfterDesign: () => !!options.planAfterDesign,
    generatePrompt: vi.fn().mockResolvedValue('prompt'),
    runSession,
  });
  return { outcome: orchestrator.run(), runSession };
}

const phasesRun = (runSession: ReturnType<typeof fakeRun>) => [...new Set(runSession.mock.calls.map(([cfg]) => cfg.specPhase))];

describe('Architecture-only spec', () => {
  it('runs the spec and the architect, then stops: no planner, no validation', async () => {
    const { outcome, runSession } = run({ architectureOnly: true });
    const result = await outcome;
    expect(result.success).toBe(true);
    expect(phasesRun(runSession)).toEqual(['discovery', 'requirements', 'spec_writing', 'architecture']);
  });

  it('fails when the architect fails, since the architecture is all it makes', async () => {
    const { outcome, runSession } = run({ architectureOnly: true, failArchitect: true });
    const result = await outcome;
    expect(result.success).toBe(false);
    expect(phasesRun(runSession)).not.toContain('planning');
  });

  it("fails clearly when the architect is turned off", async () => {
    const { outcome, runSession } = run({ architectureOnly: true, architectMode: 'never' });
    const result = await outcome;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/architect/i);
    expect(runSession).not.toHaveBeenCalled();
  });

  it('is not postponed by design-before-code', async () => {
    const { outcome, runSession } = run({ architectureOnly: true, planAfterDesign: true });
    await outcome;
    expect(phasesRun(runSession)).toContain('architecture');
  });

  it('ordinary tasks still go on to the planner after the architect', async () => {
    const { outcome, runSession } = run({});
    await outcome;
    expect(phasesRun(runSession)).toEqual(expect.arrayContaining(['architecture', 'planning']));
  });
});
