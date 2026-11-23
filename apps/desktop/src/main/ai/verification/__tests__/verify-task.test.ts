import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DockerRun } from '../test-services';
import { describeVerification, failureSummary, onlyAddsTestFiles, type TamperFinding, verificationEnv, verificationIsConclusive, verificationIssues, verificationSummary, verifyTask, withVerifyLock, type VerifyTaskOptions } from '../verify-task';
import { isWindowsHost } from '../../../platform/__tests__/host';

describe('verifyTask', () => {
  let repo: string;
  let wt: string;
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const commit = (cwd: string, message: string) => {
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-q', '-m', message);
  };
  const verify = (over: Partial<VerifyTaskOptions> = {}) => verifyTask({
    worktreePath: wt,
    baseRef: 'main',
    commands: ['test -f good.txt'],
    env: {},
    lockDir: join(repo, '.git', 'verify-lock'),
    ...over,
  });

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'vtl-verify-')));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'good.txt'), 'yes\n');
    writeFileSync(join(repo, '.gitignore'), '.vibe-teamlead/\n');
    commit(repo, 'first');
    wt = join(repo, '.vibe-teamlead', 'worktrees', 'tasks', 't');
    git(repo, 'worktree', 'add', '-q', '-b', 'vibe-teamlead/t', wt);
    writeFileSync(join(wt, 'task.txt'), 'task\n');
    commit(wt, 'task');
  });

  it('passes when the checks pass, and says on which commit', async () => {
    const report = await verify();
    expect(report.status).toBe('passed');
    expect(report.commit).toBe(git(wt, 'rev-parse', 'HEAD'));
    expect(report.checks).toMatchObject([{ command: 'test -f good.txt', outcome: 'passed' }]);
  });

  it('says in the task log what it is doing and how each check ended, with its time', async () => {
    const lines: string[] = [];
    await verify({ commands: ['test -f good.txt', 'test -f never.txt'], onLog: (line) => lines.push(line) });
    expect(lines).toContainEqual(expect.stringMatching(/^App checks: a clean copy of [0-9a-f]{7}/));
    expect(lines).toContain('App checks: running test -f good.txt');
    expect(lines).toContainEqual(expect.stringMatching(/^App checks: test -f good\.txt passed in \d+(\.\d)?s$/));
    expect(lines).toContainEqual(expect.stringMatching(/^App checks: test -f never\.txt failed in /));
    expect(lines).toContain('App checks: test -f never.txt failed: running it on main to see whether the task broke it');
    expect(lines).toContainEqual(expect.stringMatching(/^App checks: on main, test -f never\.txt failed too/));
  });

  it('blocks a failure the task brought: the same check passes on the base', async () => {
    unlinkSync(join(wt, 'good.txt'));
    commit(wt, 'task broke it');
    const report = await verify();
    expect(report.status).toBe('regression');
    expect(report.checks[0]).toMatchObject({ outcome: 'failed', onBase: 'passed' });
  });

  it("doesn't blame the task for a failure the base has too: it just couldn't verify", async () => {
    const report = await verify({ commands: ['test -f never.txt'] });
    expect(report.status).toBe('not_verified');
    expect(report.checks[0]).toMatchObject({ outcome: 'failed', onBase: 'failed' });
  });

  it('checks what is committed: uncommitted work in the folder is not the task', async () => {
    writeFileSync(join(wt, 'only-here.txt'), 'x\n');
    const report = await verify({ commands: ['test -f only-here.txt'] });
    expect(report.status).toBe('not_verified');
    expect(report.checks[0].outcome).toBe('failed');
  });

  it('does not touch the task folder', async () => {
    await verify({ commands: ['touch made-by-check.txt'] });
    expect(existsSync(join(wt, 'made-by-check.txt'))).toBe(false);
    expect(git(wt, 'status', '--porcelain')).toBe('');
  });

  it('removes its copy afterwards', async () => {
    const pathFile = join(repo, 'where.txt');
    await verify({ commands: [`pwd > "${pathFile}"`] });
    expect(existsSync(readFileSync(pathFile, 'utf-8').trim())).toBe(false);
  });

  it('runs a failed check once more: a flaky test is not a regression', async () => {
    const marker = join(repo, 'first-try');
    const report = await verify({ commands: [`test -f "${marker}" || { touch "${marker}"; exit 1; }`] });
    expect(report.status).toBe('passed');
    expect(report.checks[0]).toMatchObject({ outcome: 'passed', flaky: true });
  });

  it('gives the base a second try as well: a flaky test there would hide what the task broke', async () => {
    unlinkSync(join(wt, 'good.txt'));
    commit(wt, 'broke');
    const marker = join(repo, 'base-first-try');
    // Fails for good without good.txt; with it, only the first time
    const report = await verify({ commands: [`test -f good.txt || exit 1; test -f "${marker}" || { touch "${marker}"; exit 1; }`] });
    expect(report.status).toBe('regression');
    expect(report.checks[0].onBase).toBe('passed');
  });

  it('keeps the output of the base too, when the base fails as well', async () => {
    const report = await verify({ commands: ['echo from-the-run; exit 1'] });
    expect(report.checks[0].tailOnBase).toContain('from-the-run');
  });

  it('keeps the end of the output, from the failing check', async () => {
    const report = await verify({ commands: ['echo the-reason; exit 3'] });
    expect(report.checks[0].tail).toContain('the-reason');
    expect(report.checks[0].exitCode).toBe(3);
  });

  it('a tool that is not installed is not a failure of the task', async () => {
    const report = await verify({ commands: ['definitely-not-a-tool-xyz --run'] });
    expect(report.status).toBe('not_verified');
    expect(report.checks[0].outcome).toBe('unavailable');
  });

  it('a check that runs out of time blocks nothing, and says so', async () => {
    const report = await verify({ commands: ['sleep 30'], checkTimeoutMs: 50 });
    expect(report.status).toBe('not_verified');
    expect(report.checks[0].outcome).toBe('timed_out');
  });

  describe('a slow machine is not a broken task', () => {
    const stallsOnce = (marker: string) => `test -f "${marker}" || { touch "${marker}"; sleep 30; }`;
    // Git Bash starts slowly on Windows: give the first run time to leave its marker
    const limitMs = isWindowsHost ? 5000 : 400;

    // On the Windows CI runner the first run now and then finishes inside the limit (seen once,
    // passed on the runs around it); the timeout logic itself marks a fired timer as timed out
    it('runs a check that ran out of time once more before believing it', { timeout: 60_000, retry: isWindowsHost ? 2 : 0 }, async () => {
      const report = await verify({ commands: [stallsOnce(join(repo, 'stalled'))], checkTimeoutMs: limitMs });
      expect(report.status).toBe('passed');
      expect(report.checks[0]).toMatchObject({ outcome: 'passed', flaky: true });
    });

    it('runs an install that ran out of time once more before believing it', async () => {
      const report = await verify({ commands: undefined, installTimeoutMs: limitMs, detected: { install: [stallsOnce(join(repo, 'stalled'))], checks: [{ name: 'ok', command: 'true' }] } });
      expect(report.status).toBe('passed');
    }, 60_000);
  });

  describe("a task can't make a failure look like something else", () => {
    it('exit 127 that the base does not give is the task breaking the check', async () => {
      unlinkSync(join(wt, 'good.txt'));
      commit(wt, 'broke');
      const report = await verify({ commands: ['test -f good.txt || exit 127'] });
      expect(report.status).toBe('regression');
      expect(report.checks[0]).toMatchObject({ outcome: 'unavailable', onBase: 'passed' });
    });

    it('running out of time where the base does not is the task breaking the check', async () => {
      unlinkSync(join(wt, 'good.txt'));
      commit(wt, 'broke');
      const report = await verify({ commands: ['test -f good.txt || sleep 30'], checkTimeoutMs: 400 });
      expect(report.status).toBe('regression');
      expect(report.checks[0]).toMatchObject({ outcome: 'timed_out', onBase: 'passed' });
    });
  });

  it('keeps the project\'s secrets out of the output it passes on', async () => {
    const report = await verify({ commands: ['echo "url is $DATABASE_URL"; exit 1'], env: { DATABASE_URL: 'postgres://u:hunter2@h/db' } });
    expect(report.checks[0].tail).not.toContain('hunter2');
    expect(report.checks[0].tail).toContain('url is');
  });

  it("doesn't leave part of a secret at the cut where the output is trimmed", async () => {
    const secret = 'hunter2-long-secret-value';
    const filler = 'x'.repeat(3990 - 'tail'.length);
    const report = await verify({ commands: [`echo "\${SECRET}${filler}"; exit 1`], env: { SECRET: secret } });
    expect(report.checks[0].tail).not.toContain('value');
    expect(report.checks[0].tail).not.toContain('secret');
  });

  it('survives a process that holds its output open after being killed', async () => {
    const started = Date.now();
    const report = await verify({ commands: ['(setsid sleep 60 2>/dev/null || sleep 60) & wait'], checkTimeoutMs: 50, killGraceMs: 50 });
    expect(report.checks[0].outcome).toBe('timed_out');
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);

  describe('the project starts', () => {
    type Starts = NonNullable<VerifyTaskOptions['startsCheck']>;
    /** A stand-in for starting the project: the copy has its own answer */
    const startsBy = (answer: (cwd: string, files: string[]) => Awaited<ReturnType<Starts>>) =>
      vi.fn<Starts>(async (o) => answer(o.cwd, o.files));
    /** Passes where good.txt is in the copy, fails where it is not */
    const byGoodFile = startsBy((cwd) => (existsSync(join(cwd, 'good.txt')) ? { outcome: 'passed' } : { outcome: 'failed', tail: 'web did not start\nMissing script: dev' }));

    it('is one of the checks, and passes when the project starts', async () => {
      const report = await verify({ startsCheck: byGoodFile });
      expect(report.status).toBe('passed');
      expect(report.checks.map((c) => c.name)).toEqual(['test -f good.txt', 'starts']);
      expect(report.checks[1]).toMatchObject({ name: 'starts', command: 'start the project by its recipe', outcome: 'passed' });
    });

    it('blocks a task that makes the project stop starting, when the base starts', async () => {
      const startsCheck = startsBy((cwd) => (existsSync(join(cwd, 'task.txt')) ? { outcome: 'failed', tail: 'web did not start' } : { outcome: 'passed' }));
      const report = await verify({ startsCheck });
      expect(report.status).toBe('regression');
      expect(report.checks.find((c) => c.name === 'starts')).toMatchObject({ outcome: 'failed', onBase: 'passed', tail: 'web did not start' });
    });

    it('does not block a task when the base does not start either', async () => {
      const startsCheck = startsBy(() => ({ outcome: 'failed', tail: 'web did not start' }));
      const report = await verify({ startsCheck });
      expect(report.status).toBe('not_verified');
      expect(report.checks.find((c) => c.name === 'starts')).toMatchObject({ outcome: 'failed', onBase: 'failed', tailOnBase: 'web did not start' });
    });

    it('is absent for a project with nothing to start, and says what it could not tell', async () => {
      expect((await verify({ startsCheck: startsBy(() => null) })).checks.map((c) => c.name)).toEqual(['test -f good.txt']);
      const unavailable = await verify({ startsCheck: startsBy(() => ({ outcome: 'unavailable', tail: 'Port 10000 is in use' })) });
      expect(unavailable.status).toBe('not_verified');
      expect(unavailable.checks.find((c) => c.name === 'starts')).toMatchObject({ outcome: 'unavailable' });
    });

    it("gives the check the copy's files, the saved services, and why it can't say anything when a compose port is taken", async () => {
      writeFileSync(join(repo, 'docker-compose.yml'), 'services:\n  azurite:\n    image: mcr.microsoft.com/azure-storage/azurite\n    ports: ["10000:10000"]\n    healthcheck: { test: ["CMD", "true"] }\n');
      commit(repo, 'azurite');
      git(wt, 'merge', '-q', '--no-edit', 'main');
      let readInCopy: string | null = null;
      const startsCheck = vi.fn<Starts>(async (o) => {
        readInCopy = o.read('good.txt');
        return { outcome: 'passed' };
      });
      const docker: DockerRun = async (args) => (args[0] === 'run' ? { ok: true, stdout: 'c1\n' } : args[0] === 'port' ? { ok: true, stdout: '127.0.0.1:50000\n' } : { ok: true, stdout: '' });
      const saved = [{ name: 'site', dir: '', command: 'make serve', page: true }];
      await verify({ startsCheck, docker, previewServices: saved, hostPortFree: async (port) => port !== 10000 });
      const given = startsCheck.mock.calls[0][0];
      expect(given.files).toEqual(expect.arrayContaining(['good.txt', 'task.txt', 'docker-compose.yml']));
      expect(readInCopy).toBe('yes\n');
      expect(given.saved).toEqual(saved);
      expect(given.cannot).toMatch(/Port 10000 is in use/);
      expect(given.cannotWhy).toEqual({ reason: 'port', ports: [10000] });
      // What the base starts by its files, so a service that is no longer found is noticed
      expect(given.expectServices).toEqual(['site'])
      // Its own name for this run's servers
      expect(given.runId).toMatch(/^[0-9a-f]{6,}$/);
    });

    it('runs even when the project has no other check', async () => {
      const report = await verify({ commands: undefined, detected: { install: [], checks: [] }, previewServices: [{ name: 'site', dir: '', command: 'make serve', page: true }], startsCheck: byGoodFile });
      expect(report.checks.map((c) => c.name)).toEqual(['starts']);
      expect(report.status).toBe('passed');
    });

    it("lists a changed preview.json for the reviewer, and does not block a new project's first task on it alone", async () => {
      writeFileSync(join(wt, 'preview.json'), '{"version":1,"kind":"web"}\n');
      commit(wt, 'recipe');
      const report = await verify({ startsCheck: byGoodFile });
      expect(report.runnerConfigChanged).toContain('preview.json');
    });

    it('says in the report and to QA that the project no longer starts, with what failed', async () => {
      const startsCheck = startsBy((cwd) => (existsSync(join(cwd, 'task.txt')) ? { outcome: 'failed', tail: 'web did not start\nnpm error Missing script: "dev"' } : { outcome: 'passed' }));
      const report = await verify({ startsCheck });
      expect(describeVerification(report)).toMatch(/- The project starts: FAILED \(passes on the base: this task broke it\)/);
      const unavailable = await verify({ startsCheck: startsBy(() => ({ outcome: 'unavailable', tail: 'Port 10000 is in use' })) });
      expect(describeVerification(unavailable)).toMatch(/- The project starts: could not be judged: Port 10000 is in use/);
      const issue = verificationIssues(report).find((i) => i.key === 'check:start the project by its recipe');
      expect(issue).toMatchObject({ title: 'The project no longer starts: it starts on the commit this task started from' });
      expect(issue?.description).toContain('Missing script');
      expect(issue?.fix_required).toMatch(/preview\.json/);
    });

    it("never blocks on a start it could not judge on the task, even when the base started: a service may be gone on purpose", async () => {
      const startsCheck = startsBy((cwd) => (existsSync(join(cwd, 'task.txt')) ? { outcome: 'unavailable', tail: 'The project started, but without api' } : { outcome: 'passed' }));
      const report = await verify({ startsCheck });
      expect(report.status).toBe('not_verified');
      expect(verificationIssues(report)).toEqual([]);
    });

    it("tells the check whether the copy may be migrated: never when the owner's settings name a database", async () => {
      const startsCheck = startsBy(() => ({ outcome: 'passed' }));
      await verify({ startsCheck, env: { DATABASE_URL: 'postgres://owners-dev-db' } });
      expect(startsCheck.mock.calls[0][0].migratable).toBe(false);
    });

    it('gives the check the run\'s time for checks', async () => {
      const startsCheck = startsBy(() => ({ outcome: 'passed' }));
      await verify({ startsCheck, checkTimeoutMs: 12_345 });
      expect(startsCheck.mock.calls[0][0].timeoutMs).toBe(12_345);
    });

    it('says nothing was checked, not that checks passed, when there was nothing to run and nothing started', async () => {
      writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'a-library' }));
      commit(repo, 'a library');
      git(wt, 'merge', '-q', '--no-edit', 'main');
      const report = await verify({ commands: undefined, detected: { install: [], checks: [] }, startsCheck: startsBy(() => null) });
      expect(report.status).toBe('not_configured');
    });

    it("keeps the end of a recipe step's output, where the error is, and keeps the project's values out of it", async () => {
      let output = '';
      const startsCheck = vi.fn<Starts>(async (o) => {
        const result = await o.runCommand(`printf 'banner\\n%.0s' $(seq 1 400); echo "secret is $OWN"; echo the real error`, o.cwd, {});
        output = result.output;
        return { outcome: 'passed' };
      });
      await verify({ startsCheck, env: { OWN: 'owner-value-123' } });
      expect(output).toContain('the real error');
      expect(output).not.toContain('owner-value-123');
    });

    it("can't say anything about the start when the copy is without the database or services it needs", async () => {
      writeFileSync(join(repo, 'docker-compose.yml'), 'services:\n  db:\n    image: postgres:18-alpine\n');
      commit(repo, 'compose');
      git(wt, 'merge', '-q', '--no-edit', 'main');
      const startsCheck = startsBy(() => ({ outcome: 'passed' }));
      await verify({ startsCheck, docker: async () => ({ ok: false, stdout: '' }) });
      expect(startsCheck.mock.calls[0][0].cannot).toMatch(/Docker/);
      expect(startsCheck.mock.calls[0][0].cannotWhy).toEqual({ reason: 'services' });
    });

    it('does not make a copy of the base for a start it could not judge on the task', async () => {
      const startsCheck = startsBy(() => ({ outcome: 'unavailable', tail: 'Port 10000 is in use' }));
      await verify({ startsCheck });
      expect(startsCheck).toHaveBeenCalledTimes(1);
    });

    it('names in the report why a start could not be judged, without calling it the task\'s fault', async () => {
      const startsCheck = startsBy((cwd) => (existsSync(join(cwd, 'task.txt')) ? { outcome: 'unavailable', why: { reason: 'missing', names: ['api'] }, tail: 'The project started, but without api' } : { outcome: 'passed' }));
      const report = await verify({ startsCheck });
      const text = describeVerification(report);
      expect(text).toMatch(/- The project starts: could not be judged: The project started, but without api/);
      expect(text).not.toMatch(/The project starts[^\n]*this task broke it/);
      expect(verificationSummary(report).checks.find((c) => c.command === 'start the project by its recipe')).toEqual({ command: 'start the project by its recipe', outcome: 'unavailable', why: { reason: 'missing', names: ['api'] } });
    });

    it("makes no QA issue of a new project's own start", async () => {
      const report = { status: 'not_verified' as const, commit: 'c', baseCommit: 'b', checks: [{ name: 'starts', command: 'start the project by its recipe', outcome: 'failed' as const, tail: 'x' }], tamper: [], runnerConfigChanged: [], source: 'task' as const };
      expect(verificationIssues(report)).toEqual([]);
    });

    it('is started again only when its failure was a port in use, not for any failure', async () => {
      const startsCheck = startsBy(() => ({ outcome: 'failed', tail: 'web did not start' }));
      await verify({ startsCheck });
      // Once on the task, once on the base
      expect(startsCheck).toHaveBeenCalledTimes(2);
      const busy = vi.fn<Starts>().mockResolvedValueOnce({ outcome: 'failed', tail: 'Error: listen EADDRINUSE: address already in use :::3000' }).mockResolvedValue({ outcome: 'passed' });
      const report = await verify({ startsCheck: busy });
      expect(report.checks.find((c) => c.name === 'starts')).toMatchObject({ outcome: 'passed', flaky: true });
    });
  });

  describe("a database the project's tests need", () => {
    const fakeDocker = () => {
      const calls: string[][] = [];
      let next = 0;
      const docker: DockerRun = async (args) => {
        calls.push(args);
        if (args[0] === 'run') return { ok: true, stdout: `container-${++next}\n` };
        if (args[0] === 'port') return { ok: true, stdout: '127.0.0.1:50000\n' };
        if (args[0] === 'ps') return { ok: true, stdout: '' };
        return { ok: true, stdout: '' };
      };
      return { docker, calls };
    };

    beforeEach(() => {
      writeFileSync(join(repo, 'docker-compose.yml'), 'services:\n  db:\n    image: postgres:18-alpine\n');
      mkdirSync(join(repo, 'apps', 'api'), { recursive: true });
      writeFileSync(join(repo, 'apps', 'api', '.env.example'), 'CSRF_SECRET=from-example\nDATABASE_URL=postgres://real.example.com/prod\n');
      commit(repo, 'compose');
      git(wt, 'merge', '-q', '--no-edit', 'main');
    });

    it('starts it by itself, gives the checks its address and the example settings, and removes it', async () => {
      const { docker, calls } = fakeDocker();
      const report = await verify({ docker, commands: ['case "$DATABASE_URL" in postgresql://verify:*@127.0.0.1:50000/verify) ;; *) exit 1;; esac; test "$CSRF_SECRET" = from-example'] });
      expect(report.status).toBe('passed');
      expect(report.services).toEqual({ status: 'started', images: ['postgres:18-alpine'] });
      expect(calls).toContainEqual(['rm', '-f', '-v', 'container-1']);
    });

    it('says when the database is up and when the migrations run', async () => {
      const { docker } = fakeDocker();
      const lines: string[] = [];
      await verify({ docker, commands: ['true'], detected: { install: [], prepare: ['true'], checks: [] }, onLog: (line) => lines.push(line) });
      expect(lines).toContain('App checks: starting postgres:18-alpine for this copy');
      expect(lines).toContain('App checks: database up');
      expect(lines).toContain('App checks: migrations: true');
    });

    it('runs migrations once the database is up, and a broken one is the task breaking things', async () => {
      const { docker } = fakeDocker();
      unlinkSync(join(wt, 'good.txt'));
      commit(wt, 'broke');
      const report = await verify({ docker, commands: ['true'], detected: { install: [], prepare: ['test -f good.txt'], checks: [] } });
      expect(report.status).toBe('regression');
      expect(report.checks[0]).toMatchObject({ name: 'prepare', onBase: 'passed' });
    });

    it('gives the task and the base each their own empty database', async () => {
      const { docker, calls } = fakeDocker();
      unlinkSync(join(wt, 'good.txt'));
      commit(wt, 'broke');
      await verify({ docker, commands: ['test -f good.txt'] });
      expect(calls.filter((call) => call[0] === 'run')).toHaveLength(2);
      expect(calls).toContainEqual(['rm', '-f', '-v', 'container-2']);
    });

    it("keeps the project's own value when it set one", async () => {
      const { docker } = fakeDocker();
      const report = await verify({ docker, env: { DATABASE_URL: 'postgres://mine' }, commands: ['test "$DATABASE_URL" = postgres://mine'] });
      expect(report.status).toBe('passed');
    });

    it('hides the temporary password in what it passes on', async () => {
      const { docker } = fakeDocker();
      const report = await verify({ docker, commands: ['echo "url is $DATABASE_URL"; exit 1'] });
      expect(report.checks[0].tail).toContain('url is');
      expect(report.checks[0].tail).not.toMatch(/verify:[a-f0-9]{32}@/);
    });

    it('without Docker it still runs what it can, blocks nothing and says why', async () => {
      const docker: DockerRun = async () => ({ ok: false, stdout: '' });
      const report = await verify({ docker, commands: ['test -n "$DATABASE_URL"'] });
      expect(report.status).toBe('not_verified');
      expect(report.services?.status).toBe('unavailable');
      expect(describeVerification(report)).toMatch(/Docker/);
    });

    it("with no checks on the base, the task's database comes with its own commands", async () => {
      const { docker, calls } = fakeDocker();
      git(repo, 'rm', '-q', 'docker-compose.yml', 'apps/api/.env.example');
      commit(repo, 'base without compose');
      const empty = join(repo, '.vibe-teamlead', 'worktrees', 'tasks', 'first');
      git(repo, 'worktree', 'add', '-q', '-b', 'vibe-teamlead/first', empty);
      writeFileSync(join(empty, 'docker-compose.yml'), 'services:\n  db:\n    image: postgres:17-alpine\n');
      writeFileSync(join(empty, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', scripts: { test: 'test -n "$DATABASE_URL"' } }));
      commit(empty, 'first task');
      const report = await verify({ worktreePath: empty, commands: undefined, docker });
      expect(report.source).toBe('task');
      expect(calls.find((call) => call[0] === 'run')?.at(-1)).toBe('postgres:17-alpine');
      expect(report.status).toBe('passed');
    });

    it('starts the other compose services too, points the example settings at them, and removes them', async () => {
      writeFileSync(join(repo, 'docker-compose.yml'), [
        'services:',
        '  db:',
        '    image: postgres:18-alpine',
        '  rabbitmq:',
        '    image: rabbitmq:3',
        '    volumes: ["/:/host"]',
        '    environment: { RABBITMQ_DEFAULT_USER: app, RABBITMQ_DEFAULT_PASS: s3cretpass }',
        '    healthcheck: { test: ["CMD", "rabbitmq-diagnostics", "ping"] }',
        '',
      ].join('\n'));
      writeFileSync(join(repo, 'apps', 'api', '.env.example'), 'CSRF_SECRET=from-example\nAMQP_URL=amqp://guest:guest@rabbitmq:5672\n');
      commit(repo, 'rabbitmq');
      git(wt, 'merge', '-q', '--no-edit', 'main');
      const { docker, calls } = fakeDocker();
      const lines: string[] = [];
      const report = await verify({ docker, commands: ['test "$AMQP_URL" = amqp://app:s3cretpass@127.0.0.1:50000 && echo "amqp ok $AMQP_URL"; exit 1'], onLog: (line) => lines.push(line) });
      const runs = calls.filter((call) => call[0] === 'run');
      expect(runs.map((call) => call.at(-1))).toContain('rabbitmq:3');
      expect(runs.find((call) => call.includes('rabbitmq:3'))?.join(' ')).not.toMatch(/-v |\/host/);
      expect(report.services).toEqual({ status: 'started', images: ['postgres:18-alpine', 'rabbitmq:3'] });
      expect(lines).toContain('App checks: starting rabbitmq for this copy');
      expect(lines).toContain('App checks: rabbitmq up');
      expect(report.checks[0].tail).toContain('amqp ok');
      expect(report.checks[0].tail).not.toContain('s3cretpass');
      expect(calls).toContainEqual(['network', 'rm', expect.stringMatching(/^vibe-teamlead-verify-/)]);
    });

    describe("the compose file's own ports", () => {
      const AZURITE = 'services:\n  azurite:\n    image: mcr.microsoft.com/azure-storage/azurite\n    ports: ["10000:10000"]\n    healthcheck: { test: ["CMD", "true"] }\n';
      /** A docker that publishes what it is asked to, and can refuse a fixed port in the base's copy */
      const portDocker = (refuseInCopy?: number) => {
        const calls: string[][] = [];
        let next = 0;
        let composeRuns = 0;
        const fixed = new Map<string, string>();
        const docker: DockerRun = async (args) => {
          calls.push(args);
          if (args[0] === 'run') {
            const publish = args.filter((_, i) => args[i - 1] === '-p');
            if (args.includes('mcr.microsoft.com/azure-storage/azurite')) {
              const wantsFixed = publish.some((p) => /^127\.0\.0\.1:\d+:\d+$/.test(p));
              if (wantsFixed) composeRuns += 1;
              if (wantsFixed && refuseInCopy === composeRuns) return { ok: false, stdout: 'Bind for 127.0.0.1:10000 failed: port is already allocated' };
            }
            const id = `container-${++next}`;
            const own = publish.map((p) => /^127\.0\.0\.1:(\d+):(\d+)$/.exec(p)).find(Boolean);
            if (own) fixed.set(id, own[1]);
            return { ok: true, stdout: `${id}\n` };
          }
          if (args[0] === 'port') return { ok: true, stdout: `127.0.0.1:${fixed.get(args[1]) ?? '50000'}\n` };
          return { ok: true, stdout: '' };
        };
        return { docker, calls, publishes: () => calls.filter((c) => c[0] === 'run' && c.includes('mcr.microsoft.com/azure-storage/azurite')).map((c) => c.filter((_, i) => c[i - 1] === '-p')) };
      };

      beforeEach(() => {
        writeFileSync(join(repo, 'docker-compose.yml'), AZURITE);
        commit(repo, 'azurite');
        git(wt, 'merge', '-q', '--no-edit', 'main');
        // The task breaks the check, so the base's copy runs too
        unlinkSync(join(wt, 'good.txt'));
        commit(wt, 'broke');
      });

      it('puts both copies on the ports the compose file names when all are free', async () => {
        const { docker, publishes } = portDocker();
        const report = await verify({ docker, hostPortFree: async () => true });
        expect(publishes()).toEqual([['127.0.0.1:10000:10000'], ['127.0.0.1:10000:10000']]);
        expect(report.status).toBe('regression');
      });

      it('keeps free ports for both copies when one the compose file names is in use', async () => {
        const { docker, publishes } = portDocker();
        await verify({ docker, hostPortFree: async (port) => port !== 10000 });
        expect(publishes()).toEqual([['127.0.0.1::10000'], ['127.0.0.1::10000']]);
      });

      it("does not call it the task's fault when the base's copy had to move a port: the two ran apart", async () => {
        const { docker } = portDocker(2);
        const lines: string[] = [];
        const report = await verify({ docker, hostPortFree: async () => true, onLog: (line) => lines.push(line) });
        expect(report.status).toBe('not_verified');
        expect(report.checks[0]).toMatchObject({ outcome: 'failed', onBase: 'unavailable' });
        expect(lines.some((line) => /10000/.test(line) && /moved|another port/i.test(line))).toBe(true);
      });
    });

    it("puts the database and the other services on one network of the run's, each under its compose name, and removes it", async () => {
      writeFileSync(join(repo, 'docker-compose.yml'), 'services:\n  postgres:\n    image: postgres:18-alpine\n  keycloak:\n    image: quay.io/keycloak/keycloak:26\n    environment: { KC_DB_URL: "jdbc:postgresql://postgres:5432/kc" }\n');
      commit(repo, 'keycloak');
      git(wt, 'merge', '-q', '--no-edit', 'main');
      const { docker, calls } = fakeDocker();
      await verify({ docker, commands: ['true'] });
      const created = calls.find((call) => call[0] === 'network' && call[1] === 'create');
      const network = created?.at(-1) ?? '';
      expect(network).toMatch(/^vibe-teamlead-verify-/);
      const runs = calls.filter((call) => call[0] === 'run');
      expect(runs.find((call) => call.includes('postgres:18-alpine'))?.join(' ')).toContain(`--network ${network} --network-alias postgres`);
      expect(runs.find((call) => call.includes('quay.io/keycloak/keycloak:26'))?.join(' ')).toContain(`--network ${network} --network-alias keycloak`);
      // One network per run: the services make none of their own
      expect(new Set(calls.filter((call) => call[0] === 'network' && call[1] === 'create').map((call) => call.at(-1)))).toEqual(new Set([network]));
      const lastRm = calls.map((call) => call.join(' ')).lastIndexOf(`network rm ${network}`);
      expect(lastRm).toBeGreaterThan(calls.map((call) => call[0]).lastIndexOf('rm'));
    });

    it('a task cannot choose the image: it comes from the base', async () => {
      const { docker, calls } = fakeDocker();
      writeFileSync(join(wt, 'docker-compose.yml'), 'services:\n  db:\n    image: postgres-evil:1\n');
      commit(wt, 'task swaps the image');
      await verify({ docker });
      expect(calls.find((call) => call[0] === 'run')?.at(-1)).toBe('postgres:18-alpine');
    });
  });

  describe('migrations can only ever touch the temporary database', () => {
    const composeWith = (image: string) => {
      writeFileSync(join(repo, 'docker-compose.yml'), `services:\n  db:\n    image: ${image}\n`);
      commit(repo, 'compose');
      git(wt, 'merge', '-q', '--no-edit', 'main');
    };
    const docker: DockerRun = async (args) => {
      if (args[0] === 'run') return { ok: true, stdout: 'c1\n' };
      if (args[0] === 'port') return { ok: true, stdout: '127.0.0.1:50000\n' };
      return { ok: true, stdout: '' };
    };
    const ran = () => join(repo, 'migration-ran');
    const check = (over: Partial<VerifyTaskOptions> = {}) => verify({ commands: ['true'], detected: { install: [], prepare: [`touch "${ran()}"`], checks: [] }, ...over });

    it('run nowhere without a database it started: an example file can point at a real one', async () => {
      await check();
      expect(existsSync(ran())).toBe(false);
    });

    it('run nowhere with only a cache started', async () => {
      composeWith('redis:7');
      await check({ docker });
      expect(existsSync(ran())).toBe(false);
    });

    it('run nowhere when Docker is missing', async () => {
      composeWith('postgres:18');
      await check({ docker: async () => ({ ok: false, stdout: '' }) });
      expect(existsSync(ran())).toBe(false);
    });

    it("run nowhere when the project's settings name its own database", async () => {
      composeWith('postgres:18');
      await check({ docker, env: { DATABASE_URL: 'postgres://mine' } });
      expect(existsSync(ran())).toBe(false);
    });

    it('run nowhere with only Mongo started: SQL migrations would look for another database', async () => {
      composeWith('mongo:7');
      await check({ docker });
      expect(existsSync(ran())).toBe(false);
    });

    it('run nowhere when a committed env file says where a database is: tools may read it first', async () => {
      composeWith('postgres:18');
      writeFileSync(join(repo, '.env'), 'PROD_CONN=postgres://prod/x\n');
      commit(repo, 'env');
      git(wt, 'merge', '-q', '--no-edit', 'main');
      const report = await check({ docker });
      expect(existsSync(ran())).toBe(false);
      expect(report.migrationsSkipped).toBe(true);
    });

    it('an example file is no reason to stop: its values are replaced', async () => {
      composeWith('postgres:18');
      writeFileSync(join(repo, '.env.example'), 'DATABASE_URL=postgres://localhost/x\n');
      commit(repo, 'example');
      git(wt, 'merge', '-q', '--no-edit', 'main');
      await check({ docker });
      expect(existsSync(ran())).toBe(true);
    });

    it('run when the temporary database is up', async () => {
      composeWith('postgres:18');
      await check({ docker });
      expect(existsSync(ran())).toBe(true);
    });

    it('say that they were skipped', async () => {
      const report = await check();
      expect(report.migrationsSkipped).toBe(true);
      expect(describeVerification(report)).toMatch(/migrations/i);
    });
  });

  it('says plainly when there is nothing to run', async () => {
    const report = await verify({ commands: undefined });
    expect(report.status).toBe('not_configured');
    expect(report.checks).toEqual([]);
  });

  it('takes detected commands from the base: a task cannot choose what checks it', async () => {
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'test -f good.txt' } }));
    commit(repo, 'base has a test');
    git(wt, 'merge', '-q', '--no-edit', 'main');
    writeFileSync(join(wt, 'checks.json'), '{}');
    commit(wt, 'task');
    const report = await verify({ commands: undefined });
    expect(report.source).toBeUndefined();
    expect(report.checks.map((c) => c.command)).toEqual(['npm run test']);
  });

  // A new project's first task: main has nothing to check with yet
  describe("when the base has no checks, the task's own", () => {
    const own = (test: string) => {
      writeFileSync(join(wt, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', scripts: { test } }));
      commit(wt, 'task sets up the project with its tests');
    };

    it('run, and a pass says the commands came from the task: not conclusive', async () => {
      own('test -f task.txt');
      const report = await verify({ commands: undefined });
      expect(report.status).toBe('passed');
      expect(report.source).toBe('task');
      expect(report.checks.map((c) => [c.command, c.outcome])).toEqual([['npm run test', 'passed']]);
      expect(verificationIsConclusive(report)).toBe(false);
      expect(verificationSummary(report).source).toBe('task');
      expect(describeVerification(report)).toContain('come from this task');
    });

    it('a failure blocks: there is no base to blame it on', async () => {
      own('exit 3');
      const report = await verify({ commands: undefined });
      expect(report.status).toBe('regression');
      expect(report.checks[0].onBase).toBeUndefined();
      const issues = verificationIssues(report);
      expect(issues).toHaveLength(1);
      expect(issues[0].title).toContain('npm run test');
    });

    it("the project's own commands in its settings still come first", async () => {
      own('exit 3');
      const report = await verify({ commands: ['test -f task.txt'] });
      expect(report.source).toBeUndefined();
      expect(report.status).toBe('passed');
    });
  });

  it('detects commands and installs on the base project', async () => {
    writeFileSync(join(repo, 'go.mod'), 'module x\n');
    commit(repo, 'go');
    git(wt, 'merge', '-q', '--no-edit', 'main');
    const report = await verify({ commands: undefined, detected: { install: ['touch installed'], checks: [{ name: 'has install', command: 'test -f installed' }] } });
    expect(report.status).toBe('passed');
  });

  it('a failed install blocks only when the base installs', async () => {
    unlinkSync(join(wt, 'good.txt'));
    commit(wt, 'task breaks the install');
    const broken = await verify({ commands: ['true'], detected: { install: ['test -f good.txt'], checks: [] } });
    expect(broken.status).toBe('regression');
    const both = await verify({ commands: ['true'], detected: { install: ['test -f never.txt'], checks: [] } });
    expect(both.status).toBe('not_verified');
  });

  it('remembers the base between runs: its result does not change', async () => {
    unlinkSync(join(wt, 'good.txt'));
    commit(wt, 'broke');
    const baseResults = new Map();
    const marker = join(repo, 'base-ran');
    const command = `test -f good.txt || exit 1; echo x >> "${marker}"`;
    await verify({ commands: [command], baseResults });
    const once = readFileSync(marker, 'utf-8');
    await verify({ commands: [command], baseResults });
    expect(readFileSync(marker, 'utf-8')).toBe(once);
  });

  describe('tampering with the tests, seen in git and not in anything an agent says', () => {
    const findings = async (change: () => void) => {
      change();
      commit(wt, 'change');
      return (await verify({ detected: { install: [], checks: [] } })).tamper;
    };

    beforeEach(() => {
      mkdirSync(join(repo, 'src'));
      writeFileSync(join(repo, 'src', 'a.test.ts'), "it('works', () => {});\n");
      writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run', typecheck: 'tsc' } }));
      commit(repo, 'tests');
      git(wt, 'merge', '-q', '--no-edit', 'main');
    });

    it('nothing to say about a task that added tests', async () => {
      await expect(findings(() => writeFileSync(join(wt, 'src', 'b.test.ts'), "it('new', () => {});\n"))).resolves.toEqual([]);
    });

    it('a deleted test file', async () => {
      const found = await findings(() => unlinkSync(join(wt, 'src', 'a.test.ts')));
      expect(found).toMatchObject([{ kind: 'deleted_test', file: 'src/a.test.ts' }]);
    });

    it('not a renamed one', async () => {
      await expect(findings(() => {
        git(wt, 'mv', 'src/a.test.ts', 'src/renamed.test.ts');
      })).resolves.toEqual([]);
    });

    it.each([
      ["it.skip('works', () => {});"],
      ["it.only('works', () => {});"],
      ["describe.skip('x', () => {});"],
      ["xit('works', () => {});"],
      ['test.todo("later");'],
    ])('a test switched off: %s', async (line) => {
      const found = await findings(() => writeFileSync(join(wt, 'src', 'a.test.ts'), `${line}\n`));
      expect(found).toMatchObject([{ kind: 'disabled_test', file: 'src/a.test.ts' }]);
    });

    it.each([
      ['Python', 'test_a.py', '@pytest.mark.skip\ndef test_a(): pass\n'],
      ['Go', 'a_test.go', 'func TestA(t *testing.T) { t.Skip("no") }\n'],
      ['Rust', 'tests/a.rs', '#[ignore]\n#[test]\nfn a() {}\n'],
      ['Java', 'src/ATest.java', '@Disabled\nvoid a() {}\n'],
      ['C#', 'ATests.cs', '[Ignore]\nvoid A() {}\n'],
      ['Ruby', 'spec/a_spec.rb', "xit 'works' do\nend\n"],
      ['PHP', 'tests/ATest.php', '$this->markTestSkipped();\n'],
      ['Swift', 'Tests/ATests.swift', 'throw XCTSkip("no")\n'],
    ])('switched off in %s too', async (_stack, file, content) => {
      mkdirSync(join(wt, file, '..'), { recursive: true });
      writeFileSync(join(wt, file), 'first version\n');
      commit(wt, 'the test exists');
      git(repo, 'merge', '-q', '--ff-only', 'vibe-teamlead/t');
      const found = await findings(() => writeFileSync(join(wt, file), content));
      expect(found).toMatchObject([{ kind: 'disabled_test', file }]);
    });

    describe('what is not tampering', () => {
      // Real lines from two tasks this check stopped by mistake
      it.each([
        ['a condition on a resource', "describe.skipIf(!DB)('guard chain', () => {});"],
        ['a skip chosen by a condition', 'const describeIfDb = DB ? describe : describe.skip;'],
        ['a comment', '// DB-gated with describe.skipIf(!DB); TRUNCATE CASCADE reset in afterAll'],
        ['a comment after code', "it('x', () => {}); // not it.skip('x')"],
        ['a block comment line', ' * Do not use it.skip here.'],
      ])('%s, in an existing test file', async (_name, line) => {
        await expect(findings(() => writeFileSync(join(wt, 'src', 'a.test.ts'), `${line}\n`))).resolves.toEqual([]);
      });

      it('one more test file for a run that already names its files', async () => {
        writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'tsc && node --test a.test.js && vitest run' } }));
        commit(repo, 'names files');
        git(wt, 'merge', '-q', 'main');
        await expect(findings(() => writeFileSync(join(wt, 'package.json'), JSON.stringify({ scripts: { test: 'tsc && node --test a.test.js test/b.test.mjs && vitest run' } })))).resolves.toEqual([]);
      });

      it.each([
        ["it.skip('later', () => {});"],
        ["describe.skipIf(!DB)('x', () => {});"],
        ["test.todo('later');"],
      ])('a new test file holding back its own new test: %s', async (line) => {
        await expect(findings(() => writeFileSync(join(wt, 'src', 'new.test.ts'), `${line}\n`))).resolves.toEqual([]);
      });
    });

    describe('a script that looks like it only adds', () => {
      const before = 'tsc && node --test a.test.js && vitest run';
      it.each([
        ['a filter that narrows a run naming no files', 'tsc && node --test a.test.js && vitest run only.test.ts'],
        ['a flag', 'tsc && node --test a.test.js --test-only && vitest run'],
        ['a way to ignore failure', 'tsc && node --test a.test.js || true && vitest run'],
        ['a file that is no test', 'tsc && node --test a.test.js evil.js && vitest run'],
        ['a test file replaced by another', 'tsc && node --test b.test.js && vitest run'],
        ['a command removed', 'node --test a.test.js test/b.test.mjs && vitest run'],
      ])('%s', async (_name, after) => {
        writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: before } }));
        commit(repo, 'names files');
        git(wt, 'merge', '-q', 'main');
        const found = await findings(() => writeFileSync(join(wt, 'package.json'), JSON.stringify({ scripts: { test: after } })));
        expect(found).toMatchObject([{ kind: 'changed_script' }]);
      });
    });

    describe('what still is', () => {
      it('a condition that is always true', async () => {
        const found = await findings(() => writeFileSync(join(wt, 'src', 'a.test.ts'), "describe.skipIf(true)('x', () => {});\n"));
        expect(found).toMatchObject([{ kind: 'disabled_test' }]);
      });

      it('.only in a new file: it narrows the whole run', async () => {
        const found = await findings(() => writeFileSync(join(wt, 'src', 'new.test.ts'), "it.only('x', () => {});\n"));
        expect(found).toMatchObject([{ kind: 'disabled_test', file: 'src/new.test.ts' }]);
      });
    });

    it('the word in a file that is not a test is not tampering', async () => {
      await expect(findings(() => writeFileSync(join(wt, 'notes.md'), 'we use it.skip( sometimes\n'))).resolves.toEqual([]);
    });

    it('a changed test script', async () => {
      const found = await findings(() => writeFileSync(join(wt, 'package.json'), JSON.stringify({ scripts: { test: 'exit 0', typecheck: 'tsc' } })));
      expect(found).toMatchObject([{ kind: 'changed_script', file: 'package.json' }]);
    });

    it('another script changing is nothing', async () => {
      await expect(findings(() => writeFileSync(join(wt, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run', typecheck: 'tsc', dev: 'x' } })))).resolves.toEqual([]);
    });

    it('a test moved out of where tests live counts as deleted', async () => {
      const found = await findings(() => git(wt, 'mv', 'src/a.test.ts', 'src/a.ts'));
      expect(found).toMatchObject([{ kind: 'deleted_test', file: 'src/a.test.ts' }]);
    });

    it("a line in a patch can't pose as a file header and hide what follows", async () => {
      const found = await findings(() => writeFileSync(join(wt, 'src', 'a.test.ts'), `++ b/notes.md\nit.skip('works', () => {});\n`));
      expect(found).toMatchObject([{ kind: 'disabled_test', file: 'src/a.test.ts' }]);
    });

    it('names a changed runner config, which can make checks pass without touching a test', async () => {
      writeFileSync(join(wt, 'vitest.config.ts'), 'export default { test: { include: [] } };\n');
      writeFileSync(join(wt, '.npmrc'), 'script-shell=/bin/true\n');
      commit(wt, 'runner');
      const report = await verify({ detected: { install: [], checks: [] } });
      expect(report.runnerConfigChanged).toEqual(['.npmrc', 'vitest.config.ts']);
      expect(describeVerification(report)).toContain('vitest.config.ts');
    });

    it('blocks even when the checks pass: passing is what tampering is for', async () => {
      unlinkSync(join(wt, 'src', 'a.test.ts'));
      commit(wt, 'removed');
      expect((await verify({ detected: { install: [], checks: [] } })).status).toBe('regression');
    });
  });
});

describe('verificationIssues', () => {
  const base = { commit: 'c'.repeat(40), baseCommit: 'b'.repeat(40), tamper: [] as TamperFinding[], runnerConfigChanged: [] };
  const failed = { name: 'test', command: 'npm test', outcome: 'failed' as const, exitCode: 1, tail: 'the reason' };

  it('blocks only what the task broke', () => {
    const issues = verificationIssues({ ...base, status: 'regression', checks: [{ ...failed, onBase: 'passed' }, { ...failed, command: 'npm run lint', onBase: 'failed' }] });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ type: 'critical', key: 'check:npm test' });
    expect(issues[0].description).toContain('the reason');
  });

  it('blocks tampering too, with a key that ignores the wording', () => {
    const issues = verificationIssues({ ...base, status: 'regression', checks: [], tamper: [{ kind: 'deleted_test', file: 'a.test.ts', detail: 'Deleted.' }] });
    expect(issues[0]).toMatchObject({ key: 'tamper:deleted_test:a.test.ts', location: 'a.test.ts' });
  });

  it('nothing when nothing broke', () => {
    expect(verificationIssues({ ...base, status: 'not_verified', checks: [{ ...failed, onBase: 'failed' }] })).toEqual([]);
  });
});

describe('verificationEnv', () => {
  it('keeps what tools need and nothing that opens anything', () => {
    const env = verificationEnv({ HOME: '/h', PATH: '/p', LANG: 'uk', ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 't', AWS_SECRET_ACCESS_KEY: 's', CLAUDE_CODE_OAUTH_TOKEN: 'o' }, {});
    expect(env.HOME).toBe('/h');
    expect(env.LANG).toBe('uk');
    expect(env.CI).toBe('true');
    expect(env.PATH).toContain('/p');
    for (const secret of ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) expect(env[secret]).toBeUndefined();
  });

  it("adds the project's own variables on top", () => {
    expect(verificationEnv({ HOME: '/h' }, { DATABASE_URL: 'postgres://x' }).DATABASE_URL).toBe('postgres://x');
  });
});

describe('withVerifyLock', () => {
  const lock = () => join(mkdtempSync(join(tmpdir(), 'vtl-lock-')), 'lock');

  it('runs one at a time across callers', async () => {
    const dir = lock();
    const order: string[] = [];
    await Promise.all([
      withVerifyLock(dir, async () => {
        order.push('a in');
        await new Promise((resolve) => setTimeout(resolve, 30));
        order.push('a out');
      }, { pollMs: 5 }),
      withVerifyLock(dir, async () => { order.push('b'); }, { pollMs: 5 }),
    ]);
    expect(order.indexOf('a out')).toBeLessThan(order.indexOf('b'));
  });

  it('lets go when the work fails', async () => {
    const dir = lock();
    await expect(withVerifyLock(dir, async () => { throw new Error('no'); })).rejects.toThrow('no');
    await expect(withVerifyLock(dir, async () => 'ok')).resolves.toBe('ok');
  });

  it('takes over from a run that died', async () => {
    const dir = lock();
    mkdirSync(dir);
    await expect(withVerifyLock(dir, async () => 'ok', { pollMs: 5, staleMs: 1 })).resolves.toBe('ok');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('a test script that only names more test files', () => {
  const before = 'tsc && node --test a.test.js && vitest run';
  it.each([
    ['another file', 'tsc && node --test a.test.js b/c.test.mjs && vitest run'],
    ['several', 'tsc && node --test a.test.js b.test.js c.spec.ts && vitest run'],
  ])('%s is fine', (_name, after) => {
    expect(onlyAddsTestFiles(before, after)).toBe(true);
  });

  it.each([
    ['a flag shaped like a file', 'tsc && node --test a.test.js --x.test.js && vitest run'],
    ['a short flag shaped like a file', 'tsc && node --test a.test.js -x.test.js && vitest run'],
    ['a file outside the project', 'tsc && node --test a.test.js ../b.test.js && vitest run'],
    ['a new line that starts another command', 'tsc && node --test a.test.js\nb.test.js && vitest run'],
    ['a new line in place of a space', 'tsc &&\nnode --test a.test.js && vitest run'],
    ['only other spacing', 'tsc  && node --test a.test.js && vitest run'],
    ['a tab before the file', 'tsc && node --test a.test.js\tb.test.js && vitest run'],
  ])('%s is not', (_name, after) => {
    expect(onlyAddsTestFiles(before, after)).toBe(false);
  });

  it('a file after the value of a flag is not: it may widen what the flag leaves out', () => {
    expect(onlyAddsTestFiles('vitest run --exclude a.test.js', 'vitest run --exclude a.test.js b.test.js')).toBe(false);
  });

  it.each([
    ['mocha', 'mocha a.test.js', 'mocha a.test.js b.test.js'],
    ['vitest', 'pnpm lint && vitest run a.test.ts', 'pnpm lint && vitest run a.test.ts b.test.ts'],
    ['jest', 'jest a.test.js', 'jest a.test.js ./b.test.js'],
  ])('the list of a known runner may grow: %s', (_name, was, is) => {
    expect(onlyAddsTestFiles(was, is)).toBe(true);
  });

  it.each([
    ['a path from the root', 'node --test a.test.js', 'node --test a.test.js /tmp/b.test.js'],
    ['a response file', 'node --test a.test.js', 'node --test a.test.js @b.test.js'],
    ['a flag further back that takes many values', 'mocha --ignore a.test.js', 'mocha --ignore a.test.js b.test.js'],
    ['a flag between the runner and the list', 'node --test --test-skip-pattern x a.test.js', 'node --test --test-skip-pattern x a.test.js b.test.js'],
    ['a command that runs no tests', 'cleanup a.test.js', 'cleanup a.test.js b.test.js'],
    ['a list passed to something else', 'echo mocha a.test.js', 'echo mocha a.test.js b.test.js'],
    ['a wrapper that decides what runs', 'sh run.sh node --test a.test.js', 'sh run.sh node --test a.test.js b.test.js'],
  ])('is not: %s', (_name, was, is) => {
    expect(onlyAddsTestFiles(was, is)).toBe(false);
  });

  it('the real script a task was stopped for', () => {
    const was = 'pnpm --filter @roadmaply/shared build && node --test test/docker-compose.security.test.js && pnpm -r --if-present test && pnpm --filter @roadmaply/web build';
    const is = 'pnpm --filter @roadmaply/shared build && node --test test/docker-compose.security.test.js test/env-examples.test.mjs && pnpm -r --if-present test && pnpm --filter @roadmaply/web build';
    expect(onlyAddsTestFiles(was, is)).toBe(true);
  });

  it.each([[undefined, 'x'], ['x', undefined], [1, 'x']])('a script that is not text is not: %s', (was, is) => {
    expect(onlyAddsTestFiles(was, is)).toBe(false);
  });
});

describe('failureSummary', () => {
  // What `pnpm run test` printed on task 022: 1140 passing API tests, then the web build failing
  const TAIL = [
    'apps/api test:  ✓  e2e  test/prisma.service.e2e-spec.ts (2 tests) 87ms',
    'apps/api test:  Test Files  115 passed (115)',
    'apps/api test:       Tests  1140 passed (1140)',
    '$ next build',
    '✓ Compiled successfully in 2.0s',
    'Error: Route "/app/[orgSlug]/changelog": Next.js encountered URL data `usePathname()` in a Client Component outside of `<Suspense>`.',
    '    at <unknown> (src/components/app-shell/app-shell.tsx:31:28)',
    'Error occurred prerendering page "/app/[orgSlug]/changelog". Read more: https://nextjs.org/docs/messages/prerender-error',
    '⨯ Next.js build worker exited with code: 1 and signal: null',
    '[ELIFECYCLE] Command failed with exit code 1.',
    'Error: ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL',
    '  × "pnpm recursive run" failed in /private/var/folders/',
    '  │ y1/2nf1dsnj4qxd5vtxf7m68pfc0000gn/T/vibe-teamlead-verify-455m6A/copy/apps/',
    '  │ web',
  ].join('\n');

  it('names the workspace package that failed and puts its error lines first', () => {
    const summary = failureSummary(TAIL);
    expect(summary).toMatch(/^Failed in apps\/web\./);
    expect(summary).toContain('usePathname()');
    expect(summary).toContain('app-shell.tsx:31:28');
    expect(summary).not.toContain('1140 passed');
  });

  it('is empty when nothing in the output looks like the failure', () => {
    expect(failureSummary('all good\nDone')).toBe('');
  });

  it("leads the fixer's issue with it, before the end of the output", () => {
    const [issue] = verificationIssues({
      status: 'regression', commit: 'c', baseCommit: 'b', tamper: [], runnerConfigChanged: [],
      checks: [{ name: 'test', command: 'pnpm run test', outcome: 'failed', exitCode: 1, tail: TAIL, onBase: 'passed' }],
    } as never);
    expect(issue.description.indexOf('usePathname()')).toBeLessThan(issue.description.indexOf('1140 passed'));
    expect(issue.description).toMatch(/Failed in apps\/web/);
  });
});

