import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import {
  buildFormatLintHook,
  formatLintLines,
  lintFeedback,
  parseBiomeGithub,
  parseEslintJson,
  parseGoVet,
  parseRuffJson,
  planTools,
  shouldLintEdit,
  type LintLine,
  type ToolLookup,
} from '../format-lint-hook';
import { buildQueryOptions } from '../runner';
import type { SessionConfig } from '../../session/types';

const signal = new AbortController().signal;

function lookup(existing: string[], onPath: Record<string, string> = {}): ToolLookup {
  const set = new Set(existing);
  return { exists: (p) => set.has(p), onPath: (name) => onPath[name] };
}

describe('planTools', () => {
  const project = '/p';

  it('runs prettier then eslint from the nearest node_modules of a monorepo package', () => {
    const api = '/p/apps/api/node_modules/.bin';
    const root = '/p/node_modules/.bin';
    const plan = planTools('/p/apps/api/src/users.ts', project, lookup([`${api}/eslint`, `${root}/eslint`, `${root}/prettier`]));
    expect(plan.map((t) => [t.name, t.cmd])).toEqual([
      ['prettier', `${root}/prettier`],
      ['eslint', `${api}/eslint`],
    ]);
    expect(plan[0].args).toEqual(['--write', '/p/apps/api/src/users.ts']);
    expect(plan[1].args).toEqual(['--no-warn-ignored', '--format', 'json', '/p/apps/api/src/users.ts']);
    expect(plan[1].cwd).toBe('/p/apps/api');
  });

  it('falls back to biome for formatting and linting when prettier and eslint are absent', () => {
    const plan = planTools('/p/src/a.tsx', project, lookup(['/p/node_modules/.bin/biome']));
    expect(plan.map((t) => t.name)).toEqual(['biome format', 'biome lint']);
    expect(plan[0].args).toEqual(['format', '--write', '/p/src/a.tsx']);
    expect(plan[1].args).toEqual(['lint', '--reporter=github', '/p/src/a.tsx']);
  });

  it('never uses a globally installed prettier or eslint', () => {
    expect(planTools('/p/src/a.js', project, lookup([], { prettier: '/usr/local/bin/prettier', eslint: '/usr/local/bin/eslint' }))).toEqual([]);
  });

  it('uses ruff from the project venv, or from PATH, for Python', () => {
    const venv = planTools('/p/svc/app.py', project, lookup(['/p/svc/.venv/bin/ruff'], { ruff: '/opt/homebrew/bin/ruff' }));
    expect(venv.map((t) => [t.name, t.cmd])).toEqual([
      ['ruff format', '/p/svc/.venv/bin/ruff'],
      ['ruff check', '/p/svc/.venv/bin/ruff'],
    ]);
    expect(venv[1].args).toEqual(['check', '--output-format', 'json', '/p/svc/app.py']);
    const path = planTools('/p/svc/app.py', project, lookup([], { ruff: '/opt/homebrew/bin/ruff' }));
    expect(path.map((t) => t.cmd)).toEqual(['/opt/homebrew/bin/ruff', '/opt/homebrew/bin/ruff']);
    expect(planTools('/p/svc/app.py', project, lookup([]))).toEqual([]);
  });

  it('uses gofmt and go vet on the package only when go is on PATH', () => {
    const plan = planTools('/p/cmd/x/main.go', project, lookup([], { go: '/usr/local/go/bin/go', gofmt: '/usr/local/go/bin/gofmt' }));
    expect(plan.map((t) => t.name)).toEqual(['gofmt', 'go vet']);
    expect(plan[1].args).toEqual(['vet', '.']);
    expect(plan[1].cwd).toBe('/p/cmd/x');
    expect(planTools('/p/cmd/x/main.go', project, lookup([]))).toEqual([]);
  });

  it('has nothing for other file types', () => {
    expect(planTools('/p/README.md', project, lookup(['/p/node_modules/.bin/eslint', '/p/node_modules/.bin/prettier']))).toEqual([]);
    expect(planTools('/p/notes.ipynb', project, lookup(['/p/.venv/bin/ruff']))).toEqual([]);
  });
});

describe('lint output parsing', () => {
  it('parses eslint JSON into lines with the rule and severity', () => {
    const json = JSON.stringify([
      {
        filePath: '/p/src/a.ts',
        messages: [
          { ruleId: 'no-unused-vars', severity: 1, message: "'x' is defined but never used.", line: 3, column: 7 },
          { ruleId: '@typescript-eslint/no-explicit-any', severity: 2, message: 'Unexpected any.', line: 10, column: 12 },
          { ruleId: null, severity: 2, message: 'Parsing error: Unexpected token', line: 1, column: 1, fatal: true },
        ],
      },
    ]);
    expect(parseEslintJson(json, '/p')).toEqual<LintLine[]>([
      { file: 'src/a.ts', line: 3, col: 7, rule: 'no-unused-vars', message: "'x' is defined but never used.", severity: 'warning' },
      { file: 'src/a.ts', line: 10, col: 12, rule: '@typescript-eslint/no-explicit-any', message: 'Unexpected any.', severity: 'error' },
      { file: 'src/a.ts', line: 1, col: 1, rule: 'parse', message: 'Parsing error: Unexpected token', severity: 'error' },
    ]);
    expect(parseEslintJson('not json', '/p')).toEqual([]);
  });

  it('parses biome GitHub-reporter lines', () => {
    const text = [
      '::error title=lint/style/noVar,file=/p/src/a.ts,line=4,endLine=4,col=1,endColumn=4::Use let or const instead of var.',
      '::warning title=lint/suspicious/noExplicitAny,file=/p/src/a.ts,line=9,endLine=9,col=5,endColumn=8::Unexpected any.',
      'some other output',
    ].join('\n');
    expect(parseBiomeGithub(text, '/p')).toEqual<LintLine[]>([
      { file: 'src/a.ts', line: 4, col: 1, rule: 'lint/style/noVar', message: 'Use let or const instead of var.', severity: 'error' },
      { file: 'src/a.ts', line: 9, col: 5, rule: 'lint/suspicious/noExplicitAny', message: 'Unexpected any.', severity: 'warning' },
    ]);
  });

  it('parses ruff JSON and go vet output', () => {
    const ruff = JSON.stringify([{ code: 'F401', message: '`os` imported but unused', filename: '/p/svc/app.py', location: { row: 2, column: 8 } }]);
    expect(parseRuffJson(ruff, '/p')).toEqual([{ file: 'svc/app.py', line: 2, col: 8, rule: 'F401', message: '`os` imported but unused', severity: 'error' }]);
    const vet = '# example.com/x/cmd\n./main.go:12:2: unreachable code\nvet: cannot find package\n';
    expect(parseGoVet(vet, '/p/cmd', '/p')).toEqual([{ file: 'cmd/main.go', line: 12, col: 2, rule: 'go vet', message: 'unreachable code', severity: 'error' }]);
  });

  it('formats errors before warnings and caps the list at 30 lines', () => {
    const lines: LintLine[] = [];
    for (let i = 1; i <= 25; i++) lines.push({ file: 'a.ts', line: i, col: 1, rule: 'w', message: 'warn', severity: 'warning' });
    for (let i = 1; i <= 10; i++) lines.push({ file: 'a.ts', line: i, col: 2, rule: 'e', message: 'err', severity: 'error' });
    const out = formatLintLines(lines);
    expect(out).toHaveLength(30);
    expect(out[0]).toBe('a.ts:1:2 e err');
    expect(out[9]).toBe('a.ts:10:2 e err');
    expect(out[10]).toBe('a.ts:1:1 w warn');
    expect(out[29]).toBe('…and 6 more');
  });
});

describe('lintFeedback', () => {
  it('says nothing when the file is clean and untouched', () => {
    expect(lintFeedback({ reformatted: [], lint: [], timedOut: [] })).toBeUndefined();
  });

  it('reports formatting, lint findings and timeouts compactly', () => {
    const text = lintFeedback({
      reformatted: ['prettier reformatted src/a.ts'],
      lint: [{ file: 'src/a.ts', line: 3, col: 7, rule: 'no-unused-vars', message: 'unused', severity: 'error' }],
      timedOut: ['eslint'],
    });
    expect(text).toBe(
      ['prettier reformatted src/a.ts (re-read it before editing further)', 'eslint timed out after 20 s; its result is unknown', 'Lint after your edit (fix before moving on):', 'src/a.ts:3:7 no-unused-vars unused'].join('\n'),
    );
  });
});

describe('shouldLintEdit', () => {
  const base = { hookEvent: 'PostToolUse', agentType: 'coder', cwd: '/w', projectDir: '/w' };

  it('lints files the coder and QA fixer write inside the worktree', () => {
    expect(shouldLintEdit({ ...base, toolName: 'Edit', filePath: 'src/a.ts' })).toBe('/w/src/a.ts');
    expect(shouldLintEdit({ ...base, toolName: 'Write', filePath: '/w/src/b.ts', agentType: 'qa_fixer' })).toBe('/w/src/b.ts');
    expect(shouldLintEdit({ ...base, toolName: 'NotebookEdit', filePath: undefined, notebookPath: '/w/n.ipynb' })).toBe('/w/n.ipynb');
  });

  it('leaves other agents, other tools and other events alone', () => {
    expect(shouldLintEdit({ ...base, toolName: 'Edit', filePath: 'src/a.ts', agentType: 'qa_reviewer' })).toBeUndefined();
    expect(shouldLintEdit({ ...base, toolName: 'Edit', filePath: 'src/a.ts', agentType: 'planner' })).toBeUndefined();
    expect(shouldLintEdit({ ...base, toolName: 'Bash', filePath: 'src/a.ts' })).toBeUndefined();
    expect(shouldLintEdit({ ...base, toolName: 'Edit', filePath: 'src/a.ts', hookEvent: 'PreToolUse' })).toBeUndefined();
    expect(shouldLintEdit({ ...base, toolName: 'Edit', filePath: undefined })).toBeUndefined();
  });

  it('skips files outside the worktree, under node_modules or the app folder', () => {
    expect(shouldLintEdit({ ...base, toolName: 'Edit', filePath: '/elsewhere/a.ts' })).toBeUndefined();
    expect(shouldLintEdit({ ...base, toolName: 'Edit', filePath: '../a.ts' })).toBeUndefined();
    expect(shouldLintEdit({ ...base, toolName: 'Edit', filePath: 'node_modules/x/index.js' })).toBeUndefined();
    expect(shouldLintEdit({ ...base, toolName: 'Edit', filePath: '.vibe-teamlead/specs/001/notes.ts' })).toBeUndefined();
  });
});

function fakeBin(dir: string, name: string, script: string): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
}

function post(tool_name: string, tool_input: unknown, cwd: string): HookInput {
  return { session_id: 's', transcript_path: '', cwd, hook_event_name: 'PostToolUse', tool_name, tool_input, tool_response: { ok: true }, tool_use_id: 't' } as HookInput;
}

describe('format-lint hook (integration)', () => {
  it('reformats with the project prettier, feeds eslint findings back, and is silent when clean', async () => {
    const project = mkdtempSync(join(tmpdir(), 'vtl-lint-'));
    const bin = join(project, 'node_modules', '.bin');
    mkdirSync(join(project, 'src'), { recursive: true });
    writeFileSync(join(project, 'src', 'a.ts'), 'const x = 1\n');
    // prettier adds a semicolon; eslint reports one error and one warning for a.ts, nothing for clean.ts
    fakeBin(bin, 'prettier', 'f="$2"; printf "const x = 1;\\n" > "$f"');
    fakeBin(
      bin,
      'eslint',
      'f="$4"; case "$f" in *clean.ts) echo "[]"; exit 0;; esac; ' +
        "printf '[{\"filePath\":\"%s\",\"messages\":[{\"ruleId\":\"no-unused-vars\",\"severity\":1,\"message\":\"unused\",\"line\":1,\"column\":7},{\"ruleId\":\"semi\",\"severity\":2,\"message\":\"Missing semicolon.\",\"line\":1,\"column\":12}]}]' \"$f\"; exit 1",
    );
    const hook = buildFormatLintHook({ agentType: 'coder', cwd: project, projectDir: project });
    expect(hook.matcher).toBe('Edit|Write|MultiEdit|NotebookEdit');

    const out = (await hook.hooks[0](post('Edit', { file_path: 'src/a.ts' }, project), 't', { signal })) as {
      hookSpecificOutput?: { hookEventName: string; additionalContext?: string };
    };
    expect(readFileSync(join(project, 'src', 'a.ts'), 'utf-8')).toBe('const x = 1;\n');
    expect(out.hookSpecificOutput?.hookEventName).toBe('PostToolUse');
    expect(out.hookSpecificOutput?.additionalContext).toBe(
      [
        'prettier reformatted src/a.ts (re-read it before editing further)',
        'Lint after your edit (fix before moving on):',
        'src/a.ts:1:12 semi Missing semicolon.',
        'src/a.ts:1:7 no-unused-vars unused',
      ].join('\n'),
    );

    writeFileSync(join(project, 'src', 'clean.ts'), 'const x = 1;\n');
    expect(await hook.hooks[0](post('Write', { file_path: join(project, 'src', 'clean.ts') }, project), 't', { signal })).toEqual({});
    // Other agents and files outside the worktree: nothing runs
    const reviewer = buildFormatLintHook({ agentType: 'qa_reviewer', cwd: project, projectDir: project });
    expect(await reviewer.hooks[0](post('Edit', { file_path: 'src/a.ts' }, project), 't', { signal })).toEqual({});
  });

  it('says so in one line when a tool times out', async () => {
    const project = mkdtempSync(join(tmpdir(), 'vtl-lint-'));
    mkdirSync(join(project, 'src'), { recursive: true });
    writeFileSync(join(project, 'src', 'a.ts'), 'const x = 1;\n');
    fakeBin(join(project, 'node_modules', '.bin'), 'eslint', 'exec sleep 5');
    const hook = buildFormatLintHook({ agentType: 'coder', cwd: project, projectDir: project, timeoutMs: 100 });
    const out = (await hook.hooks[0](post('Edit', { file_path: 'src/a.ts' }, project), 't', { signal })) as {
      hookSpecificOutput?: { additionalContext?: string };
    };
    expect(out.hookSpecificOutput?.additionalContext).toMatch(/^eslint timed out after 0\.1 s; its result is unknown$/);
  });
});

describe('format-lint hook in query options', () => {
  const config: SessionConfig = {
    agentType: 'coder',
    model: 'claude-sonnet-4-6',
    auth: { apiKey: 'sk-ant-test' },
    systemPrompt: 'You are the coder.',
    initialMessages: [{ role: 'user', content: 'go' }],
    toolContext: { cwd: '/work', projectDir: '/work', specDir: '/work/spec', securityProfile: undefined as never },
    maxSteps: 10,
    specDir: '/work/spec',
    projectDir: '/work',
    bundled: {},
  };
  const editMatchers = (options: ReturnType<typeof buildQueryOptions>) => (options.hooks?.PostToolUse ?? []).filter((m) => m.matcher === 'Edit|Write|MultiEdit|NotebookEdit');

  it('is on by default for the coder and the QA fixer, next to the background-task hooks', () => {
    const coder = buildQueryOptions(config, new AbortController());
    expect(editMatchers(coder)).toHaveLength(1);
    expect((coder.hooks?.PostToolUse ?? []).some((m) => m.matcher === 'Bash|TaskStop')).toBe(true);
    expect(editMatchers(buildQueryOptions({ ...config, agentType: 'qa_fixer' }, new AbortController()))).toHaveLength(1);
  });

  it('is left out for other agents and when the setting is off', () => {
    expect(editMatchers(buildQueryOptions({ ...config, agentType: 'qa_reviewer' }, new AbortController()))).toHaveLength(0);
    expect(editMatchers(buildQueryOptions({ ...config, agentType: 'planner' }, new AbortController()))).toHaveLength(0);
    expect(editMatchers(buildQueryOptions({ ...config, formatOnEdit: false }, new AbortController()))).toHaveLength(0);
  });
});
