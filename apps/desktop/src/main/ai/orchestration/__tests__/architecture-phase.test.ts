import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { BuildOrchestrator } from '../build-orchestrator';

function orchestrator(specDir: string, runSession = vi.fn().mockResolvedValue({ outcome: 'completed' })) {
  const generatePrompt = vi.fn().mockResolvedValue('prompt');
  const runQA = vi.fn().mockResolvedValue({ approved: true });
  const o = new BuildOrchestrator({ specDir, projectDir: specDir, generatePrompt, runSession, runQA });
  return { o: o as unknown as { runArchitecturePhase(): Promise<void> }, runSession, generatePrompt };
}

describe('architecture phase', () => {
  it('runs the architect for non-trivial tasks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vtl-ap-'));
    const { o, runSession, generatePrompt } = orchestrator(dir);
    await o.runArchitecturePhase();
    expect(generatePrompt).toHaveBeenCalledWith('architect', 'planning', expect.objectContaining({ attemptCount: 0 }));
    expect(runSession).toHaveBeenCalledWith(expect.objectContaining({ agentType: 'architect', phase: 'planning' }));
  });

  it('skips simple tasks and already-designed specs', async () => {
    const simple = mkdtempSync(join(tmpdir(), 'vtl-ap-'));
    writeFileSync(join(simple, 'complexity_assessment.json'), JSON.stringify({ complexity: 'simple' }));
    const designed = mkdtempSync(join(tmpdir(), 'vtl-ap-'));
    mkdirSync(join(designed, 'architecture'));
    writeFileSync(join(designed, 'architecture', 'architecture.md'), '# Architecture');
    for (const dir of [simple, designed]) {
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
