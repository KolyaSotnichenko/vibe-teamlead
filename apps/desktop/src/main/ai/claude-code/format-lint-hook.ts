/**
 * After every Edit/Write of the coder and the QA fixer, the file is formatted
 * and linted with the project's own toolchain and the result goes straight
 * back to the agent as hook context: lint errors arrive as a compact list the
 * moment they are made, instead of a whole typecheck/lint run (or a QA round)
 * later. Nothing is said when the file is clean; no tool is ever installed
 * or taken from a global install, only the project's node_modules, venv or
 * PATH (go, ruff).
 *
 * Trust: these are the project's own tools, agent-writable like everything
 * else in the worktree, so they run at the same trust level as the agent's
 * Bash, and with a minimal environment: PATH, HOME, TMPDIR and the locale,
 * never the app process's credentials, tokens or NODE_OPTIONS (host-env.ts).
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';

import type { HookCallbackMatcher, HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';

import { findOnPath, type RunOptions, type RunResult, runProcess, searchPath } from '../../platform/exec';
import { isPathContained } from '../security/path-containment';
import { pickHostEnv, TOOL_HOST_ENV } from './host-env';

/** Agents that write project code and get lint feedback after each edit. */
export const FORMAT_LINT_AGENTS = new Set(['coder', 'qa_fixer']);

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** Hard limit per tool run. */
export const TOOL_TIMEOUT_MS = 20_000;

const MAX_LINES = 30;

export interface LintLine {
  file: string;
  line: number;
  col: number;
  rule: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface ToolPlan {
  name: 'prettier' | 'biome format' | 'eslint' | 'biome lint' | 'ruff format' | 'ruff check' | 'gofmt' | 'go vet';
  /** Changes the file in place */
  formats: boolean;
  cmd: string;
  args: string[];
  cwd: string;
  /** Extra variables for this tool, on top of the minimal environment */
  env?: Record<string, string>;
  /** Lint tools: findings from the process output */
  parse?: (result: RunResult, cwd: string, projectDir: string) => LintLine[];
}

/** How the planner finds executables; replaced in tests. */
export interface ToolLookup {
  exists(path: string): boolean;
  onPath(name: string): string | undefined;
}

const JS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);

const toPosix = (p: string) => p.replace(/\\/g, '/');

/** Directories from the file's own up to (and including) the project root. */
function ancestors(file: string, projectDir: string): string[] {
  const dirs: string[] = [];
  let dir = dirname(file);
  const root = resolve(projectDir);
  for (;;) {
    dirs.push(dir);
    if (dir === root || dirname(dir) === dir) break;
    dir = dirname(dir);
  }
  return dirs;
}

/** The nearest `<dir>/<sub>/<name>` above the file inside the project. */
function nearest(file: string, projectDir: string, lookup: ToolLookup, sub: string, name: string): { bin: string; dir: string } | undefined {
  for (const dir of ancestors(file, projectDir)) {
    const bin = join(dir, sub, name);
    if (lookup.exists(bin)) return { bin, dir };
  }
  return undefined;
}

const relFile = (file: string, projectDir: string): string => {
  const rel = relative(projectDir, file);
  return rel && !rel.startsWith('..') ? toPosix(rel) : toPosix(file);
};

/** Which tools run for this file, in order, with the project's own binaries. Pure given `lookup`. */
export function planTools(file: string, projectDir: string, lookup: ToolLookup): ToolPlan[] {
  const ext = extname(file).toLowerCase();
  const plan: ToolPlan[] = [];
  if (JS_EXTENSIONS.has(ext)) {
    const prettier = nearest(file, projectDir, lookup, join('node_modules', '.bin'), 'prettier');
    const eslint = nearest(file, projectDir, lookup, join('node_modules', '.bin'), 'eslint');
    const biome = nearest(file, projectDir, lookup, join('node_modules', '.bin'), 'biome');
    if (prettier) plan.push({ name: 'prettier', formats: true, cmd: prettier.bin, args: ['--write', file], cwd: prettier.dir });
    else if (biome) plan.push({ name: 'biome format', formats: true, cmd: biome.bin, args: ['format', '--write', file], cwd: biome.dir });
    if (eslint) {
      plan.push({
        name: 'eslint',
        formats: false,
        cmd: eslint.bin,
        args: ['--no-warn-ignored', '--format', 'json', file],
        cwd: eslint.dir,
        // 0 clean, 1 findings; 2 is a configuration problem the agent should not be sent chasing
        parse: (r, _cwd, root) => (r.code === 0 || r.code === 1 ? parseEslintJson(r.stdout, root) : []),
      });
    } else if (biome) {
      plan.push({
        name: 'biome lint',
        formats: false,
        cmd: biome.bin,
        args: ['lint', '--reporter=github', file],
        cwd: biome.dir,
        parse: (r, _cwd, root) => parseBiomeGithub(`${r.stdout}\n${r.stderr}`, root),
      });
    }
  } else if (ext === '.py') {
    const venv = nearest(file, projectDir, lookup, join('.venv', 'bin'), 'ruff');
    const ruff = venv?.bin ?? lookup.onPath('ruff');
    if (ruff) {
      const cwd = venv?.dir ?? projectDir;
      plan.push({ name: 'ruff format', formats: true, cmd: ruff, args: ['format', file], cwd });
      plan.push({
        name: 'ruff check',
        formats: false,
        cmd: ruff,
        args: ['check', '--output-format', 'json', file],
        cwd,
        parse: (r, _cwd, root) => parseRuffJson(r.stdout, root),
      });
    }
  } else if (ext === '.go') {
    const go = lookup.onPath('go');
    const gofmt = lookup.onPath('gofmt') ?? (go ? join(dirname(go), 'gofmt') : undefined);
    if (go && gofmt) {
      const pkg = dirname(file);
      // GOTOOLCHAIN=local: never download another toolchain; GOFLAGS stays unset
      const env = { GOTOOLCHAIN: 'local' };
      plan.push({ name: 'gofmt', formats: true, cmd: gofmt, args: ['-w', file], cwd: pkg, env });
      plan.push({ name: 'go vet', formats: false, cmd: go, args: ['vet', '.'], cwd: pkg, env, parse: (r, cwd, root) => parseGoVet(r.stderr || r.stdout, cwd, root) });
    }
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Output parsers (pure)
// ---------------------------------------------------------------------------

interface EslintMessage {
  ruleId?: string | null;
  severity?: number;
  message?: string;
  line?: number;
  column?: number;
  fatal?: boolean;
}

export function parseEslintJson(json: string, projectDir: string): LintLine[] {
  let results: { filePath?: string; messages?: EslintMessage[] }[];
  try {
    const parsed = JSON.parse(json || '[]');
    results = Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
  const lines: LintLine[] = [];
  for (const result of results) {
    const file = relFile(result.filePath ?? '', projectDir);
    for (const m of result.messages ?? []) {
      lines.push({
        file,
        line: m.line ?? 0,
        col: m.column ?? 0,
        rule: m.ruleId || (m.fatal ? 'parse' : 'eslint'),
        message: (m.message ?? '').trim(),
        severity: m.severity === 2 ? 'error' : 'warning',
      });
    }
  }
  return lines;
}

const GITHUB_LINE = /^::(error|warning)\s+(.*?)::(.*)$/;

/** Biome's `--reporter=github` lines: `::error title=<rule>,file=<path>,line=N,endLine=N,col=N,endColumn=N::<message>`. */
export function parseBiomeGithub(text: string, projectDir: string): LintLine[] {
  const lines: LintLine[] = [];
  for (const raw of text.split('\n')) {
    const m = GITHUB_LINE.exec(raw.trim());
    if (!m) continue;
    const props: Record<string, string> = {};
    for (const pair of m[2].split(',')) {
      const eq = pair.indexOf('=');
      if (eq > 0) props[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
    lines.push({
      file: relFile(props.file ?? '', projectDir),
      line: Number(props.line) || 0,
      col: Number(props.col) || 0,
      rule: props.title ?? 'biome',
      message: m[3].trim(),
      severity: m[1] === 'error' ? 'error' : 'warning',
    });
  }
  return lines;
}

export function parseRuffJson(json: string, projectDir: string): LintLine[] {
  let items: { code?: string | null; message?: string; filename?: string; location?: { row?: number; column?: number } }[];
  try {
    const parsed = JSON.parse(json || '[]');
    items = Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
  return items.map((i) => ({
    file: relFile(i.filename ?? '', projectDir),
    line: i.location?.row ?? 0,
    col: i.location?.column ?? 0,
    rule: i.code || 'ruff',
    message: (i.message ?? '').trim(),
    severity: 'error' as const,
  }));
}

const VET_LINE = /^(\S+?\.go):(\d+):(\d+):\s*(.+)$/;

/** `go vet` prints `./file.go:line:col: message` relative to the package directory. */
export function parseGoVet(text: string, pkgDir: string, projectDir: string): LintLine[] {
  const lines: LintLine[] = [];
  for (const raw of text.split('\n')) {
    const m = VET_LINE.exec(raw.trim());
    if (!m) continue;
    lines.push({ file: relFile(resolve(pkgDir, m[1]), projectDir), line: Number(m[2]), col: Number(m[3]), rule: 'go vet', message: m[4].trim(), severity: 'error' });
  }
  return lines;
}

/** "file:line:col rule message", errors first, at most MAX_LINES lines. Pure. */
export function formatLintLines(lines: LintLine[], max = MAX_LINES): string[] {
  const ordered = [...lines.filter((l) => l.severity === 'error'), ...lines.filter((l) => l.severity !== 'error')];
  const out = ordered.map((l) => `${l.file}:${l.line}:${l.col} ${l.rule} ${l.message}`);
  if (out.length <= max) return out;
  return [...out.slice(0, max - 1), `…and ${out.length - (max - 1)} more`];
}

export interface LintOutcome {
  /** One line per formatter that changed the file */
  reformatted: string[];
  lint: LintLine[];
  /** Names of tools that hit the time limit */
  timedOut: string[];
  timeoutMs?: number;
}

/** The hook's message to the agent, or undefined when there is nothing to say. Pure. */
export function lintFeedback(outcome: LintOutcome): string | undefined {
  const seconds = (outcome.timeoutMs ?? TOOL_TIMEOUT_MS) / 1000;
  const lines = [
    ...outcome.reformatted.map((l) => `${l} (re-read it before editing further)`),
    ...outcome.timedOut.map((name) => `${name} timed out after ${seconds} s; its result is unknown`),
  ];
  if (outcome.lint.length) lines.push('Lint after your edit (fix before moving on):', ...formatLintLines(outcome.lint));
  return lines.length ? lines.join('\n') : undefined;
}

// ---------------------------------------------------------------------------
// Hook decision (pure)
// ---------------------------------------------------------------------------

export interface EditDecisionInput {
  toolName: string;
  hookEvent: string;
  agentType: string;
  filePath: string | undefined;
  notebookPath?: string;
  cwd: string;
  projectDir: string;
}

const SKIPPED_DIRS = /(^|\/)(node_modules|\.vibe-teamlead)\//;

/** The absolute path to format and lint after this tool call, or undefined to do nothing. */
export function shouldLintEdit(input: EditDecisionInput): string | undefined {
  if (input.hookEvent !== 'PostToolUse' || !WRITE_TOOLS.has(input.toolName) || !FORMAT_LINT_AGENTS.has(input.agentType)) return undefined;
  const raw = input.filePath ?? input.notebookPath;
  if (!raw) return undefined;
  const target = isAbsolute(raw) ? resolve(raw) : resolve(input.cwd, raw);
  const contained = isPathContained(target, input.cwd);
  if (!contained.contained) return undefined;
  const rel = toPosix(relative(input.cwd, target));
  if (rel.startsWith('..') || SKIPPED_DIRS.test(rel)) return undefined;
  return target;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface FormatLintHookOptions {
  agentType: string;
  /** The session's working directory (the task's worktree): only files inside it are touched */
  cwd: string;
  projectDir: string;
  timeoutMs?: number;
  run?: (cmd: string, args: string[], options: RunOptions) => Promise<RunResult>;
  lookup?: ToolLookup;
}

const fsLookup: ToolLookup = { exists: (p) => existsSync(p), onPath: (name) => findOnPath(name) };

function realDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

function contentOf(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf-8');
  } catch {
    return undefined;
  }
}

/** Run the planned tools on one file; never throws. */
export async function formatAndLint(file: string, projectDir: string, options: Pick<FormatLintHookOptions, 'timeoutMs' | 'run' | 'lookup'> = {}): Promise<LintOutcome> {
  const timeoutMs = options.timeoutMs ?? TOOL_TIMEOUT_MS;
  const run = options.run ?? runProcess;
  const outcome: LintOutcome = { reformatted: [], lint: [], timedOut: [], timeoutMs };
  // The project's tools get a minimal environment, never the app's own (see the module header)
  const baseEnv = { ...pickHostEnv(TOOL_HOST_ENV), PATH: searchPath() };
  const shown = relFile(file, projectDir);
  for (const tool of planTools(file, projectDir, options.lookup ?? fsLookup)) {
    const before = tool.formats ? contentOf(file) : undefined;
    const result = await run(tool.cmd, tool.args, { cwd: tool.cwd, env: { ...baseEnv, ...tool.env }, timeoutMs, maxOutput: 1024 * 1024 });
    if (result.timedOut) {
      outcome.timedOut.push(tool.name);
      continue;
    }
    if (result.error) continue;
    if (tool.formats) {
      if (before !== undefined && contentOf(file) !== before) outcome.reformatted.push(`${tool.name} reformatted ${shown}`);
    } else if (tool.parse) {
      outcome.lint.push(...tool.parse(result, tool.cwd, projectDir));
    }
  }
  return outcome;
}

/** PostToolUse hook on the editing tools: format, lint, and feed the result back as context. */
export function buildFormatLintHook(options: FormatLintHookOptions): HookCallbackMatcher {
  const cwd = realDir(options.cwd);
  return {
    matcher: 'Edit|Write|MultiEdit|NotebookEdit',
    hooks: [
      async (input: HookInput): Promise<HookJSONOutput> => {
        const toolInput = (input as { tool_input?: unknown }).tool_input;
        const fields = toolInput && typeof toolInput === 'object' ? (toolInput as { file_path?: unknown; notebook_path?: unknown }) : {};
        const file = shouldLintEdit({
          toolName: (input as { tool_name?: string }).tool_name ?? '',
          hookEvent: input.hook_event_name,
          agentType: options.agentType,
          filePath: typeof fields.file_path === 'string' ? fields.file_path : undefined,
          notebookPath: typeof fields.notebook_path === 'string' ? fields.notebook_path : undefined,
          cwd,
          projectDir: options.projectDir,
        });
        if (!file) return {};
        const outcome = await formatAndLint(file, cwd, options);
        const additionalContext = lintFeedback(outcome);
        return additionalContext ? { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext } } : {};
      },
    ],
  };
}
