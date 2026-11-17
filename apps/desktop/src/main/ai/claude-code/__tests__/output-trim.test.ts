import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { isFloodingCommand, toolLogPath, trimmedCommand, TRIM_THRESHOLD_BYTES } from '../output-trim';
import { evaluatePreToolUse } from '../security-hooks';
import type { ToolContext } from '../../tools/types';

const scratch = mkdtempSync(join(tmpdir(), 'vtl-trim-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('isFloodingCommand', () => {
  it('recognises test runners, builds, typechecks, installs and linters', () => {
    for (const command of [
      'npm test',
      'npm run test:unit',
      'npm run build',
      'npm ci',
      'pnpm install',
      'pnpm --filter web test',
      'pnpm -C apps/web typecheck',
      'yarn',
      'yarn lint',
      'bun test',
      'npx vitest run',
      'npx tsc --noEmit',
      'pnpm exec eslint .',
      './node_modules/.bin/jest',
      'CI=1 npm test',
      'cd apps/web && npm test',
      'npm run lint && npm run typecheck',
      'pytest -q tests/',
      'python -m pytest',
      'python3 -m pip install -r requirements.txt',
      'uv run pytest',
      'pip install requests',
      'go test ./...',
      'cargo test',
      'cargo clippy',
      'mvn test',
      './gradlew test',
      'dotnet test',
      'bundle exec rspec',
      'bundle install',
      'rspec spec/models',
      'vendor/bin/phpunit',
      'php artisan test',
      'swift test',
      'make',
      'npm test || true',
    ]) {
      expect(isFloodingCommand(command), command).toBe(true);
    }
  });

  it('leaves alone what the agent shapes itself, short commands, watchers and servers', () => {
    for (const command of [
      '',
      'ls -la',
      'git status',
      'cat package.json',
      'npm test | tail -50',
      'npm test 2>&1 | grep FAIL',
      'npm test > out.log',
      'npm run build > /dev/null 2>&1',
      'npx vitest --watch',
      'npx vitest watch',
      'npm run dev',
      'npm start',
      'npx next dev',
      'npm test &',
      'echo $(npm test)',
      'echo `npm test`',
      'npm test <<EOF\nx\nEOF',
      'npm run test\nnpm run lint',
      'npm view vitest version',
      'npm install -g something & sleep 1',
      'echo "npm test"',
    ]) {
      expect(isFloodingCommand(command), command).toBe(false);
    }
  });
});

describe('toolLogPath', () => {
  it('puts the log in the spec directory, else the temp directory', () => {
    expect(toolLogPath('/p/.vibe-teamlead/specs/001', 7, 1000)).toBe(join('/p/.vibe-teamlead/specs/001', 'logs', 'tool-1000-7.log'));
    expect(toolLogPath('', 1, 5).startsWith(join(tmpdir(), 'vibe-teamlead-logs'))).toBe(true);
  });
});

describe('trimmedCommand', () => {
  it('writes a Windows path with forward slashes for Git Bash, quoted', () => {
    const wrapped = trimmedCommand('npm test', 'C:\\Users\\me\\proj\\.vibe-teamlead\\specs\\001\\logs\\tool-1.log', 'win32');
    expect(wrapped).toContain("'C:/Users/me/proj/.vibe-teamlead/specs/001/logs/tool-1.log'");
    expect(wrapped).toContain("mkdir -p 'C:/Users/me/proj/.vibe-teamlead/specs/001/logs'");
    expect(wrapped).not.toContain('\\');
  });

  it("quotes a path with a single quote in it", () => {
    const wrapped = trimmedCommand('npm test', "/tmp/it's/tool.log", 'darwin');
    expect(wrapped).toContain("'/tmp/it'\\''s/tool.log'");
  });

  const bashRuns = process.platform !== 'win32';
  const run = (command: string) => spawnSync('bash', ['-c', command], { encoding: 'utf-8', cwd: scratch });

  it.runIf(bashRuns)('passes short output through untouched and keeps the exit code', () => {
    const log = join(scratch, 'short', 'tool.log');
    const result = run(trimmedCommand('echo hello; echo oops >&2; (exit 3)', log, 'darwin'));
    expect(result.status).toBe(3);
    expect(result.stdout).toContain('hello');
    expect(result.stdout).toContain('oops');
    expect(result.stdout).not.toContain('Output shortened');
    expect(existsSync(log)).toBe(true);
  });

  it.runIf(bashRuns)('shortens long output: exit code, failure lines with context, the tail, and where the full log is', () => {
    const log = join(scratch, 'long', 'tool.log');
    const script = [
      'for i in $(seq 1 2000); do echo "  ✓ test number $i passed"; done',
      'echo "context before"',
      'echo "FAIL src/app.test.ts > adds numbers"',
      'echo "AssertionError: expected 3 to be 4"',
      'for i in $(seq 1 100); do echo "  ✓ late test $i passed"; done',
      'echo "Tests  1 failed | 2100 passed"',
      '(exit 1)',
    ].join('\n');
    const result = run(trimmedCommand(script, log, 'darwin'));
    expect(result.status).toBe(1);
    const out = result.stdout;
    expect(out).toContain('exit code 1');
    expect(out).toContain(log);
    expect(out).toContain('FAIL src/app.test.ts > adds numbers');
    expect(out).toContain('AssertionError: expected 3 to be 4');
    expect(out).toContain('context before');
    expect(out).toContain('Tests  1 failed | 2100 passed');
    expect(out).not.toContain('test number 5 passed');
    // About what `| tail` gave before, plus the failures
    expect(out.length).toBeLessThan(6500);
    // The whole output is in the log
    const full = readFileSync(log, 'utf-8');
    expect(full).toContain('test number 5 passed');
    expect(full).toContain('AssertionError');
  });

  it.runIf(bashRuns)('after a passing run, only the tail: lines that merely mention errors are noise then', () => {
    const log = join(scratch, 'pass', 'tool.log');
    const script = [
      'for i in $(seq 1 500); do echo "  ✓ src/errors/handler-$i.test.ts > reports the error"; done',
      'echo "Test Files  500 passed (500)"',
    ].join('\n');
    const result = run(trimmedCommand(script, log, 'darwin'));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('exit code 0');
    expect(result.stdout).toContain('Test Files  500 passed (500)');
    expect(result.stdout).not.toContain('Lines that look like failures');
    expect(result.stdout.length).toBeLessThan(2500);
    expect(result.stdout.length).toBeGreaterThan(0);
    expect(TRIM_THRESHOLD_BYTES).toBeLessThanOrEqual(4000);
  });

  it.runIf(bashRuns)('keeps a cd in the command for the rest of the shell, like the original', () => {
    const log = join(scratch, 'cd', 'tool.log');
    const result = run(`${trimmedCommand('cd /', log, 'darwin')}; pwd`);
    expect(result.stdout.trim().split('\n').pop()).toBe('/');
  });
});

describe('PreToolUse: Bash output trimming', () => {
  const context = (specDir: string) =>
    ({ cwd: scratch, projectDir: scratch, specDir, securityProfile: undefined as never, agentType: 'coder' }) as unknown as ToolContext;
  const commandOf = (out: object) =>
    (out as { hookSpecificOutput?: { updatedInput?: { command?: string } } }).hookSpecificOutput?.updatedInput?.command;

  it('wraps a test run, after the credential unset, with its log in the spec directory', () => {
    const specDir = join(scratch, 'spec');
    const command = commandOf(evaluatePreToolUse('Bash', { command: 'npm test' }, context(specDir)));
    expect(command?.startsWith('unset ANTHROPIC_API_KEY')).toBe(true);
    // The command runs in a POSIX shell (Git Bash on Windows): the log path is written with forward slashes
    expect(command).toContain(join(specDir, 'logs').replace(/\\/g, '/'));
    expect(command).toContain('npm test');
  });

  it('leaves background commands and piped commands as they were (credential unset only)', () => {
    const specDir = join(scratch, 'spec');
    const bg = commandOf(evaluatePreToolUse('Bash', { command: 'npm test', run_in_background: true }, context(specDir)));
    expect(bg).toMatch(/^unset [A-Z_ ]+; npm test$/);
    const piped = commandOf(evaluatePreToolUse('Bash', { command: 'npm test | tail -5' }, context(specDir)));
    expect(piped).toMatch(/^unset [A-Z_ ]+; npm test \| tail -5$/);
  });

  it('still denies what the security hooks deny', () => {
    const out = evaluatePreToolUse('Bash', { command: 'git push --force' }, { ...context(scratch), agentType: 'qa_reviewer' });
    expect((out as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision).toBe('deny');
  });
});
