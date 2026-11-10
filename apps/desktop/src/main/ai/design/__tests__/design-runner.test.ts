import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { readDesignState, writeDesignState } from '../design-step';
import { runDesignStep } from '../design-runner';

function setup(over: Partial<Parameters<typeof runDesignStep>[0]> = {}) {
  const specDir = mkdtempSync(path.join(tmpdir(), 'vtl-drun-'));
  const jobs: string[] = [];
  const runDesigner = vi.fn(async (job: string, _message: string): Promise<{ ok: boolean; error?: string }> => {
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

  it("a designer that fails doesn't stop the build: it goes on without a design and says so", async () => {
    const { deps, specDir } = setup({ runDesigner: vi.fn(async () => ({ ok: false, error: 'rate limited' })) });
    expect(await runDesignStep(deps)).toEqual({});
    expect(readDesignState(specDir)?.stage).toBe('skipped');
    expect(deps.log).toHaveBeenCalledWith(expect.stringMatching(/rate limited/));
    expect(existsSync(path.join(specDir, 'design', 'state.json'))).toBe(true);
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
