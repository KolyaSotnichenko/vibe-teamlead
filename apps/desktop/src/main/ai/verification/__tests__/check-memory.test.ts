import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { MAX_BASE_RESULTS, MAX_REPORTS, openCheckMemory } from '../check-memory';
import { type VerificationReport, type VerifyTaskOptions, verifyTask } from '../verify-task';

describe('what the checks already found out is not found out again', () => {
  let repo: string;
  let wt: string;
  let memoryDir: string;
  let ran: string;
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const commit = (cwd: string, message: string) => {
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-q', '-m', message);
  };
  const runs = () => (existsSync(ran) ? readFileSync(ran, 'utf-8').trim().split('\n').length : 0);
  const verify = (over: Partial<VerifyTaskOptions> = {}) => verifyTask({
    worktreePath: wt,
    baseRef: 'main',
    commands: [`echo run >> "${ran}"; test -f good.txt`],
    env: {},
    lockDir: join(repo, '.git', 'verify-lock'),
    memoryDir,
    ...over,
  });

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'vtl-memory-')));
    memoryDir = join(realpathSync(mkdtempSync(join(tmpdir(), 'vtl-memory-home-'))), 'check-results');
    ran = join(repo, 'ran.log');
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'good.txt'), 'yes\n');
    writeFileSync(join(repo, '.gitignore'), '.vibe-teamlead/\nran.log\n');
    commit(repo, 'first');
    wt = join(repo, '.vibe-teamlead', 'worktrees', 'tasks', 't');
    git(repo, 'worktree', 'add', '-q', '-b', 'vibe-teamlead/t', wt);
    writeFileSync(join(wt, 'task.txt'), 'task\n');
    commit(wt, 'task');
  });

  it('a commit that passed is not checked a second time, and the log says so', async () => {
    const first = await verify();
    expect(first.status).toBe('passed');
    expect(first.fromRunAt).toBeUndefined();

    const lines: string[] = [];
    const second = await verify({ onLog: (line) => lines.push(line) });

    expect(runs()).toBe(1);
    expect(second).toMatchObject({ status: 'passed', commit: first.commit, checks: first.checks });
    expect(second.fromRunAt).toEqual(expect.any(String));
    expect(lines).toContainEqual(expect.stringMatching(/^App checks: commit [0-9a-f]{7} was already checked .*not running them again/));
    expect(lines.some((line) => line.includes('a clean copy'))).toBe(false);
  });

  it('a new commit of the task is checked', async () => {
    await verify();
    writeFileSync(join(wt, 'more.txt'), 'more\n');
    commit(wt, 'more');

    const report = await verify();

    expect(runs()).toBe(2);
    expect(report.fromRunAt).toBeUndefined();
  });

  it('a failure is kept as well, with the output the fixer needs', async () => {
    unlinkSync(join(wt, 'good.txt'));
    commit(wt, 'broke it');
    const command = `echo run >> "${ran}"; echo "good.txt is gone"; test -f good.txt`;
    const first = await verify({ commands: [command] });
    expect(first.status).toBe('regression');
    const after = runs();

    const second = await verify({ commands: [command] });

    expect(runs()).toBe(after);
    expect(second.status).toBe('regression');
    expect(second.checks[0]).toMatchObject({ outcome: 'failed', onBase: 'passed', tail: expect.stringContaining('good.txt is gone') });
  });

  it('"Run QA again" runs them anew and keeps the new result', async () => {
    await verify();

    const again = await verify({ fresh: true });
    expect(runs()).toBe(2);
    expect(again.fromRunAt).toBeUndefined();

    await verify();
    expect(runs()).toBe(2);
  });

  it('other commands or other settings are another question', async () => {
    await verify();

    await verify({ env: { FEATURE: 'on' } });
    expect(runs()).toBe(2);

    await verify({ commands: [`echo run >> "${ran}"; test -f task.txt`] });
    expect(runs()).toBe(3);
  });

  it('a check that ran out of time says nothing, so it is not kept', async () => {
    const slow = { commands: [`echo run >> "${ran}"; sleep 5`], checkTimeoutMs: 200, killGraceMs: 100 };
    const first = await verify(slow);
    expect(first.checks[0].outcome).toBe('timed_out');
    const after = runs();

    await verify(slow);

    expect(runs()).toBeGreaterThan(after);
  });

  it('the base is run once for all the commits and runs that start from it', async () => {
    const baseRan = join(repo, 'base-ran.log');
    // Fails on the task (good.txt is gone there), passes on the base and leaves a mark
    const command = `test -f good.txt || exit 1; echo base >> "${baseRan}"`;
    unlinkSync(join(wt, 'good.txt'));
    commit(wt, 'broke it');
    expect((await verify({ commands: [command] })).checks[0]).toMatchObject({ outcome: 'failed', onBase: 'passed' });
    const once = readFileSync(baseRan, 'utf-8');

    writeFileSync(join(wt, 'more.txt'), 'more\n');
    commit(wt, 'still broken');
    const lines: string[] = [];
    const report = await verify({ commands: [command], onLog: (line) => lines.push(line) });

    expect(report.checks[0]).toMatchObject({ outcome: 'failed', onBase: 'passed' });
    expect(report.status).toBe('regression');
    expect(readFileSync(baseRan, 'utf-8')).toBe(once);
    expect(lines.some((line) => line.includes('to see whether the task broke it'))).toBe(false);
  });

  it('keeps the output of a base that fails too, for the next run', async () => {
    const command = 'echo "never.txt is missing"; test -f never.txt';
    await verify({ commands: [command] });
    writeFileSync(join(wt, 'more.txt'), 'more\n');
    commit(wt, 'more');

    const report = await verify({ commands: [command] });

    expect(report.status).toBe('not_verified');
    expect(report.checks[0]).toMatchObject({ onBase: 'failed', tailOnBase: expect.stringContaining('never.txt is missing') });
  });

  it('without a place to keep them, every run checks', async () => {
    await verify({ memoryDir: undefined });
    await verify({ memoryDir: undefined });
    expect(runs()).toBe(2);
  });

  it('keeps one file per project, outside the project', async () => {
    await verify();
    expect(readdirSync(memoryDir)).toHaveLength(1);
    expect(memoryDir.startsWith(repo)).toBe(false);
  });
});

describe('the store itself', () => {
  const report = (commit: string): VerificationReport => ({
    status: 'passed',
    commit,
    baseCommit: 'base',
    checks: [{ name: 'test', command: 'npm test', outcome: 'passed', exitCode: 0 }],
    tamper: [],
    runnerConfigChanged: [],
  });
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vtl-memory-store-'));
  });

  it('keeps the newest results and drops the oldest', () => {
    const memory = openCheckMemory(dir, '/project/.vibe-teamlead/verify.lock');
    for (let i = 0; i < MAX_REPORTS + 5; i++) memory.keepReport(`key-${i}`, report(`commit-${i}`));
    for (let i = 0; i < MAX_BASE_RESULTS + 5; i++) memory.keepBase(`base-${i}`, { outcome: 'passed' });

    const reopened = openCheckMemory(dir, '/project/.vibe-teamlead/verify.lock');
    expect(reopened.report('key-0')).toBeUndefined();
    expect(reopened.report(`key-${MAX_REPORTS + 4}`)?.report.commit).toBe(`commit-${MAX_REPORTS + 4}`);
    expect(reopened.base('base-0')).toBeUndefined();
    expect(reopened.base(`base-${MAX_BASE_RESULTS + 4}`)).toEqual({ outcome: 'passed' });
  });

  it('projects do not see each other', () => {
    openCheckMemory(dir, '/one/.vibe-teamlead/verify.lock').keepReport('key', report('abc'));
    expect(openCheckMemory(dir, '/two/.vibe-teamlead/verify.lock').report('key')).toBeUndefined();
  });

  it('a damaged file is an empty memory, and the next result replaces it', () => {
    const memory = openCheckMemory(dir, '/project/lock');
    memory.keepReport('key', report('abc'));
    writeFileSync(join(dir, readdirSync(dir)[0]), '{ not json');

    const reopened = openCheckMemory(dir, '/project/lock');
    expect(reopened.report('key')).toBeUndefined();
    reopened.keepReport('key', report('def'));
    expect(openCheckMemory(dir, '/project/lock').report('key')?.report.commit).toBe('def');
  });
});
