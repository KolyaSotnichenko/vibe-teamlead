import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { BuildOrchestrator } from '../build-orchestrator';

function build(designStep: () => Promise<{ paused?: 'wireframes' | 'design'; failed?: string; cancelled?: boolean }>) {
  const dir = mkdtempSync(join(tmpdir(), 'vtl-dso-'));
  const runSession = vi.fn().mockResolvedValue({ outcome: 'cancelled' });
  const o = new BuildOrchestrator({
    specDir: dir,
    projectDir: dir,
    generatePrompt: vi.fn().mockResolvedValue('prompt'),
    runSession,
    runQA: vi.fn().mockResolvedValue({ approved: true }),
    architectMode: 'never',
    designStep,
  });
  return { o, runSession };
}

describe('the build after the design step', () => {
  it('stops for the owner when the designer could not draw, and plans nothing', async () => {
    const { o, runSession } = build(async () => ({ failed: 'Rate limit reached' }));
    const outcome = await o.run();
    expect(outcome.designFailed).toBe('Rate limit reached');
    expect(outcome.success).toBe(false);
    expect(runSession).not.toHaveBeenCalled();
  });

  it('stops as cancelled when the task was stopped during the design', async () => {
    const { o, runSession } = build(async () => ({ cancelled: true }));
    const outcome = await o.run();
    expect(outcome).toMatchObject({ success: false, error: 'Build cancelled' });
    expect(outcome.designFailed).toBeUndefined();
    expect(runSession).not.toHaveBeenCalled();
  });
});
