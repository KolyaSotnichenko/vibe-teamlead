import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

// The machine's real Strix and Docker must stay out of the tests: finding them would run them
const lookup = vi.hoisted(() => ({ nothingInstalled: false }));
vi.mock('../../../platform/exec', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../platform/exec')>();
  return { ...actual, findOnPath: (...args: Parameters<typeof actual.findOnPath>) => (lookup.nothingInstalled ? undefined : actual.findOnPath(...args)) };
});

import {
  buildStrixArgs,
  DEFAULT_STRIX_SETTINGS,
  formatFixRequest,
  isBlocking,
  parseSarif,
  runStrix,
  strixModel,
} from '../strix';

const SARIF = JSON.stringify({
  version: '2.1.0',
  runs: [
    {
      tool: {
        driver: {
          name: 'strix',
          rules: [
            { id: 'sqli', shortDescription: { text: 'SQL injection in invoice search' }, properties: { 'security-severity': '9.1' } },
            { id: 'hdr', shortDescription: { text: 'Missing security header' }, properties: { severity: 'low' } },
          ],
        },
      },
      results: [
        {
          ruleId: 'sqli',
          level: 'error',
          message: { text: 'The q parameter is concatenated into SQL.\nPoC: ?q=1%27%20OR%201=1' },
          locations: [{ physicalLocation: { artifactLocation: { uri: 'api/src/invoices.ts' }, region: { startLine: 42 } } }],
        },
        { ruleId: 'hdr', level: 'note', message: { text: 'X-Content-Type-Options is not set' } },
      ],
    },
  ],
});

const settings = { ...DEFAULT_STRIX_SETTINGS, enabled: true };

describe('Strix helpers', () => {
  it('parses SARIF findings with severity from rule properties', () => {
    const findings = parseSarif(SARIF);
    expect(findings).toEqual([
      expect.objectContaining({ ruleId: 'sqli', title: 'SQL injection in invoice search', severity: 'critical', location: 'api/src/invoices.ts:42' }),
      expect.objectContaining({ ruleId: 'hdr', severity: 'low' }),
    ]);
    expect(parseSarif('nope')).toEqual([]);
  });

  it('blocks at the threshold and above, and always on unknown severity', () => {
    const [sqli, hdr] = parseSarif(SARIF);
    expect(isBlocking(sqli, 'high')).toBe(true);
    expect(isBlocking(hdr, 'high')).toBe(false);
    expect(isBlocking({ ruleId: 'x', title: 'x', severity: 'unknown' }, 'critical')).toBe(true);
  });

  it('scans only the diff, headless, with a budget cap', () => {
    const args = buildStrixArgs({ projectDir: '/wt', settings, diffBase: 'abc123' }, '/spec/security/instructions.md');
    expect(args).toEqual(
      expect.arrayContaining(['--non-interactive', '--target', '/wt', '--scope-mode', 'diff', '--diff-base', 'abc123', '--fail-on', 'high', '--max-budget', '5']),
    );
    expect(strixModel('claude-sonnet-4-6')).toBe('anthropic/claude-sonnet-4-6');
    expect(strixModel('openrouter/x')).toBe('openrouter/x');
  });

  it('writes a fix request with only blocking findings', () => {
    const md = formatFixRequest({ status: 'findings', findings: parseSarif(SARIF) }, settings, '/spec');
    expect(md).toContain('SQL injection in invoice search');
    expect(md).not.toContain('Missing security header');
    expect(md).toContain('failing test');
  });
});

describe('runStrix', () => {
  const originalPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = originalPath;
    lookup.nothingInstalled = false;
  });

  function fakeBin(name: string, script: string, dir: string) {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${script}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  function gitProject() {
    const project = mkdtempSync(join(tmpdir(), 'vtl-strix-project-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'first'], { cwd: project });
    return project;
  }

  it('skips without an API key, with a subscription token, or without Strix', async () => {
    const specDir = mkdtempSync(join(tmpdir(), 'vtl-strix-'));
    const base = { projectDir: specDir, specDir, settings, model: 'claude-sonnet-4-6' };
    expect((await runStrix(base)).status).toBe('skipped');
    expect((await runStrix({ ...base, apiKey: 'sk-ant-oat01-x' })).reason).toMatch(/API key/);
    lookup.nothingInstalled = true;
    const missing = await runStrix({ ...base, apiKey: 'sk-ant-api-x', strixBin: undefined });
    expect(missing).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/not installed/) });
    expect(readFileSync(join(specDir, 'security_qa.md'), 'utf-8')).toContain('Security QA');
  });

  describe('what Strix gets to work on', () => {
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

    function taskFolder() {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'vtl-strix-task-')));
      const project = join(root, 'my-task');
      mkdirSync(project);
      git(project, 'init', '-q', '-b', 'main');
      git(project, 'config', 'user.email', 't@t');
      git(project, 'config', 'user.name', 't');
      writeFileSync(join(project, '.gitignore'), '.env\nnode_modules/\n.vibe-teamlead/\n');
      writeFileSync(join(project, 'tracked.txt'), 'committed\n');
      git(project, 'add', '-A');
      git(project, 'commit', '-q', '-m', 'base');
      git(project, 'checkout', '-q', '-b', 'task');
      writeFileSync(join(project, 'feature.txt'), 'the task\n');
      git(project, 'add', '-A');
      git(project, 'commit', '-q', '-m', 'task');
      const specDir = join(project, '.vibe-teamlead', 'specs', '001');
      mkdirSync(join(specDir, 'architecture'), { recursive: true });
      writeFileSync(join(specDir, 'spec.md'), 'the spec\n');
      writeFileSync(join(specDir, 'architecture', 'a.md'), 'the design\n');
      return { project, specDir };
    }

    /** A Strix that reports what it sees, then does what the real one did to the folder it was given */
    function scanner(bin: string) {
      return fakeBin(
        'strix',
        `while [ $# -gt 0 ]; do
  [ "$1" = "--target" ] && T="$2"
  [ "$1" = "--diff-base" ] && B="$2"
  [ "$1" = "--instruction-file" ] && I="$2"
  shift
done
echo "target=$T"
echo "name=$(basename "$T")"
echo "changed=$(git -C "$T" diff --name-only "$B"...HEAD | tr '\\n' ',')"
echo "tracked=$(cat "$T/tracked.txt")"
echo "untracked=$(cat "$T/new.txt" 2>/dev/null)"
echo "secret=$(cat "$T/.env" 2>/dev/null)"
echo "through=$(cat "$T/dir/x" 2>/dev/null)"
echo "spec=$(cat "$T/.vibe-teamlead-task/spec.md" 2>/dev/null)"
echo "design=$(cat "$T/.vibe-teamlead-task/architecture/a.md" 2>/dev/null)"
grep -q '.vibe-teamlead-task/spec.md' "$I" && echo "told=yes"
echo "storeDir: /workspace/x" >> "$T/tracked.txt"
echo stray > "$T/stray.txt"
mkdir -p "$T/node_modules" && echo linux > "$T/node_modules/native"
exit 0`,
        bin,
      );
    }

    async function scan() {
      const bin = mkdtempSync(join(tmpdir(), 'vtl-bin-'));
      fakeBin('docker', 'exit 0', bin);
      process.env.PATH = `${bin}:${originalPath}`;
      const task = taskFolder();
      const run = async (over: Partial<Parameters<typeof runStrix>[0]> = {}) => {
        const logs: string[] = [];
        const result = await runStrix({ projectDir: task.project, specDir: task.specDir, settings, model: 'm', apiKey: 'sk-ant-api-x', strixBin: scanner(bin), diffBase: 'main', onLog: (l) => logs.push(l), ...over });
        const seen = (key: string) => logs.find((l) => l.startsWith(`[strix] ${key}=`))?.slice(`[strix] ${key}=`.length);
        return { result, seen, logs };
      };
      return { ...task, run };
    }

    it('leaves the task folder as it was: no edits, no stray files, no foreign dependencies', async () => {
      const { project, run } = await scan();
      mkdirSync(join(project, 'node_modules'));
      writeFileSync(join(project, 'node_modules', 'native'), 'macos\n');
      const { result, seen } = await run();
      expect(result.status).toBe('clear');
      expect(seen('target')).not.toBe(project);
      expect(git(project, 'status', '--porcelain')).toBe('');
      expect(readFileSync(join(project, 'tracked.txt'), 'utf-8')).toBe('committed\n');
      expect(existsSync(join(project, 'stray.txt'))).toBe(false);
      expect(readFileSync(join(project, 'node_modules', 'native'), 'utf-8')).toBe('macos\n');
    });

    it('sees the task as QA approved it, with its diff, spec and folder name', async () => {
      const { seen } = await (await scan()).run();
      expect(seen('name')).toBe('my-task');
      expect(seen('changed')).toBe('feature.txt,');
      expect(seen('spec')).toBe('the spec');
      expect(seen('design')).toBe('the design');
      expect(seen('told')).toBe('yes');
    });

    it('sees uncommitted work too, but not ignored files such as .env', async () => {
      const { project, run } = await scan();
      writeFileSync(join(project, 'tracked.txt'), 'edited\n');
      writeFileSync(join(project, 'new.txt'), 'brand new\n');
      writeFileSync(join(project, '.env'), 'TOKEN=secret\n');
      const { seen } = await run();
      expect(seen('tracked')).toBe('edited');
      expect(seen('untracked')).toBe('brand new');
      expect(seen('secret')).toBe('');
    });

    it("finds a base that only exists as the project's remote branch", async () => {
      const { project, run } = await scan();
      git(project, 'update-ref', 'refs/remotes/origin/main', 'main');
      const { seen } = await run({ diffBase: 'origin/main' });
      expect(seen('changed')).toBe('feature.txt,');
    });

    it('works from a task worktree, the way tasks really run', async () => {
      const { project, run } = await scan();
      const worktree = join(project, '.vibe-teamlead', 'worktrees', 'my-worktree');
      git(project, 'worktree', 'add', '-q', '-b', 'task-2', worktree, 'task');
      const { result, seen } = await run({ projectDir: worktree });
      expect(result.status).toBe('clear');
      expect(seen('name')).toBe('my-worktree');
      expect(seen('changed')).toBe('feature.txt,');
      expect(git(worktree, 'status', '--porcelain')).toBe('');
    });

    describe('links a branch or a worktree can hold', () => {
      const outside = () => realpathSync(mkdtempSync(join(tmpdir(), 'vtl-outside-')));
      const commitLink = (project: string, name: string, to: string) => {
        symlinkSync(to, join(project, name));
        git(project, 'add', '-A');
        git(project, 'commit', '-q', '-m', 'link');
      };

      it('do not carry a new file out of the copy through a linked folder', async () => {
        const { project, run } = await scan();
        const away = outside();
        commitLink(project, 'link', away);
        rmSync(join(project, 'link'));
        mkdirSync(join(project, 'link'));
        writeFileSync(join(project, 'link', 'evil.txt'), 'written\n');
        const { result } = await run();
        expect(result.status).toBe('clear');
        expect(existsSync(join(away, 'evil.txt'))).toBe(false);
      });

      it('do not carry an edit out of the copy through a linked file', async () => {
        const { project, run } = await scan();
        const away = outside();
        writeFileSync(join(away, 'victim'), 'untouched\n');
        commitLink(project, 'file', join(away, 'victim'));
        rmSync(join(project, 'file'));
        writeFileSync(join(project, 'file'), 'written\n');
        await run();
        expect(readFileSync(join(away, 'victim'), 'utf-8')).toBe('untouched\n');
      });

      it('do not carry a deletion out of the copy', async () => {
        const { project, run } = await scan();
        const away = outside();
        writeFileSync(join(away, 'victim'), 'untouched\n');
        mkdirSync(join(project, 'link'));
        writeFileSync(join(project, 'link', 'victim'), 'tracked\n');
        git(project, 'add', '-A');
        git(project, 'commit', '-q', '-m', 'folder');
        rmSync(join(project, 'link'), { recursive: true });
        symlinkSync(away, join(project, 'link'));
        await run();
        expect(readFileSync(join(away, 'victim'), 'utf-8')).toBe('untouched\n');
      });

      it('do not redirect the task documents', async () => {
        const { project, run } = await scan();
        const away = outside();
        commitLink(project, '.vibe-teamlead-task', away);
        const { seen } = await run();
        expect(existsSync(join(away, 'spec.md'))).toBe(false);
        expect(seen('spec')).toBe('the spec');
      });

      it('do not bring a file from outside the task into the sandbox', async () => {
        const { project, specDir, run } = await scan();
        const away = outside();
        writeFileSync(join(away, 'x'), 'private\n');
        mkdirSync(join(project, 'dir'));
        writeFileSync(join(project, 'dir', 'x'), 'tracked\n');
        git(project, 'add', '-A');
        git(project, 'commit', '-q', '-m', 'folder');
        rmSync(join(project, 'dir'), { recursive: true });
        symlinkSync(away, join(project, 'dir'));
        rmSync(join(specDir, 'spec.md'));
        symlinkSync(join(away, 'x'), join(specDir, 'spec.md'));
        rmSync(join(specDir, 'architecture', 'a.md'));
        symlinkSync(join(away, 'x'), join(specDir, 'architecture', 'a.md'));
        const { seen } = await run();
        expect(seen('through')).toBe('');
        expect(seen('spec')).toBe('');
        expect(seen('design')).toBe('');
      });
    });

    describe('when the worktree differs from its last commit in kind', () => {
      it('takes a file where the commit has a folder', async () => {
        const { project, run } = await scan();
        mkdirSync(join(project, 'dir'));
        writeFileSync(join(project, 'dir', 'x'), 'tracked\n');
        git(project, 'add', '-A');
        git(project, 'commit', '-q', '-m', 'folder');
        rmSync(join(project, 'dir'), { recursive: true });
        writeFileSync(join(project, 'dir'), 'now a file\n');
        const { result } = await run();
        expect(result.status).toBe('clear');
      });

      it('takes a folder where the commit has a file', async () => {
        const { project, run } = await scan();
        writeFileSync(join(project, 'dir'), 'a file\n');
        git(project, 'add', '-A');
        git(project, 'commit', '-q', '-m', 'file');
        rmSync(join(project, 'dir'));
        mkdirSync(join(project, 'dir'));
        writeFileSync(join(project, 'dir', 'x'), 'in the folder\n');
        const { result, seen } = await run();
        expect(result.status).toBe('clear');
        expect(seen('through')).toBe('in the folder');
      });

      it('skips a named pipe in the spec folder instead of hanging on it', async () => {
        const { specDir, run } = await scan();
        rmSync(join(specDir, 'spec.md'));
        execFileSync('mkfifo', [join(specDir, 'spec.md')]);
        execFileSync('mkfifo', [join(specDir, 'architecture', 'pipe')]);
        const { result, seen } = await run();
        expect(result.status).toBe('clear');
        expect(seen('spec')).toBe('');
        expect(seen('design')).toBe('the design');
      }, 10_000);
    });

    it('removes the copy afterwards', async () => {
      const { specDir, run } = await scan();
      const { seen } = await run();
      expect(seen('target')).toBeTruthy();
      expect(existsSync(seen('target') as string)).toBe(false);
      expect(existsSync(join(specDir, 'security', 'target'))).toBe(false);
    });

    it('reports an error, not a clean scan, when no copy can be made', async () => {
      const { specDir, run } = await scan();
      const { result } = await run({ projectDir: join(specDir, 'not-a-repo') });
      expect(result).toMatchObject({ status: 'error', reason: expect.stringMatching(/copy/) });
    });
  });

  it('runs Strix and reports blocking findings from its SARIF', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'vtl-bin-'));
    const specDir = mkdtempSync(join(tmpdir(), 'vtl-spec-'));
    const sarifFile = join(bin, 'findings.sarif');
    writeFileSync(sarifFile, SARIF);
    fakeBin('docker', 'exit 0', bin);
    const strix = fakeBin(
      'strix',
      `[ "$STRIX_TELEMETRY" = "0" ] || exit 9
[ "$STRIX_LLM" = "anthropic/claude-sonnet-4-6" ] || exit 8
mkdir -p strix_runs/run-1 && cp "${sarifFile}" strix_runs/run-1/findings.sarif
echo '{"status":"completed","llm_usage":{"cost":1.25}}' > strix_runs/run-1/run.json
echo "found 2"; exit 2`,
      bin,
    );
    process.env.PATH = `${bin}:${originalPath}`;
    const logs: string[] = [];
    const result = await runStrix({ projectDir: gitProject(), specDir, settings, model: 'claude-sonnet-4-6', apiKey: 'sk-ant-api-x', strixBin: strix, onLog: (l) => logs.push(l) });

    expect(result.status).toBe('findings');
    expect(result.costUsd).toBe(1.25);
    expect(result.findings.filter((f) => isBlocking(f, 'high'))).toHaveLength(1);
    expect(logs).toContain('[strix] found 2');
    const md = readFileSync(join(specDir, 'security_qa.md'), 'utf-8');
    expect(md).toContain('BLOCKED');
    expect(md).toContain('spent $1.25');
  });

  it('treats a clean exit as clear and other exits as a non-blocking error', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'vtl-bin-'));
    fakeBin('docker', 'exit 0', bin);
    process.env.PATH = `${bin}:${originalPath}`;
    const specDir = mkdtempSync(join(tmpdir(), 'vtl-spec-'));
    const opts = { projectDir: gitProject(), specDir, settings, model: 'claude-sonnet-4-6', apiKey: 'sk-ant-api-x' };
    expect((await runStrix({ ...opts, strixBin: fakeBin('strix-ok', 'exit 0', bin) })).status).toBe('clear');
    expect((await runStrix({ ...opts, strixBin: fakeBin('strix-bad', 'exit 1', bin) })).status).toBe('error');
  });
});
