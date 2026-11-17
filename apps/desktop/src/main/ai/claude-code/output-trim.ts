/**
 * Long command output stays out of the agent's context.
 *
 * Every turn re-sends everything before it, so one test run that prints two
 * thousand "✓ passed" lines is paid for on every later turn of the session.
 * Commands that typically flood (test runners, builds, typechecks, installs,
 * linters) are rewritten in the PreToolUse hook so their whole output goes to
 * a log file in the task's spec directory (`<spec>/logs/tool-<time>-<n>.log`).
 * Short output is printed as it was; long output becomes a bounded summary:
 * the exit code, after a failing run the lines that look like failures with a
 * little context, the tail, and where the full log is. The command's exit code is kept.
 *
 * Done on the command side, not with a PostToolUse output rewrite, because a
 * command that exits non-zero (a failing test run, the longest output there
 * is) ends in PostToolUseFailure, whose output a hook cannot replace.
 *
 * Commands the agent already pipes, redirects, substitutes or backgrounds are
 * left as they are, and so are watchers and dev servers. Claude Code runs Bash
 * with Git Bash on Windows, so the wrapper is plain bash and paths are written
 * with forward slashes there.
 */

import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';

import { getPlatformKey } from '../../platform';

type PlatformKey = ReturnType<typeof getPlatformKey>;

/**
 * Output up to this size is printed whole. Agents used to pipe these commands through `tail`
 * (a few hundred characters back), so a shortened output stays close to that: the tail after a
 * passing run, the failures and the tail after a failing one.
 */
export const TRIM_THRESHOLD_BYTES = 3_000;
/** Budget for the failure lines (failing runs only) and for the tail of a shortened output */
const FAILURE_LINES = 60;
const FAILURE_BYTES = 4_000;
const TAIL_LINES = 15;
const TAIL_BYTES = 1_500;
const LINE_CHARS = 300;

/** Lines that look like a failure in the usual runners' output (grep -E, case-insensitive) */
const FAILURE_PATTERN = "fail|error|✗|✕|×|panic|traceback|exception|assert|expected|not ok";

/** Package managers: subcommands that flood, and options that take a value before the subcommand */
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const PM_SUBCOMMANDS = new Set(['test', 't', 'tst', 'install', 'i', 'ci', 'add']);
const PM_VALUE_OPTIONS = new Set(['-C', '--prefix', '--filter', '-F', '--workspace', '-w', '--dir', '--cwd']);
const SCRIPT_NAME = /^(test|tests|build|lint|typecheck|type-check|types|check|tsc|e2e|ci|verify|validate)([:._-].*)?$/i;

/** Tools that flood whatever they are asked */
const TOOLS_ANY = new Set([
  'vitest', 'jest', 'mocha', 'ava', 'tap', 'tsc', 'vue-tsc', 'svelte-check', 'eslint', 'biome', 'oxlint', 'stylelint',
  'webpack', 'rollup', 'turbo', 'nx', 'pytest', 'py.test', 'mypy', 'ruff', 'flake8', 'pylint', 'tox', 'nox', 'rspec',
  'rake', 'phpunit', 'pest', 'phpstan', 'mvn', 'mvnw', 'gradle', 'gradlew', 'make', 'ctest', 'xcodebuild', 'golangci-lint',
]);

/** Tools that flood only with these subcommands */
const TOOL_SUBCOMMANDS: Record<string, string[]> = {
  next: ['build', 'lint'],
  vite: ['build'],
  playwright: ['test'],
  cypress: ['run'],
  ng: ['test', 'build', 'lint'],
  rails: ['test'],
  composer: ['install', 'update', 'require'],
  cmake: ['--build'],
  go: ['test', 'build', 'vet'],
  cargo: ['test', 'build', 'check', 'clippy', 'nextest', 'install'],
  dotnet: ['test', 'build', 'restore'],
  swift: ['test', 'build'],
  deno: ['test', 'check', 'lint'],
  flutter: ['test', 'build', 'pub'],
  dart: ['test', 'analyze'],
  mix: ['test', 'compile', 'deps.get'],
  pip: ['install'],
  pip3: ['install'],
  uv: ['sync', 'pip'],
  poetry: ['install'],
  bundle: ['install'],
  artisan: ['test'],
};

/** Python modules run with `python -m` that flood */
const PYTHON_MODULES = new Set(['pytest', 'unittest', 'mypy', 'pip', 'tox', 'ruff', 'flake8', 'pylint']);

/** Launchers whose next word is the real command */
const LAUNCHERS: Record<string, string[]> = {
  npx: [], bunx: [], pnpx: [], env: [], time: [],
  pnpm: ['exec', 'dlx'], yarn: ['dlx', 'exec'], bun: ['x'],
  uv: ['run'], poetry: ['run'], bundle: ['exec'], php: [],
};

/** Words that mean the command keeps running or serves */
const LONG_RUNNING = new Set(['--watch', 'watch', '-w', '--ui', 'dev', 'serve', 'start', 'preview']);

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

const baseName = (token: string) => token.replace(/^.*[\\/]/, '').replace(/\.(cmd|exe|bat)$/i, '');

/** The command with quoted text blanked out, so operators inside quotes don't count. */
function withoutQuotes(command: string): string {
  return command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '""');
}

/** The words of a segment after env assignments and launchers (npx, pnpm exec, uv run, python -m …) */
function commandWords(segment: string): string[] {
  let words = segment.trim().split(/\s+/).filter(Boolean);
  for (let guard = 0; guard < 4 && words.length; guard++) {
    while (words.length && ENV_ASSIGNMENT.test(words[0])) words = words.slice(1);
    if (!words.length) break;
    const name = baseName(words[0]);
    const launcher = LAUNCHERS[name];
    if (/^python[0-9.]*$/.test(name) && words[1] === '-m') {
      return PYTHON_MODULES.has(words[2] ?? '') ? [words[2], ...words.slice(3)] : words;
    }
    if (!launcher) break;
    if (launcher.length === 0) {
      // npx -y vitest, php artisan test
      let rest = words.slice(1);
      while (rest.length && rest[0].startsWith('-')) rest = rest.slice(1);
      if (!rest.length) break;
      words = rest;
      continue;
    }
    if (launcher.includes(words[1] ?? '')) {
      words = words.slice(2);
      continue;
    }
    break;
  }
  return words;
}

function packageManagerFloods(words: string[]): boolean {
  const args = words.slice(1);
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) i += PM_VALUE_OPTIONS.has(args[i]) ? 2 : 1;
  const sub = args[i];
  if (sub === undefined) return baseName(words[0]) === 'yarn';
  if (PM_SUBCOMMANDS.has(sub)) return true;
  if (sub === 'run' || sub === 'run-script') return SCRIPT_NAME.test(args[i + 1] ?? '');
  return baseName(words[0]) !== 'npm' && SCRIPT_NAME.test(sub);
}

function segmentFloods(segment: string): boolean {
  const words = commandWords(segment);
  if (!words.length) return false;
  if (words.some((w) => LONG_RUNNING.has(w))) return false;
  const name = baseName(words[0]);
  if (PACKAGE_MANAGERS.has(name)) return packageManagerFloods(words);
  if (TOOLS_ANY.has(name)) return true;
  const subs = TOOL_SUBCOMMANDS[name];
  return !!subs && subs.includes(words[1] ?? '');
}

/**
 * Is this a command whose output should go to a log and come back shortened? Pure.
 * Only recognised flooding commands, never one the agent pipes, redirects,
 * substitutes, backgrounds or spreads over several lines.
 */
export function isFloodingCommand(command: string): boolean {
  if (!command.trim() || command.includes('\n')) return false;
  const bare = withoutQuotes(command);
  const operatorsOnly = bare.replace(/&&|\|\|/g, ' ; ');
  if (/[|<>`&]|\$\(/.test(operatorsOnly)) return false;
  return operatorsOnly.split(';').some(segmentFloods);
}

/** Where one command's full output goes: the spec's logs/ folder, else the temp directory. */
export function toolLogPath(specDir: string | undefined, n: number, now = Date.now()): string {
  const dir = specDir ? join(specDir, 'logs') : join(tmpdir(), 'vibe-teamlead-logs');
  return join(dir, `tool-${now}-${n}.log`);
}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * The command, run with its whole output in `logPath` and a bounded summary
 * printed when the output is long. Its exit code is kept, and so is a `cd`
 * (a brace group, not a subshell). Pure.
 */
export function trimmedCommand(command: string, logPath: string, platform: PlatformKey = getPlatformKey()): string {
  const path = platform === 'win32' ? win32.normalize(logPath).replace(/\\/g, '/') : logPath;
  const log = quote(path);
  const dir = quote(posix.dirname(path));
  const pattern = quote(FAILURE_PATTERN);
  const notice = `"[Output shortened: \${__vt_size} bytes, exit code \${__vt_status}. Full output: "${log}" (read it if you need more).]"`;
  return [
    `mkdir -p ${dir} 2>/dev/null; { ${command}`,
    `} > ${log} 2>&1; __vt_status=$?;`,
    `__vt_size=$(wc -c < ${log} 2>/dev/null | tr -d ' ');`,
    `if [ "\${__vt_size:-0}" -le ${TRIM_THRESHOLD_BYTES} ]; then cat ${log} 2>/dev/null;`,
    `else echo ${notice};`,
    `if [ "$__vt_status" -ne 0 ] && grep -q -i -E ${pattern} ${log}; then echo '--- Lines that look like failures (with context) ---';`,
    `grep -n -i -E -B 2 -A 3 ${pattern} ${log} | cut -c 1-${LINE_CHARS} | head -n ${FAILURE_LINES} | head -c ${FAILURE_BYTES}; echo; fi;`,
    `echo '--- Last ${TAIL_LINES} lines ---'; tail -n ${TAIL_LINES} ${log} | cut -c 1-${LINE_CHARS} | tail -c ${TAIL_BYTES};`,
    `fi; (exit $__vt_status)`,
  ].join('\n');
}
