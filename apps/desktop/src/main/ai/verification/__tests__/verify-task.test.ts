import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { type TamperFinding, verificationEnv, verificationIssues, verifyTask, withVerifyLock, type VerifyTaskOptions } from '../verify-task';

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
      const found = await findings(() => {
        mkdirSync(join(wt, file, '..'), { recursive: true });
        writeFileSync(join(wt, file), content);
      });
      expect(found).toMatchObject([{ kind: 'disabled_test', file }]);
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

    it('blocks even when the checks pass: passing is what tampering is for', async () => {
      unlinkSync(join(wt, 'src', 'a.test.ts'));
      commit(wt, 'removed');
      expect((await verify({ detected: { install: [], checks: [] } })).status).toBe('regression');
    });
  });
});

describe('verificationIssues', () => {
  const base = { commit: 'c'.repeat(40), baseCommit: 'b'.repeat(40), tamper: [] as TamperFinding[] };
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
