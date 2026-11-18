import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { readDesignState, writeDesignState } from '../design-step';
import { type DesignerResult, DESIGNER_MAX_WAIT_MS, DESIGNER_RETRIES, designerResultOf, readDesignFailure, runDesignStep, writeDesignFailure } from '../design-runner';

function setup(over: Partial<Parameters<typeof runDesignStep>[0]> = {}) {
  const specDir = mkdtempSync(path.join(tmpdir(), 'vtl-drun-'));
  const jobs: string[] = [];
  const runDesigner = vi.fn(async (job: string, _message: string): Promise<DesignerResult> => {
    jobs.push(job);
    const dir = path.join(specDir, 'design', job === 'wireframes' ? 'wireframes' : 'screens');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'roadmap.html'), '<html></html>');
    return { ok: true };
  });
  const deps = {
    specDir,
    settings: { mode: 'full' as const, approval: 'owner' as const },
    touchesUi: () => true,
    runDesigner,
    checkScreens: vi.fn(() => 0),
    log: vi.fn(),
    ...over,
  };
  return { deps, specDir, jobs, runDesigner };
}

describe('the design step of a build', () => {
  it('draws the wireframes and pauses for the owner', async () => {
    const { deps, specDir, jobs } = setup();
    expect(await runDesignStep(deps)).toEqual({ paused: 'wireframes' });
    expect(jobs).toEqual(['wireframes']);
    expect(readDesignState(specDir)).toMatchObject({ stage: 'wireframes', round: 1 });
  });

  it("takes the owner's comments into one revise round, then pauses again", async () => {
    const { deps, specDir, jobs, runDesigner } = setup();
    writeDesignState(specDir, { stage: 'wireframes', round: 1, comments: [{ n: 1, frame: 'wireframes/roadmap.html', text: 'Votes on cards' }] });
    expect(await runDesignStep(deps)).toEqual({ paused: 'wireframes' });
    expect(jobs).toEqual(['revise']);
    expect(runDesigner.mock.calls[0][1]).toContain('Votes on cards');
    expect(readDesignState(specDir)).toMatchObject({ stage: 'wireframes', round: 2 });
    expect(readDesignState(specDir)?.comments).toBeUndefined();
  });

  it('after approved wireframes draws the design and fixes design-check findings once', async () => {
    const checkScreens = vi.fn().mockReturnValueOnce(3).mockReturnValueOnce(1);
    const { deps, specDir, jobs } = setup({ checkScreens });
    writeDesignState(specDir, { stage: 'wireframes', round: 1, approved: { wireframes: '2026-11-10' } });
    expect(await runDesignStep(deps)).toEqual({ paused: 'design' });
    expect(jobs).toEqual(['design', 'revise']);
    expect(readDesignState(specDir)).toMatchObject({ stage: 'design', approved: { wireframes: '2026-11-10' }, checkFindings: 1 });
  });

  it('goes on once the design is approved, and on its own without pausing', async () => {
    const approved = setup();
    writeDesignState(approved.specDir, { stage: 'design', round: 2, approved: { wireframes: 'a', design: 'b' } });
    expect(await runDesignStep(approved.deps)).toEqual({});

    const auto = setup({ settings: { mode: 'full', approval: 'auto' } });
    expect(await runDesignStep(auto.deps)).toEqual({});
    expect(auto.jobs).toEqual(['wireframes', 'design']);
  });

  it('skips a task that changes no UI, or that the designer finds has none', async () => {
    const noUi = setup({ touchesUi: () => false });
    expect(await runDesignStep(noUi.deps)).toEqual({});
    expect(noUi.runDesigner).not.toHaveBeenCalled();
    expect(readDesignState(noUi.specDir)?.stage).toBe('skipped');

    const none = setup();
    none.runDesigner.mockImplementationOnce(async () => {
      mkdirSync(path.join(none.specDir, 'design'), { recursive: true });
      writeFileSync(path.join(none.specDir, 'design', 'none.md'), 'Only the API changes.');
      return { ok: true };
    });
    expect(await runDesignStep(none.deps)).toEqual({});
    expect(readDesignState(none.specDir)?.stage).toBe('skipped');
  });

  it('waits and tries the designer again on a rate limit, until it draws', async () => {
    const wait = vi.fn(async (_ms: number, _kind: string, _error: string) => true);
    const { deps, specDir, jobs, runDesigner } = setup({ wait });
    const draw = runDesigner.getMockImplementation()!;
    runDesigner
      .mockImplementationOnce(async () => ({ ok: false, error: 'Rate limit reached', kind: 'rate_limited', resetAt: Date.now() + 90_000 }))
      .mockImplementationOnce(async () => ({ ok: false, error: 'Overloaded', kind: 'transient' }))
      .mockImplementationOnce(draw);
    expect(await runDesignStep(deps)).toEqual({ paused: 'wireframes' });
    expect(wait).toHaveBeenCalledTimes(2);
    // The reset time the error carries, then a short backoff
    expect(wait.mock.calls[0][0]).toBeGreaterThanOrEqual(85_000);
    expect(wait.mock.calls[0][0]).toBeLessThanOrEqual(100_000);
    expect(wait.mock.calls[1][1]).toBe('transient');
    expect(jobs).toEqual(['wireframes']);
    expect(readDesignState(specDir)?.stage).toBe('wireframes');
  });

  it('stops for the owner when the designer still fails after the retries; never skips the design itself', async () => {
    const wait = vi.fn(async (_ms: number, _kind: string, _error: string) => true);
    const { deps, specDir, runDesigner } = setup({ wait });
    writeDesignState(specDir, { stage: 'wireframes', round: 1, approved: { wireframes: 'x' } });
    runDesigner.mockImplementation(async () => ({ ok: false, error: 'Rate limit reached', kind: 'rate_limited' }));
    const result = await runDesignStep(deps);
    expect(result).toEqual({ failed: 'Rate limit reached' });
    expect(wait).toHaveBeenCalledTimes(DESIGNER_RETRIES);
    expect(runDesigner).toHaveBeenCalledTimes(DESIGNER_RETRIES + 1);
    // The design stays where it was, so a new start goes on from the same stage
    expect(readDesignState(specDir)).toMatchObject({ stage: 'wireframes', approved: { wireframes: 'x' } });
    expect(readDesignFailure(specDir)).toMatchObject({ error: 'Rate limit reached', job: 'design' });
    expect(deps.log).toHaveBeenCalledWith(expect.stringMatching(/Rate limit reached/));
  });

  it('stops for the owner at once on an error a retry would not fix', async () => {
    const wait = vi.fn(async (_ms: number, _kind: string, _error: string) => true);
    const { deps, specDir } = setup({ wait, runDesigner: vi.fn(async () => ({ ok: false, error: 'Billing error', kind: 'failed' as const })) });
    expect(await runDesignStep(deps)).toEqual({ failed: 'Billing error' });
    expect(wait).not.toHaveBeenCalled();
    expect(readDesignState(specDir)).toBeUndefined();
    expect(readDesignFailure(specDir)?.error).toBe('Billing error');
  });

  it('a cancelled designer leaves the design as it was', async () => {
    const { deps, specDir } = setup({ runDesigner: vi.fn(async () => ({ ok: false, error: 'cancelled', kind: 'cancelled' as const })) });
    writeDesignState(specDir, { stage: 'wireframes', round: 1, approved: { wireframes: 'x' } });
    expect(await runDesignStep(deps)).toEqual({ cancelled: true });
    expect(readDesignState(specDir)).toMatchObject({ stage: 'wireframes', approved: { wireframes: 'x' } });
    expect(readDesignFailure(specDir)).toBeUndefined();
  });

  it('a wait that is cancelled stops the step the same way', async () => {
    const wait = vi.fn(async (_ms: number, _kind: string, _error: string) => false);
    const { deps, specDir } = setup({ wait, runDesigner: vi.fn(async () => ({ ok: false, error: 'Rate limit reached', kind: 'rate_limited' as const })) });
    expect(await runDesignStep(deps)).toEqual({ cancelled: true });
    expect(readDesignState(specDir)).toBeUndefined();
  });

  it('waits at most an hour in all: a reset further away stops for the owner at once', async () => {
    const wait = vi.fn(async () => true);
    const { deps, specDir } = setup({ wait, runDesigner: vi.fn(async () => ({ ok: false, error: 'Rate limit reached', kind: 'rate_limited' as const, resetAt: Date.now() + 2 * 60 * 60_000 })) });
    const result = await runDesignStep(deps);
    expect(wait).not.toHaveBeenCalled();
    expect(result.failed).toMatch(/Rate limit reached/);
    expect(result.failed).toMatch(/60 min/);
    expect(readDesignFailure(specDir)?.error).toBe(result.failed);
  });

  it('stops for the owner when the next wait would go past the hour', async () => {
    const wait = vi.fn(async () => true);
    const runDesigner = vi.fn(async () => ({ ok: false, error: 'Rate limit reached', kind: 'rate_limited' as const, resetAt: Date.now() + 40 * 60_000 }));
    const { deps } = setup({ wait, runDesigner });
    const result = await runDesignStep(deps);
    // 40 min, then another 40 would make 80
    expect(wait).toHaveBeenCalledTimes(1);
    expect(runDesigner).toHaveBeenCalledTimes(2);
    expect(result.failed).toMatch(/60 min/);
    expect(DESIGNER_MAX_WAIT_MS).toBe(60 * 60_000);
  });

  it('tells the wait which try comes and when', async () => {
    const wait = vi.fn(async () => true);
    const { deps, runDesigner } = setup({ wait });
    const draw = runDesigner.getMockImplementation()!;
    runDesigner.mockImplementationOnce(async () => ({ ok: false, error: 'Overloaded', kind: 'transient' })).mockImplementationOnce(draw);
    const before = Date.now();
    await runDesignStep(deps);
    const [ms, kind, error, info] = wait.mock.calls[0] as unknown as [number, string, string, { attempt: number; of: number; until: number }];
    expect([kind, error, info.attempt, info.of]).toEqual(['transient', 'Overloaded', 1, DESIGNER_RETRIES]);
    expect(info.until).toBeGreaterThanOrEqual(before + ms);
  });

  it('the owner stops waiting: the design stops for the owner now', async () => {
    const wait = vi.fn(async () => 'stop' as const);
    const runDesigner = vi.fn(async () => ({ ok: false, error: 'Rate limit reached', kind: 'rate_limited' as const }));
    const { deps, specDir } = setup({ wait, runDesigner });
    const result = await runDesignStep(deps);
    expect(runDesigner).toHaveBeenCalledTimes(1);
    expect(result.failed).toMatch(/Rate limit reached/);
    expect(result.failed).toMatch(/stopped waiting/);
    expect(readDesignFailure(specDir)?.error).toBe(result.failed);
  });

  it('a designer that draws after an earlier failure clears it', async () => {
    const { deps, specDir } = setup();
    writeDesignFailure(specDir, { error: 'Rate limit reached', job: 'wireframes', at: 'x' });
    await runDesignStep(deps);
    expect(readDesignFailure(specDir)).toBeUndefined();
  });

  it('does nothing when design is off', async () => {
    const { deps, runDesigner } = setup({ settings: { mode: 'off', approval: 'owner' } });
    expect(await runDesignStep(deps)).toEqual({});
    expect(runDesigner).not.toHaveBeenCalled();
  });

  it("starts from the project's library and puts the finished design into it, once", async () => {
    const prepareBase = vi.fn();
    const publish = vi.fn();
    const { deps, specDir } = setup({ settings: { mode: 'full', approval: 'auto' }, prepareBase, publish });
    expect(await runDesignStep(deps)).toEqual({});
    expect(prepareBase).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(readDesignState(specDir)?.published).toBe(true);
    // A resumed build doesn't publish it again
    expect(await runDesignStep(deps)).toEqual({});
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('publishes nothing while the owner has not approved, or when there was no UI', async () => {
    const publish = vi.fn();
    const waiting = setup({ publish });
    await runDesignStep(waiting.deps);
    expect(publish).not.toHaveBeenCalled();
    const noUi = setup({ publish, touchesUi: () => false });
    await runDesignStep(noUi.deps);
    expect(publish).not.toHaveBeenCalled();
  });
});

describe('what a designer session ended with', () => {
  it('tells a rate limit, a passing API error, a cancel and anything else apart', () => {
    expect(designerResultOf({ outcome: 'completed' })).toEqual({ ok: true });
    expect(designerResultOf({ outcome: 'max_steps' })).toEqual({ ok: true });
    expect(designerResultOf({ outcome: 'rate_limited', error: { code: 'rate_limited', message: 'Rate limit reached', retryable: true, resetAt: 5 } }))
      .toEqual({ ok: false, kind: 'rate_limited', error: 'Rate limit reached', resetAt: 5 });
    expect(designerResultOf({ outcome: 'cancelled' })).toMatchObject({ ok: false, kind: 'cancelled' });
    expect(designerResultOf({ outcome: 'error', error: { code: 'api_overloaded', message: 'API Error: 529 Overloaded', retryable: true } }))
      .toMatchObject({ ok: false, kind: 'transient' });
    expect(designerResultOf({ outcome: 'error', error: { code: 'generic_error', message: 'socket hang up (ECONNRESET)', retryable: false } }).kind).toBe('transient');
    expect(designerResultOf({ outcome: 'error', error: { code: 'generic_error', message: 'API Error: 503 Service Unavailable', retryable: false } }).kind).toBe('transient');
    expect(designerResultOf({ outcome: 'error', error: { code: 'billing_error', message: 'Billing error on the Anthropic account', retryable: false } }))
      .toEqual({ ok: false, kind: 'failed', error: 'Billing error on the Anthropic account' });
    expect(designerResultOf({ outcome: 'auth_failure', error: { code: 'auth_failure', message: 'Authentication failed', retryable: false } }).kind).toBe('failed');
  });
});
