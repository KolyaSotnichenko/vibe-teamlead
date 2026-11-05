import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { ArchitectMode } from '../../../../shared/types/settings';
import { BuildOrchestrator, architectWanted } from '../build-orchestrator';

function orchestrator(specDir: string, runSession = vi.fn().mockResolvedValue({ outcome: 'completed' }), architectMode?: ArchitectMode) {
  const generatePrompt = vi.fn().mockResolvedValue('prompt');
  const runQA = vi.fn().mockResolvedValue({ approved: true });
  const o = new BuildOrchestrator({ specDir, projectDir: specDir, generatePrompt, runSession, runQA, architectMode });
  return { o: o as unknown as { runArchitecturePhase(): Promise<void> }, runSession, generatePrompt };
}

describe('architecture phase', () => {
  function specDir(assessment?: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'vtl-ap-'));
    if (assessment !== undefined) writeFileSync(join(dir, 'complexity_assessment.json'), assessment);
    return dir;
  }

  it('runs the architect for complex tasks', async () => {
    const { o, runSession, generatePrompt } = orchestrator(specDir(JSON.stringify({ complexity: 'complex' })));
    await o.runArchitecturePhase();
    expect(generatePrompt).toHaveBeenCalledWith('architect', 'planning', expect.objectContaining({ attemptCount: 0 }));
    expect(runSession).toHaveBeenCalledWith(expect.objectContaining({ agentType: 'architect', phase: 'planning' }));
  });

  it('runs the architect when the assessment is missing or unreadable', async () => {
    for (const dir of [specDir(), specDir('not json')]) {
      const { o, runSession } = orchestrator(dir);
      await o.runArchitecturePhase();
      expect(runSession).toHaveBeenCalledWith(expect.objectContaining({ agentType: 'architect' }));
    }
  });

  it('skips simple and standard tasks and already-designed specs', async () => {
    const designed = specDir(JSON.stringify({ complexity: 'complex' }));
    mkdirSync(join(designed, 'architecture'));
    writeFileSync(join(designed, 'architecture', 'architecture.md'), '# Architecture');
    for (const dir of [specDir(JSON.stringify({ complexity: 'simple' })), specDir(JSON.stringify({ complexity: 'standard' })), designed]) {
      const { o, runSession } = orchestrator(dir);
      await o.runArchitecturePhase();
      expect(runSession).not.toHaveBeenCalled();
    }
  });

  it('never fails the build when the architect fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vtl-ap-'));
    const { o } = orchestrator(dir, vi.fn().mockRejectedValue(new Error('boom')));
    await expect(o.runArchitecturePhase()).resolves.toBeUndefined();
  });

  it('"always" runs the architect for simple tasks, "never" skips complex ones', async () => {
    const always = orchestrator(specDir(JSON.stringify({ complexity: 'simple' })), undefined, 'always');
    await always.o.runArchitecturePhase();
    expect(always.runSession).toHaveBeenCalledWith(expect.objectContaining({ agentType: 'architect' }));

    const never = orchestrator(specDir(JSON.stringify({ complexity: 'complex' })), undefined, 'never');
    await never.o.runArchitecturePhase();
    expect(never.runSession).not.toHaveBeenCalled();
  });

  it('"always" still skips an already-designed spec', async () => {
    const designed = specDir(JSON.stringify({ complexity: 'simple' }));
    mkdirSync(join(designed, 'architecture'));
    writeFileSync(join(designed, 'architecture', 'architecture.md'), '# Architecture');
    const { o, runSession } = orchestrator(designed, undefined, 'always');
    await o.runArchitecturePhase();
    expect(runSession).not.toHaveBeenCalled();
  });
});

describe('architectWanted', () => {
  it('"complex" (and the default) wants the architect only for complex or unassessed tasks', () => {
    for (const mode of ['complex', undefined] as const) {
      expect(architectWanted(mode, 'complex')).toBe(true);
      expect(architectWanted(mode, undefined)).toBe(true);
      expect(architectWanted(mode, 'standard')).toBe(false);
      expect(architectWanted(mode, 'simple')).toBe(false);
    }
  });

  it('"always" and "never" ignore the assessment', () => {
    for (const complexity of ['simple', 'standard', 'complex', undefined] as const) {
      expect(architectWanted('always', complexity)).toBe(true);
      expect(architectWanted('never', complexity)).toBe(false);
    }
  });
});

describe('QA phase', () => {
  type Internals = { runQAPhase(): Promise<{ success: boolean; error?: string }>; currentPhase: string };

  function withQA(runQA: (hooks: { onReview(): void; onFix(): void }) => Promise<{ approved: boolean; error?: string }>) {
    const dir = mkdtempSync(join(tmpdir(), 'vtl-qa-'));
    const o = new BuildOrchestrator({
      specDir: dir,
      projectDir: dir,
      generatePrompt: vi.fn().mockResolvedValue('p'),
      runSession: vi.fn(),
      runQA,
    }) as unknown as Internals & { completedPhases: Set<string> };
    // Coding is done when QA starts.
    o.currentPhase = 'coding';
    for (const p of ['planning', 'coding']) (o as unknown as { markPhaseCompleted(p: string): void }).markPhaseCompleted(p);
    return o;
  }

  it('delegates to the shared QA loop and follows its review/fix rounds', async () => {
    const phases: string[] = [];
    const runQA = vi.fn(async (hooks: { onReview(): void; onFix(): void }) => {
      hooks.onReview();
      hooks.onFix();
      hooks.onReview();
      return { approved: true };
    });
    const o = withQA(runQA);
    (o as unknown as { on(e: string, f: (p: string) => void): void }).on('phase-change', (p) => phases.push(p));
    const result = await o.runQAPhase();
    expect(result.success).toBe(true);
    expect(phases).toEqual(['qa_review', 'qa_fixing', 'qa_review', 'complete']);
  });

  it('fails the build with the QA error when QA does not approve', async () => {
    const o = withQA(vi.fn().mockResolvedValue({ approved: false, error: 'Security QA findings remain' }));
    expect(await o.runQAPhase()).toEqual({ success: false, error: 'Security QA findings remain' });
    expect(o.currentPhase).toBe('failed');
  });
});

describe('spec pipeline architecture phase', () => {
  it('designs the architecture before planning for complex tasks only', async () => {
    const { COMPLEXITY_PHASES } = await import('../spec-orchestrator');
    const phases = COMPLEXITY_PHASES.complex;
    expect(phases).toContain('architecture');
    expect(phases.indexOf('architecture')).toBe(phases.indexOf('planning') - 1);
    expect(phases.indexOf('architecture')).toBeGreaterThan(phases.indexOf('spec_writing'));
    expect(COMPLEXITY_PHASES.standard).not.toContain('architecture');
    expect(COMPLEXITY_PHASES.simple).not.toContain('architecture');
  });

  describe('specPhasesFor', () => {
    it('"complex" and the default keep the tier lists', async () => {
      const { COMPLEXITY_PHASES, specPhasesFor } = await import('../spec-orchestrator');
      for (const tier of ['simple', 'standard', 'complex'] as const) {
        expect(specPhasesFor(tier, 'complex')).toEqual(COMPLEXITY_PHASES[tier]);
        expect(specPhasesFor(tier, undefined)).toEqual(COMPLEXITY_PHASES[tier]);
        expect(specPhasesFor(tier, undefined)).not.toBe(COMPLEXITY_PHASES[tier]);
      }
    });

    it('"never" drops the architecture phase from every tier', async () => {
      const { COMPLEXITY_PHASES, specPhasesFor } = await import('../spec-orchestrator');
      for (const tier of ['simple', 'standard', 'complex'] as const) {
        expect(specPhasesFor(tier, 'never')).not.toContain('architecture');
        expect(specPhasesFor(tier, 'never')).toEqual(COMPLEXITY_PHASES[tier].filter((p) => p !== 'architecture'));
      }
    });

    it('"always" designs right before planning in every tier', async () => {
      const { specPhasesFor } = await import('../spec-orchestrator');
      for (const tier of ['simple', 'standard', 'complex'] as const) {
        const phases = specPhasesFor(tier, 'always');
        expect(phases.filter((p) => p === 'architecture')).toHaveLength(1);
        expect(phases.indexOf('architecture')).toBe(phases.indexOf('planning') - 1);
      }
      // Simple tasks: the quick spec writes the spec the architect reads, then the planner re-plans from the architecture
      expect(specPhasesFor('simple', 'always')).toEqual(['quick_spec', 'architecture', 'planning', 'validation']);
      expect(specPhasesFor('standard', 'always')).toEqual(['discovery', 'requirements', 'spec_writing', 'architecture', 'planning', 'validation']);
    });
  });
});
