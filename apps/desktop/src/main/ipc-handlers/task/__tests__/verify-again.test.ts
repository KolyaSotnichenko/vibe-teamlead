import { describe, expect, it, vi } from 'vitest';

import type { VerificationReport } from '../../../ai/verification/verify-task';
import { verifyAgain, type VerifyAgainDeps } from '../verify-again';

const REPORT: VerificationReport = { status: 'passed', commit: 'abc1234', baseCommit: 'base123', checks: [{ name: 'test', command: 'pnpm run test', outcome: 'passed' }], tamper: [], runnerConfigChanged: [] } as unknown as VerificationReport;

function setup(over: Partial<VerifyAgainDeps> = {}) {
  const order: string[] = [];
  const deps: VerifyAgainDeps = {
    status: 'human_review',
    worktree: '/p/.vibe-teamlead/worktrees/tasks/027-x',
    stopContainers: vi.fn(async () => { order.push('stop'); }),
    verify: vi.fn(async () => { order.push('verify'); return REPORT; }),
    write: vi.fn(async () => { order.push('write'); }),
    regression: vi.fn(),
    ...over,
  };
  return { deps, order };
}

describe('verifyAgain', () => {
  it("stops what the task's agents left running, runs the checks anew, and keeps what they found for the window", async () => {
    const { deps, order } = setup();
    const summary = await verifyAgain(deps);
    expect(order).toEqual(['stop', 'verify', 'write']);
    expect(deps.verify).toHaveBeenCalledWith({ fresh: true });
    expect(summary).toMatchObject({ status: 'passed', checks: [{ command: 'pnpm run test', outcome: 'passed' }] });
    expect(vi.mocked(deps.write).mock.calls[0][0]).toEqual(summary);
    expect(deps.regression).not.toHaveBeenCalled();
  });

  it('says so when the checks now find that the task broke something', async () => {
    const { deps } = setup({ verify: vi.fn(async () => ({ ...REPORT, status: 'regression' }) as VerificationReport) });
    await verifyAgain(deps);
    expect(deps.regression).toHaveBeenCalled();
  });

  it('runs only for a task waiting for review, with a folder to check', async () => {
    await expect(verifyAgain(setup({ status: 'in_progress' }).deps)).rejects.toThrow(/waiting for your review/);
    await expect(verifyAgain(setup({ worktree: null }).deps)).rejects.toThrow(/no folder/);
  });

  it('checks once at a time per task: a second ask while one runs is refused', async () => {
    let finish: (report: VerificationReport) => void = () => {};
    const { deps } = setup({ key: 'p1/t1', verify: vi.fn(() => new Promise<VerificationReport>((resolve) => { finish = resolve; })) });
    const first = verifyAgain(deps);
    await vi.waitFor(() => expect(deps.verify).toHaveBeenCalled());
    await expect(verifyAgain(deps)).rejects.toThrow(/already running/);
    finish(REPORT);
    await first;
    await expect(verifyAgain({ ...deps, verify: vi.fn(async () => REPORT) })).resolves.toMatchObject({ status: 'passed' });
  });
});
