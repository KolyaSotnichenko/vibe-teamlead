import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { BuildOrchestrator } from '../build-orchestrator';

function orchestrator(specDir: string, runSession = vi.fn().mockResolvedValue({ outcome: 'completed' })) {
  const generatePrompt = vi.fn().mockResolvedValue('prompt');
  const o = new BuildOrchestrator({ specDir, projectDir: specDir, generatePrompt, runSession });
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
