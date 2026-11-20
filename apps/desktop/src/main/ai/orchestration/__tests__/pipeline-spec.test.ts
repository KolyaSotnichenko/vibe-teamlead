import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { PipelineKind } from '../../../../shared/pipeline';
import { SpecOrchestrator, type SpecOrchestratorConfig, type SpecSessionRunConfig } from '../spec-orchestrator';

const PLAN = JSON.stringify({
  feature: 'x',
  workflow_type: 'simple',
  phases: [{ id: '1', name: 'Build', subtasks: [{ id: '1-1', title: 'Do it', description: 'Do it', status: 'pending' }] }],
});

const OUTPUTS: Record<string, Record<string, string>> = {
  discovery: { 'context.json': '{}' },
  requirements: { 'requirements.json': '{}' },
  spec_writing: { 'spec.md': '# x' },
  architecture: { 'architecture/architecture.md': '# x' },
  planning: { 'implementation_plan.json': PLAN },
  quick_spec: { 'spec.md': '# x', 'implementation_plan.json': PLAN },
};

/** A fake session that writes each phase's files, so the orchestrator moves on */
function fakeRun(specDir: string) {
  return vi.fn(async (cfg: SpecSessionRunConfig) => {
    for (const [file, content] of Object.entries(OUTPUTS[cfg.specPhase] ?? {})) {
      mkdirSync(dirname(join(specDir, file)), { recursive: true });
      writeFileSync(join(specDir, file), content);
    }
    return { outcome: 'completed', toolCallCount: 1 } as never;
  });
}

function run(options: Partial<SpecOrchestratorConfig> & { taskDescription?: string }) {
  const specDir = mkdtempSync(join(tmpdir(), 'vtl-pipeline-spec-'));
  const runSession = fakeRun(specDir);
  const orchestrator = new SpecOrchestrator({
    specDir,
    projectDir: specDir,
    taskDescription: 'Build the reports page with filters, export and a chart for every project of the workspace',
    complexityOverride: 'standard',
    architectMode: 'always',
    generatePrompt: vi.fn().mockResolvedValue('prompt'),
    runSession,
    ...options,
  });
  return { outcome: orchestrator.run(), runSession };
}

const phasesRun = (runSession: ReturnType<typeof fakeRun>) => [...new Set(runSession.mock.calls.map(([cfg]) => cfg.specPhase))];

describe('the spec under each pipeline', () => {
  it('short: the quick spec whatever the tier, and no architect even when the setting says always', async () => {
    const { outcome, runSession } = run({ pipeline: 'short' });
    const result = await outcome;
    expect(result).toMatchObject({ success: true, pipeline: 'short' });
    expect(phasesRun(runSession)).toEqual(['quick_spec', 'validation']);
  });

  it('full: the phases of the tier, as before', async () => {
    const { outcome, runSession } = run({ pipeline: 'full' });
    expect((await outcome).pipeline).toBe('full');
    expect(phasesRun(runSession)).toEqual(['discovery', 'requirements', 'spec_writing', 'architecture', 'planning', 'validation']);
  });

  it('no pipeline given and nobody to ask: as before', async () => {
    const { outcome, runSession } = run({});
    expect((await outcome).pipeline).toBeUndefined();
    expect(phasesRun(runSession)).toContain('discovery');
  });

  it('Auto: asks once the complexity is known, and one session means no spec sessions at all', async () => {
    const choosePipeline = vi.fn<(assessment: unknown) => PipelineKind>().mockReturnValue('single');
    // Short and about a label: the heuristic calls it simple without a model
    const { outcome, runSession } = run({ complexityOverride: undefined, taskDescription: 'Rename the label on the save button', choosePipeline });
    const result = await outcome;
    expect(result).toMatchObject({ success: true, pipeline: 'single' });
    expect(choosePipeline).toHaveBeenCalledTimes(1);
    expect(choosePipeline.mock.calls[0][0]).toMatchObject({ complexity: 'simple' });
    expect(runSession).not.toHaveBeenCalled();
  });

  it('Auto choosing short runs the quick spec; choosing full runs the tier', async () => {
    const short = run({ choosePipeline: () => 'short' });
    await short.outcome;
    expect(phasesRun(short.runSession)).toEqual(['quick_spec', 'validation']);

    const full = run({ choosePipeline: () => 'full' });
    await full.outcome;
    expect(phasesRun(full.runSession)).toContain('requirements');
  });

  it('a pipeline decided before the spec is not asked about again', async () => {
    const choosePipeline = vi.fn<() => PipelineKind>().mockReturnValue('single');
    const { outcome, runSession } = run({ pipeline: 'full', choosePipeline });
    await outcome;
    expect(choosePipeline).not.toHaveBeenCalled();
    expect(runSession).toHaveBeenCalled();
  });
});
