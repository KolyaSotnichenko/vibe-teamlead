import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { PreviewRecipe, PreviewStatus } from '../../../shared/types/preview';
import type { Project, ProjectSettings } from '../../../shared/types/project';
import { saidFor, say } from '../../say';
import { openFixLedger } from '../fix-ledger';
import type { FixOutcome } from '../fix-start';
import { createStartFixer, type FailedStart, type FixRun, type StartFixerDeps } from '../start-fixer';

const USED: PreviewRecipe = { version: 1, kind: 'web', services: [{ name: 'web', dir: '', command: 'npm run wrong', page: true }] };
const GOOD: PreviewRecipe = { version: 1, kind: 'web', services: [{ name: 'web', dir: '', command: 'npm run dev', page: true }] };
const FAILED: PreviewStatus = { projectId: 'p1', stage: 'failed', origins: [], message: 'web did not start', failedAt: 'services', failedService: 'web', recipe: { source: 'file', kind: 'web' } };
const READY: PreviewStatus = { projectId: 'p1', stage: 'ready', url: 'http://localhost:5173', origins: ['http://localhost:5173'], recipe: { source: 'pending', kind: 'web' } };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(over: Partial<StartFixerDeps> = {}, settings: Partial<ProjectSettings> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'vtl-fixer-'));
  const project = { id: 'p1', path: '/p1', settings: { ...settings } } as unknown as Project;
  const sent: PreviewStatus[] = [];
  const deps: StartFixerDeps = {
    getProject: (id) => (id === 'p1' ? project : undefined),
    updateSettings: vi.fn((_id: string, changed: Partial<ProjectSettings>) => { Object.assign(project.settings, changed); }),
    describe: vi.fn(async () => ({ key: 'k1', recipe: USED, source: 'file' as const, base: 'none' })),
    ledger: (projectId) => openFixLedger(dataDir, projectId),
    hasCredential: () => true,
    fix: vi.fn(async (run: FixRun): Promise<FixOutcome> => {
      run.onTry(1);
      await run.tryRecipe(GOOD);
      return { outcome: 'fixed', recipe: GOOD, summary: 'Команду виправлено.' };
    }),
    tryStart: vi.fn(async () => READY),
    stop: vi.fn(async () => {}),
    settle: vi.fn(),
    send: (status) => { sent.push(status); },
    now: () => new Date('2026-11-23T10:00:00.000Z'),
    ...over,
  };
  const fixer = createStartFixer(deps);
  /** As the handlers do: every status of the session goes through the fixer, then to the page */
  const emit = (status: PreviewStatus) => { sent.push(fixer.onStatus(status)); };
  return { project, deps, fixer, sent, emit, dataDir };
}

describe('the fixer of a failed start', () => {
  it('asks the agent by itself after a failed start, starts the preview by the recipe it proposes, and keeps that recipe', async () => {
    const { project, deps, fixer, sent, emit } = setup();
    emit(FAILED);
    await vi.waitFor(() => expect(sent.at(-1)?.fix).toEqual({ state: 'done', outcome: 'fixed', summary: 'Команду виправлено.' }));
    // While it ran, the page was told so, with the try it was on
    expect(sent.some((s) => s.fix?.state === 'running')).toBe(true);
    expect(sent.some((s) => s.fix?.state === 'running' && s.fix.tries === 1)).toBe(true);
    // The try was the app's own start, with the candidate as the project's recipe that is not in main yet
    const tried = vi.mocked(deps.tryStart).mock.calls[0][0];
    expect(tried.settings.previewPendingRecipe).toMatchObject({ recipe: GOOD, base: 'none', origin: 'agent' });
    // Fixed: the recipe is the project's from now on, and goes on to main
    expect(project.settings.previewPendingRecipe).toMatchObject({ recipe: GOOD, base: 'none', origin: 'agent' });
    expect(deps.settle).toHaveBeenCalledWith('p1');
    expect(sent.at(-1)).toMatchObject({ stage: 'ready' });
    expect(fixer.running()).toBe(false);
  });

  it('passes the failure and the recipe that was used to the agent', async () => {
    const { deps, emit } = setup();
    emit({ ...FAILED, logTail: 'npm error Missing script' });
    await vi.waitFor(() => expect(deps.fix).toHaveBeenCalled());
    expect(vi.mocked(deps.fix).mock.calls[0][0]).toMatchObject({
      failure: { stage: 'services', service: 'web', message: 'web did not start', logTail: 'npm error Missing script' },
      recipe: USED,
      source: 'file',
    });
  });

  it("shows what it found when no recipe can do it, on the failed status, and changes nothing in the project", async () => {
    const missing = [{ what: 'Docker', why: 'потрібен для postgres' }];
    const { project, deps, sent, emit } = setup({ fix: vi.fn(async () => ({ outcome: 'needs_owner' as const, summary: 'Бракує Docker.', missing })) });
    emit(FAILED);
    await vi.waitFor(() => expect(sent.at(-1)?.fix).toEqual({ state: 'done', outcome: 'needs_owner', summary: 'Бракує Docker.', missing }));
    expect(sent.at(-1)).toMatchObject({ stage: 'failed', message: 'web did not start' });
    expect(project.settings.previewPendingRecipe).toBeUndefined();
    expect(deps.settle).not.toHaveBeenCalled();
  });

  it('leaves the failed status of the last try when the agent ends without a recipe that came up', async () => {
    const lastTry: PreviewStatus = { ...FAILED, message: 'web did not get ready', logTail: 'second try' };
    const { sent, emit } = setup({
      tryStart: vi.fn(async () => lastTry),
      fix: vi.fn(async (run: FixRun) => {
        await run.tryRecipe(GOOD);
        return { outcome: 'unknown' as const, summary: 'Не вдалося.' };
      }),
    });
    emit(FAILED);
    await vi.waitFor(() => expect(sent.at(-1)?.fix).toMatchObject({ state: 'done', outcome: 'unknown' }));
    expect(sent.at(-1)).toMatchObject({ stage: 'failed', message: 'web did not get ready', logTail: 'second try' });
  });

  it('asks once for the same failure: the next time it shows what was found', async () => {
    const { deps, sent, emit } = setup({ fix: vi.fn(async () => ({ outcome: 'unknown' as const, summary: 'Не вдалося.' })) });
    emit(FAILED);
    await vi.waitFor(() => expect(sent.at(-1)?.fix?.state).toBe('done'));
    emit({ ...FAILED });
    await vi.waitFor(() => expect(sent.at(-1)?.fix).toEqual({ state: 'done', outcome: 'unknown', summary: 'Не вдалося.' }));
    await tick();
    expect(deps.fix).toHaveBeenCalledTimes(1);
  });

  it('does not start by itself past three runs a day, and offers the button', async () => {
    const { deps, sent, emit } = setup({ fix: vi.fn(async () => ({ outcome: 'unknown' as const, summary: 'x' })) });
    for (let i = 0; i < 4; i++) {
      vi.mocked(deps.describe).mockResolvedValue({ key: `k${i}`, recipe: USED, source: 'file', base: 'none' });
      emit({ ...FAILED });
      await vi.waitFor(() => expect(sent.at(-1)?.fix?.state).toBe(i < 3 ? 'done' : 'idle'));
    }
    expect(deps.fix).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['a task\'s preview', { ...FAILED, taskId: 't1' }, {}],
    ['a recipe of another kind', { ...FAILED, recipe: { source: 'file' as const, kind: 'desktop' as const } }, {}],
    ['a failure before the recipe was known', { ...FAILED, recipe: undefined, failedAt: 'worktree' as const }, {}],
  ])('does nothing for %s', async (_name, status, settings) => {
    const { deps, sent, emit } = setup({}, settings);
    emit(status as PreviewStatus);
    await tick();
    expect(deps.fix).not.toHaveBeenCalled();
    expect(sent.every((s) => s.fix === undefined)).toBe(true);
  });

  it('only offers the button when the owner turned the automatic start off', async () => {
    const { deps, sent, emit } = setup({}, { previewFixAutomatically: false });
    emit(FAILED);
    await vi.waitFor(() => expect(sent.at(-1)?.fix).toEqual({ state: 'idle' }));
    expect(deps.fix).not.toHaveBeenCalled();
  });

  it('runs when the owner asks, whatever was found before and however many ran today', async () => {
    const { deps, fixer, sent, emit } = setup({ fix: vi.fn(async () => ({ outcome: 'unknown' as const, summary: 'x' })) }, { previewFixAutomatically: false });
    emit(FAILED);
    await vi.waitFor(() => expect(sent.at(-1)?.fix).toEqual({ state: 'idle' }));
    expect(await fixer.ask('p1')).toBe(true);
    await vi.waitFor(() => expect(sent.at(-1)?.fix).toMatchObject({ state: 'done', outcome: 'unknown' }));
    expect(await fixer.ask('p1')).toBe(true);
    await vi.waitFor(() => expect(deps.fix).toHaveBeenCalledTimes(2));
    expect(await fixer.ask('other')).toBe(false);
  });

  it('says there is no Claude key instead of starting, and keeps nothing, so it can run once there is one', async () => {
    let key = false;
    const { deps, sent, emit, dataDir } = setup({ hasCredential: () => key });
    emit(FAILED);
    await vi.waitFor(() => expect(sent.at(-1)?.fix).toMatchObject({ state: 'done', outcome: 'unknown' }));
    const fix = sent.at(-1)?.fix as { summary: string; summarySaid?: { key: string } };
    expect(fix.summarySaid?.key).toBe('fixNoCredential');
    expect(saidFor([fix.summary])).toMatchObject([{ key: 'fixNoCredential' }]);
    expect(deps.fix).not.toHaveBeenCalled();
    expect(openFixLedger(dataDir, 'p1').get('k1')).toBeUndefined();
    key = true;
    emit({ ...FAILED });
    await vi.waitFor(() => expect(deps.fix).toHaveBeenCalledTimes(1));
  });

  it('says the session failed, in a sentence the interface can translate, and keeps that as what was found', async () => {
    const { sent, emit, dataDir } = setup({ fix: vi.fn(async () => ({ outcome: 'unknown' as const, summary: 'Rate limit reached', sessionFailed: true as const })) });
    emit(FAILED);
    await vi.waitFor(() => expect(sent.at(-1)?.fix).toMatchObject({ state: 'done', outcome: 'unknown' }));
    const fix = sent.at(-1)?.fix as { summarySaid?: { key: string; params?: Record<string, unknown> } };
    expect(fix.summarySaid).toMatchObject({ key: 'fixFailed', params: { reason: 'Rate limit reached' } });
    expect(openFixLedger(dataDir, 'p1').get('k1')).toBeDefined();
  });

  it('stops when the owner stops it: the session and the start are aborted, and the stop is what is kept', async () => {
    let signal: AbortSignal | undefined;
    const { deps, fixer, sent, emit, dataDir } = setup({
      fix: vi.fn((run: FixRun) => new Promise<FixOutcome>((_resolve, reject) => {
        signal = run.signal;
        run.signal.addEventListener('abort', () => reject(new Error('aborted')));
      })),
    });
    emit(FAILED);
    await vi.waitFor(() => expect(fixer.running()).toBe(true));
    await fixer.cancel();
    expect(signal?.aborted).toBe(true);
    expect(deps.stop).toHaveBeenCalledWith('p1');
    await vi.waitFor(() => expect(sent.at(-1)?.fix).toMatchObject({ state: 'done', outcome: 'unknown', summarySaid: { key: 'fixStoppedByOwner' } }));
    expect(sent.at(-1)).toMatchObject({ stage: 'failed', message: 'web did not start' });
    expect(fixer.running()).toBe(false);
    // So it does not start again by itself for this failure
    expect(openFixLedger(dataDir, 'p1').get('k1')?.outcome).toMatchObject({ outcome: 'unknown' });
  });

  it('stops without a word when the preview itself is stopped, as when the owner leaves it', async () => {
    const { fixer, sent, emit, dataDir } = setup({
      fix: vi.fn((run: FixRun) => new Promise<FixOutcome>((_resolve, reject) => { run.signal.addEventListener('abort', () => reject(new Error('aborted'))); })),
    });
    emit(FAILED);
    await vi.waitFor(() => expect(fixer.running()).toBe(true));
    const before = sent.length;
    fixer.previewStopped();
    await vi.waitFor(() => expect(fixer.running()).toBe(false));
    await tick();
    expect(sent.slice(before)).toEqual([]);
    expect(openFixLedger(dataDir, 'p1').get('k1')).toBeUndefined();
  });

  it('does not ask again for the failed tries of its own run, and forgets a result once a new start begins', async () => {
    const { deps, sent, emit } = setup({
      fix: vi.fn(async (run: FixRun) => {
        // The try's own statuses pass through the fixer like any others
        emit({ ...FAILED, message: 'still wrong' });
        await run.tryRecipe(GOOD);
        return { outcome: 'unknown' as const, summary: 'x' };
      }),
      tryStart: vi.fn(async () => ({ ...FAILED, message: 'still wrong' })),
    });
    emit(FAILED);
    await vi.waitFor(() => expect(sent.at(-1)?.fix?.state).toBe('done'));
    expect(deps.fix).toHaveBeenCalledTimes(1);
    emit({ projectId: 'p1', stage: 'worktree', origins: [] });
    expect(sent.at(-1)?.fix).toBeUndefined();
  });

  it('does not keep a recipe whose preview came up and then stopped before the agent ended', async () => {
    const { project, deps, sent, emit } = setup({
      fix: vi.fn(async (run: FixRun) => {
        await run.tryRecipe(GOOD);
        // A service stops a few seconds after it was up, while the agent writes its summary
        emit({ ...FAILED, failedAt: 'ready', message: 'api stopped', stoppedService: 'api' });
        return { outcome: 'fixed' as const, recipe: GOOD, summary: 'Команду виправлено.' };
      }),
    });
    emit(FAILED);
    await vi.waitFor(() => expect(sent.at(-1)?.fix?.state).toBe('done'));
    const fix = sent.at(-1)?.fix as { outcome: string; summarySaid?: { key: string } };
    expect(fix.outcome).toBe('unknown');
    expect(fix.summarySaid?.key).toBe('fixDidNotHold');
    expect(sent.at(-1)).toMatchObject({ stage: 'failed', message: 'api stopped' });
    expect(project.settings.previewPendingRecipe).toBeUndefined();
    expect(deps.settle).not.toHaveBeenCalled();
  });

  it("says in the app's words what changed when the agent's own words are the app's", async () => {
    const summary = say('fixNoSummary', "The app started the project by the agent's last recipe; the agent's session ended before it said what it changed.");
    const { sent, emit } = setup({ fix: vi.fn(async (run: FixRun) => { await run.tryRecipe(GOOD); return { outcome: 'fixed' as const, recipe: GOOD, summary }; }) });
    emit(FAILED);
    await vi.waitFor(() => expect(sent.at(-1)?.fix?.state).toBe('done'));
    expect(sent.at(-1)?.fix).toMatchObject({ outcome: 'fixed', summarySaid: { key: 'fixNoSummary' } });
  });

  it('counts a run stopped half-way toward the day, so leaving and coming back does not start one each time', async () => {
    const { deps, fixer, sent, emit } = setup({
      fix: vi.fn((run: FixRun) => new Promise<FixOutcome>((_resolve, reject) => { run.signal.addEventListener('abort', () => reject(new Error('aborted'))); })),
    });
    for (let i = 0; i < 4; i++) {
      vi.mocked(deps.describe).mockResolvedValue({ key: `k${i}`, recipe: USED, source: 'file', base: 'none' });
      emit({ ...FAILED });
      if (i < 3) {
        await vi.waitFor(() => expect(fixer.running()).toBe(true));
        await fixer.previewStopped();
      } else {
        await vi.waitFor(() => expect(sent.at(-1)?.fix).toEqual({ state: 'idle' }));
      }
    }
    expect(deps.fix).toHaveBeenCalledTimes(3);
  });

  it('does not start by itself again for a failure the owner stopped it on', async () => {
    const { deps, fixer, sent, emit } = setup({
      fix: vi.fn((run: FixRun) => new Promise<FixOutcome>((_resolve, reject) => { run.signal.addEventListener('abort', () => reject(new Error('aborted'))); })),
    });
    emit(FAILED);
    await vi.waitFor(() => expect(fixer.running()).toBe(true));
    await fixer.cancel();
    emit({ ...FAILED });
    await vi.waitFor(() => expect(sent.at(-1)?.fix).toMatchObject({ state: 'done', outcome: 'unknown', summarySaid: { key: 'fixStoppedByOwner' } }));
    expect(deps.fix).toHaveBeenCalledTimes(1);
  });

  it('waits for a try that is starting when it is stopped, then stops that preview, and starts no other', async () => {
    let finishStart: (status: PreviewStatus) => void = () => {};
    const order: string[] = [];
    const { deps, fixer, emit } = setup({
      tryStart: vi.fn(() => new Promise<PreviewStatus>((resolve) => { finishStart = (status) => { order.push('try ended'); resolve(status); }; })),
      stop: vi.fn(async () => { order.push('stopped'); }),
      fix: vi.fn(async (run: FixRun) => {
        await run.tryRecipe(GOOD).catch(() => undefined);
        // Asked again after the stop: refused, nothing starts
        await run.tryRecipe(GOOD).catch(() => undefined);
        return { outcome: 'unknown' as const, summary: 'x' };
      }),
    });
    emit(FAILED);
    await vi.waitFor(() => expect(deps.tryStart).toHaveBeenCalledTimes(1));
    const stopped = fixer.previewStopped();
    finishStart(READY);
    await stopped;
    expect(order).toEqual(['try ended', 'stopped']);
    expect(deps.stop).toHaveBeenCalledWith('p1');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(deps.tryStart).toHaveBeenCalledTimes(1);
  });

  it('asks again about the failure the owner saw, not the last try of the run before', async () => {
    const { deps, fixer, sent, emit } = setup({
      tryStart: vi.fn(async () => ({ ...FAILED, failedAt: 'ready' as const, failedService: 'other', message: 'other stopped' })),
      fix: vi.fn(async (run: FixRun) => {
        await run.tryRecipe(GOOD);
        return { outcome: 'unknown' as const, summary: 'x' };
      }),
    });
    emit(FAILED);
    await vi.waitFor(() => expect(sent.at(-1)?.fix?.state).toBe('done'));
    expect(await fixer.ask('p1')).toBe(true);
    const asked = vi.mocked(deps.describe).mock.calls.at(-1)?.[1];
    expect(asked).toMatchObject({ failedAt: 'services', failedService: 'web', message: 'web did not start' });
  });

  it('starts nothing for a failure the owner left before it was looked up', async () => {
    let answer: (info: { key: string; recipe: typeof USED; source: 'file'; base: string }) => void = () => {};
    const { deps, fixer, emit } = setup({ describe: vi.fn(() => new Promise<FailedStart | null>((resolve) => { answer = resolve; })) });
    emit(FAILED);
    await vi.waitFor(() => expect(deps.describe).toHaveBeenCalled());
    await fixer.previewStopped();
    answer({ key: 'k1', recipe: USED, source: 'file', base: 'none' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(deps.fix).not.toHaveBeenCalled();
  });

  it('keeps saying what the agent changed while the preview it fixed is up, and no longer after it stops', async () => {
    const { sent, emit } = setup();
    emit(FAILED);
    await vi.waitFor(() => expect(sent.at(-1)?.fix?.state).toBe('done'));
    emit({ ...READY, servicesNotices: ['x'] });
    expect(sent.at(-1)?.fix).toMatchObject({ outcome: 'fixed' });
    emit({ projectId: 'p1', stage: 'stopped', origins: [] });
    emit({ ...READY });
    expect(sent.at(-1)?.fix).toBeUndefined();
  });
});

describe('the check before a start', () => {
  const INFO: FailedStart = { key: 'check-k', recipe: USED, source: 'proposal', base: 'none' };

  it('has the agent check the project and try its recipe; one that came up is kept, and the started preview is the answer', async () => {
    const { project, deps, fixer, sent } = setup();
    const status = await fixer.check(project, INFO, { changed: ['apps/api/migrations/0023_email.sql'] });
    expect(vi.mocked(deps.fix).mock.calls[0][0]).toMatchObject({ failure: {}, recipe: USED, source: 'proposal', check: { changed: ['apps/api/migrations/0023_email.sql'] } });
    expect(sent.some((s) => s.fix?.state === 'running' && s.fix.check === true)).toBe(true);
    expect(status).toMatchObject({ stage: 'ready', fix: { state: 'done', outcome: 'fixed' } });
    expect(project.settings.previewPendingRecipe).toMatchObject({ recipe: GOOD, origin: 'agent' });
    expect(deps.settle).toHaveBeenCalledWith('p1');
    expect(fixer.running()).toBe(false);
  });

  it('counts toward the day: past three runs it does not check, and the start goes on as before', async () => {
    const { project, deps, fixer } = setup();
    for (let i = 0; i < 3; i += 1) await fixer.check(project, { ...INFO, key: `k${i}` }, { changed: [], first: true });
    expect(await fixer.check(project, { ...INFO, key: 'k4' }, { changed: [], first: true })).toBeNull();
    expect(deps.fix).toHaveBeenCalledTimes(3);
  });

  it('does not run when the owner turned the agent off, or without a key', async () => {
    const off = setup({}, { previewFixAutomatically: false });
    expect(await off.fixer.check(off.project, INFO, { changed: [], first: true })).toBeNull();
    const nokey = setup({ hasCredential: () => false });
    expect(await nokey.fixer.check(nokey.project, INFO, { changed: [], first: true })).toBeNull();
    expect(off.deps.fix).not.toHaveBeenCalled();
    expect(nokey.deps.fix).not.toHaveBeenCalled();
  });

  it("shows what it found on the last try's status when it could not make it start, and does not start a second agent for it", async () => {
    const missing = [{ what: 'Docker', why: 'потрібен для postgres' }];
    const { project, deps, fixer, emit } = setup({
      fix: vi.fn(async (run: FixRun): Promise<FixOutcome> => {
        await run.tryRecipe(GOOD);
        return { outcome: 'needs_owner', summary: 'Бракує Docker.', missing };
      }),
    });
    vi.mocked(deps.tryStart).mockImplementation(async () => {
      emit(FAILED);
      return FAILED;
    });
    const status = await fixer.check(project, INFO, { changed: [], first: true });
    expect(status).toMatchObject({ stage: 'failed', fix: { state: 'done', outcome: 'needs_owner', summary: 'Бракує Docker.' } });
    await tick();
    expect(deps.fix).toHaveBeenCalledTimes(1);
  });
});
