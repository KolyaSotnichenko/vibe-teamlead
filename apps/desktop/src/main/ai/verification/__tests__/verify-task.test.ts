import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import type { DockerRun } from '../test-services';
import { describeVerification, type TamperFinding, verificationEnv, verificationIssues, verifyTask, withVerifyLock, type VerifyTaskOptions } from '../verify-task';

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

    it('runs a check that ran out of time once more before believing it', async () => {
      const report = await verify({ commands: [stallsOnce(join(repo, 'stalled'))], checkTimeoutMs: 400 });
      expect(report.status).toBe('passed');
      expect(report.checks[0]).toMatchObject({ outcome: 'passed', flaky: true });
    });

    it('runs an install that ran out of time once more before believing it', async () => {
      const report = await verify({ commands: undefined, installTimeoutMs: 400, detected: { install: [stallsOnce(join(repo, 'stalled'))], checks: [{ name: 'ok', command: 'true' }] } });
      expect(report.status).toBe('passed');
    });
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
    writeFileSync(join(wt, 'package.json'), JSON.stringify({ scripts: { test: 'exit 0' } }));
    commit(wt, 'task adds its own test script');
    const report = await verify({ commands: undefined });
    expect(report.status).toBe('not_configured');
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

      it.each([
        ["it.skip('later', () => {});"],
        ["describe.skipIf(!DB)('x', () => {});"],
        ["test.todo('later');"],
      ])('a new test file holding back its own new test: %s', async (line) => {
        await expect(findings(() => writeFileSync(join(wt, 'src', 'new.test.ts'), `${line}\n`))).resolves.toEqual([]);
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
